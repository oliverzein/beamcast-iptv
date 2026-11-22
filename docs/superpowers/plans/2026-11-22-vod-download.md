# VOD Download & Mobile Transcoding Pipeline Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an Xtream VOD download and 2-stage FFmpeg mobile transcoding pipeline (Movies + Series single/season/multi-select) with VAAPI/CPU acceleration, configurable storage, and live queue/status UI.

**Architecture:** Main-process orchestration separates sequential HTTP/HTTPS downloading (`lib/downloader.js`, handling Xtream HTTP 206 & redirects) from local FFmpeg transcoding (`lib/transcoder.js`, VAAPI with CPU fallback, German audio preference, no subtitles) under a concurrency- and backpressure-capped coordinator (`lib/download-manager.js`). Renderer UI (`renderer-downloads.js`, `renderer-settings.js`, plus hooks in `renderer.js` and `renderer-xtream.js`) communicates via sanitized IPC exposed in `preload.js` and persists preferences in IndexedDB via `lib/settings.js`.

**Tech Stack:** Electron 31, Node.js built-ins (`http`, `https`, `fs`, `path`, `child_process`), native `ffmpeg`/`ffprobe`, `node --test`, `fake-indexeddb`, vanilla DOM + CSS.

**Spec:** [2026-11-22-vod-download-design.md](file:///home/oliverzein/Dokumente/Daten/Development/Electron/BeamcastIPTV/docs/superpowers/specs/2026-11-22-vod-download-design.md)

---

## Global Constraints

- **Zero new npm dependencies:** Use Node.js built-ins, existing `electron`/`ffmpeg`/`ffprobe`, and existing test tools (`node --test`, `fake-indexeddb`) only.
- **No credential leaks:** Plaintext Xtream `username`/`password` in URLs must never appear in UI labels, notifications, dialogs, filenames, IPC snapshots, or unredacted logs (`redactUrl()`).
- **Concurrency & backpressure:** Max `1` active HTTP download, max `1` active local transcode, max `1` job waiting in `queued_transcode` before pausing Stage 1.
- **Presets:** `hevc` (`hevc_vaapi` `-rc_mode CQP -qp 24 -tag:v hvc1` / CPU `libx265` `-crf 24`), `h264` (`h264_vaapi` `-rc_mode CQP -qp 22` / CPU `libx264` `-crf 22`), `remux` (`-c:v copy`, automatic H.264 fallback if video codec is not in `['h264','hevc','h265','mpeg4','av1']`), `original` (1:1 container copy).
- **Audio & subtitles (for `hevc`/`h264`/`remux`):** Prefer German audio (`ger`/`deu`/`de` or title `/\b(german|deutsch|ger|deu)\b/i`), fallback to first audio stream; encode `-c:a aac -b:a 160k -ac 2`; drop subtitles (`-sn`) and data (`-dn`); `-movflags +faststart -f mp4`.
- **Never upscale video:** Apply `scale=-2:<targetHeight>` (`1080` or `720`) only when `probe.height > targetHeight`.
- **Code health & regression:** Keep functions concise and modular for `fallow dead-code` and `fallow health --file-scores`. All 34 existing tests must continue to pass; never stage pre-existing uncommitted work (`db.js`, `renderer-epg.js`, `.gitignore`).

## Review Focus

1. **Unknown-length streams in `lib/downloader.js`:** Xtream servers returning `HTTP 206` with `Content-Range: bytes 0-999/*` or `HTTP 200` without `Content-Length` must finish cleanly on EOF without an infinite loop or `NaN` progress/ETA — pinned by tests in **Task 2**.
2. **Video-only sources & tricky VOD filenames:** Media with 0 audio streams must omit audio mapping/encoding flags (`transcoder.js`), and titles with umlauts, illegal characters, `..`, or duplicate series prefixes must sanitize without path traversal or redundant suffixes (`download-manager.js`) — pinned by tests in **Task 3** and **Task 4**.
3. **Intra-batch path collisions & duplicate in-flight items:** Enqueuing two active jobs for the same `itemKey` must deduplicate, and colliding target paths within a single batch (e.g., two episodes sanitizing to the same path) must surface in `checkConflicts()` — pinned by tests in **Task 4**.
4. **Runtime VAAPI failure & Stage-2 `.raw.part` retention:** Under `hwAccel === 'auto'`, a runtime VAAPI failure retries once on CPU (`libx265`/`libx264`); if Stage 2 fails anyway (e.g., `< 500 MB` disk space), `.raw.part` stays on disk for transcode-only `retryJob()` and is unlinked on job removal, cancel, or shutdown — pinned by tests in **Task 3** and **Task 4**.
5. **Instant 1-click download collision check:** Even when `downloadClickAction === 'instant'` or context-menu `"Herunterladen (Standard)"` skips the Preset dialog, `renderer-downloads.js` must still run `checkDownloadConflicts()` and prompt when `downloadDuplicateAction === 'ask'` — pinned by a unit/logic test in **Task 7**.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `lib/settings.js` (modify) | Support `int`, `enum`, and `string` (with optional regex `pattern`); add 7 download settings keys |
| `test/settings.test.js` (modify) | Tests for `enum`/`string`/`pattern` validation and all 7 new download keys |
| `lib/downloader.js` (create) | Streaming HTTP/HTTPS downloader (`200`, single/chunked `206`, cross-protocol redirects, `Range` retries, `AbortSignal`, `redactUrl`) |
| `test/downloader.test.js` (create) | Local mock HTTP server tests for all HTTP 200/206/redirect/retry/cancel/redaction cases |
| `lib/transcoder.js` (create) | `ffprobe` inspection, German audio selector, VAAPI device/encoder probing, FFmpeg arg builder, progress parser, runtime CPU fallback |
| `test/transcoder.test.js` (create) | Unit tests for audio selection, arg building, progress parsing, and mocked runtime VAAPI->CPU fallback |
| `lib/download-manager.js` (create) | Path sanitization, duplicate & intra-batch conflict resolution, 2-stage pipeline queue with backpressure cap, disk check, `.part` cleanup, Electron IPC wiring |
| `test/download-manager.test.js` (create) | Unit/orchestrator tests with stubbed downloader/transcoder covering paths, conflicts, concurrency, Stage-2 retry retention, and credential-free snapshots |
| `lib/external-player.js` (modify) | Conditional VOD download items in context menu + standalone `openLocalFileInMpv(filePath)` |
| `preload.js` (modify) | Expose 13 download `invoke` channels, 2 IPC listeners, and 3rd `meta` arg on `showContextMenu` |
| `main.js` (modify) | Initialize `downloadManager`, wire `download:open-in-mpv`, add `mainWindow.on('close')` confirmation & `shutdown()` |
| `package.json` (modify) | Include `renderer-downloads.js` and `renderer-settings.js` in `build.files` |
| `renderer-settings.js` (modify) | Render/validate/save download controls, browse folder button, dynamic VAAPI device dropdown |
| `renderer-downloads.js` (create) | UI controller for Options modal, Conflict modal, Download-Manager modal, Top-Bar badge, floating Status Bar, and instant-click pre-flight helper |
| `test/download-ui.test.js` (create) | Pure Node test verifying `triggerDownload()` instant/dialog conflict-check routing and snapshot helpers |
| `renderer.js` (modify) | Init `DownloadUI`, add Movie sidebar `⬇` button & context menu metadata, extend modal Escape/backdrop dismissal |
| `renderer-xtream.js` (modify) | Series `"⬇ Ganze Staffel laden"`, interactive `"☑ Auswählen"` Multi-Select mode, per-card `⬇` button, context menu metadata, live status badges |
| `index.html` (modify) | Add Settings download section, Series batch toolbar, Top-Bar Downloads button, floating Status Bar, Download modals, `<script src="renderer-downloads.js">` |
| `style.css` (modify) | Styles for Settings download grid, Download modals, Top-Bar pill, stacked floating Status Bar, Series Multi-Select bar, inline `⬇` buttons & badges |

---

### Task 1: Extend `lib/settings.js` Schema for Download Settings

**Files:**
- Modify: `lib/settings.js:10-26`
- Modify: `test/settings.test.js:204-210`

**Interfaces:**
- Produces:
  - `SCHEMA` in `lib/settings.js` with new keys: `downloadDir` (`string`, `''`), `downloadFolderStructure` (`enum`, `['structured', 'flat']`, `'structured'`), `downloadDefaultPreset` (`enum`, `['hevc', 'h264', 'remux', 'original']`, `'hevc'`), `downloadDefaultResolution` (`enum`, `['original', '1080p', '720p']`, `'1080p'`), `downloadClickAction` (`enum`, `['dialog', 'instant']`, `'dialog'`), `downloadDuplicateAction` (`enum`, `['ask', 'skip', 'rename', 'overwrite']`, `'ask'`), `downloadHwAccel` (`string`, `/^(auto|cpu|\/dev\/dri\/renderD\d+)$/`, `'auto'`).
  - `AppSettings.get(key, defaultValue)` and `AppSettings.set(key, value)` supporting `'int' | 'enum' | 'string'`.

- [ ] **Step 1: Write failing tests in `test/settings.test.js`**

Append tests asserting defaults and `set()` validation for the 7 new keys:
```js
test('AppSettings: download schema defaults and enum/string validation', async () => {
  await resetDb();
  await IPTVDb.open();
  delete require.cache[require.resolve('../lib/settings.js')];
  const { AppSettings, SCHEMA } = require('../lib/settings.js');
  AppSettings._cache = null;
  AppSettings._loadPromise = null;
  await AppSettings.load();

  assert.strictEqual(SCHEMA.downloadDir.default, '');
  assert.strictEqual(AppSettings.get('downloadFolderStructure'), 'structured');
  assert.strictEqual(AppSettings.get('downloadDefaultPreset'), 'hevc');
  assert.strictEqual(AppSettings.get('downloadDefaultResolution'), '1080p');
  assert.strictEqual(AppSettings.get('downloadClickAction'), 'dialog');
  assert.strictEqual(AppSettings.get('downloadDuplicateAction'), 'ask');
  assert.strictEqual(AppSettings.get('downloadHwAccel'), 'auto');

  await AppSettings.set('downloadDir', '/tmp/vod');
  assert.strictEqual(AppSettings.get('downloadDir'), '/tmp/vod');
  await AppSettings.set('downloadDefaultPreset', 'h264');
  assert.strictEqual(AppSettings.get('downloadDefaultPreset'), 'h264');
  await AppSettings.set('downloadHwAccel', '/dev/dri/renderD128');
  assert.strictEqual(AppSettings.get('downloadHwAccel'), '/dev/dri/renderD128');

  await assert.rejects(() => AppSettings.set('downloadDefaultPreset', 'avi'), RangeError);
  await assert.rejects(() => AppSettings.set('downloadDir', 123), TypeError);
  await assert.rejects(() => AppSettings.set('downloadHwAccel', '/dev/null'), RangeError);

  await resetDb();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/settings.test.js`
Expected: FAIL because `SCHEMA.downloadDir` is undefined / unknown setting key.

- [ ] **Step 3: Extend `SCHEMA` and `validate(key, value)` in `lib/settings.js`**

Add the 7 keys to `SCHEMA` and branch `validate(key, value)` by `entry.type`:
- `'int'`: preserve existing integer check (`TypeError` with `integer`) and min/max check (`RangeError` with `out of range`).
- `'enum'`: require `typeof value === 'string'` (`TypeError`), check `entry.values.includes(value)` (`RangeError`).
- `'string'`: require `typeof value === 'string'` (`TypeError`), check `entry.pattern.test(value)` when `entry.pattern` is defined (`RangeError`).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/settings.test.js`
Expected: All tests in `test/settings.test.js` PASS (0 failures).

- [ ] **Step 5: Commit**

```bash
git add lib/settings.js test/settings.test.js
git commit -m "feat(settings): add download and transcoding schema keys"
```

---

### Task 2: Streaming HTTP/HTTPS Downloader (`lib/downloader.js`)

**Files:**
- Create: `lib/downloader.js`
- Create: `test/downloader.test.js`

**Interfaces:**
- Produces in `lib/downloader.js`:
  - `redactUrl(rawUrl: string) -> string`
  - `parseContentRange(header: string) -> { start: number, end: number | null, total: number | null } | null`
  - `downloadFile({ url, partPath, signal, onProgress, userAgent = 'BeamcastIPTV/1.3.1', maxRedirects = 10, maxRetries = 3, requestTimeoutMs = 30000 }) -> Promise<{ bytesWritten: number, totalBytes: number }>`
    - `onProgress` receives `{ bytesWritten, totalBytes, speedBps, etaSec }` (`totalBytes` is `0` when unknown; `etaSec` is `null` when unknown/zero speed, never `NaN`).
    - Rejects non-redirect HTTP `>= 400` with `err.statusCode`; `err.nonRetryable = true` for `[401, 403, 404, 410]`; uses `redactUrl()` in any error message or log.
    - Aborting `signal` throws `err` with `err.name === 'AbortError'`.

- [ ] **Step 1: Write failing tests in `test/downloader.test.js`**

Create `test/downloader.test.js` using Node's `http` module on ephemeral ports (`127.0.0.1:0`) and `os.tmpdir()` covering:
1. `redactUrl()` masks `user:pass@`, `/movie/user/pass/123.mkv`, `/series/user/pass/45.mp4`, `/live/user/pass/9.ts`, and `?username=x&password=y`.
2. `downloadFile()` handles `HTTP 200 OK` with `Content-Length`, writing exact bytes to `partPath` and reporting valid `onProgress`.
3. `downloadFile()` handles `HTTP 200 OK` **without** `Content-Length` (Review Focus #1): finishes cleanly on EOF with `totalBytes: 0`, `etaSec: null`, no `NaN`.
4. `downloadFile()` handles single `HTTP 206 Partial Content` on initial GET without `Range` header (`Content-Range: bytes 0-1023/1024`).
5. `downloadFile()` handles `HTTP 206` with unknown total `Content-Range: bytes 0-511/*` (Review Focus #1): finishes cleanly after the response ends without looping indefinitely.
6. `downloadFile()` handles chunked `HTTP 206` continuation loop (server sends chunks of 256 bytes from total 1024 bytes; verifies subsequent requests include `Range: bytes=<offset>-`).
7. `downloadFile()` follows `302` and `307` redirects across mock servers while preserving `User-Agent` and `Range`.
8. `downloadFile()` recovers from a mid-stream `socket.destroy()` via `Range` retry when `Accept-Ranges: bytes` or prior `206` was observed (test retry backoff configured fast via optional `retryBaseDelayMs = 10`).
9. `downloadFile()` rejects `404` without retrying and without exposing credentials from `/movie/secretUser/secretPass/99.mkv` in `err.message`.
10. `downloadFile()` aborts immediately on `AbortController.abort()` with `err.name === 'AbortError'`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/downloader.test.js`
Expected: FAIL (`Cannot find module '../lib/downloader.js'`).

- [ ] **Step 3: Implement `lib/downloader.js`**

Keep helpers small and single-purpose:
- `redactUrl(rawUrl)`: uses `new URL(rawUrl)`; masks `parsed.username`/`parsed.password`, Xtream path segments `^/(live|movie|series)/([^/]+)/([^/]+)(/.*)?$` -> `/$1/***/***$4`, and sensitive query params (`username`, `password`, `token`). Falls back to regex masking on unparseable strings.
- `parseContentRange(header)`: parses `bytes (\d+)-(\d+|\*)/(\d+|\*)`.
- `requestOnce(...)`: selects `http` or `https` based on protocol, handles `301`/`302`/`303`/`307`/`308` up to `maxRedirects` (resolving relative `Location` via `new URL(loc, currentUrl)`), enforces `requestTimeoutMs` inactivity timer, streams chunks through `fs.createWriteStream(partPath, { flags: startOffset > 0 ? 'a' : 'w' })` with proper backpressure (`stream.write` -> `'drain'`).
- `downloadFile(...)`: runs the chunked-206 continuation loop (`totalBytes > 0 && bytesWritten < totalBytes`) and transient retry loop (`maxRetries = 3`, backoff `retryBaseDelayMs * 2 ** attempt`, default `1000ms`), resetting `bytesWritten = 0` if the server did not advertise `206` or `Accept-Ranges: bytes`.
- Export `{ redactUrl, parseContentRange, downloadFile }`.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/downloader.test.js`
Expected: All 10 tests in `test/downloader.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/downloader.js test/downloader.test.js
git commit -m "feat(download): add streaming HTTP/HTTPS downloader with 206 and retry support"
```

---

### Task 3: FFprobe & FFmpeg VAAPI/CPU Transcoder (`lib/transcoder.js`)

**Files:**
- Create: `lib/transcoder.js`
- Create: `test/transcoder.test.js`

**Interfaces:**
- Produces in `lib/transcoder.js`:
  - `probeMedia(filePath: string) -> Promise<{ durationSec: number, width: number, height: number, videoCodec: string, audioStreams: Array<{ index: number, codec: string, channels: number, language: string, title: string }> }>`
  - `selectAudioStream(audioStreams) -> number | null`
  - `listVaapiDevices() -> Promise<Array<{ path: string, label: string }>>`
  - `probeVaapiEncoder(devicePath: string, encoderName: string) -> Promise<boolean>`
  - `clearProbeCache() -> void`
  - `resolveEncoderConfig({ preset, hwAccel = 'auto', _probeFn, _listDevicesFn }) -> Promise<{ mode: 'vaapi'|'cpu'|'remux'|'original', videoEncoder: string | null, hwDevice: string | null }>`
  - `buildTranscodeArgs({ inputPath, outputPath, preset, resolution = '1080p', probe, encoderConfig }) -> { args: string[], remuxFallbackToH264: boolean }`
  - `parseFfmpegProgressChunk(chunk: string, parserState: { buffer: string, current: object }) -> Array<{ outTimeSec: number | null, speed: number | null, progressEnd: boolean }>`
  - `transcodeFile({ inputPath, outputPath, preset, resolution = '1080p', hwAccel = 'auto', signal, onProgress, onStatusNote, _deps }) -> Promise<{ encoderUsed: string, remuxFallbackToH264: boolean }>`

- [ ] **Step 1: Write failing tests in `test/transcoder.test.js`**

Test all pure logic + mocked subprocess behavior:
1. `selectAudioStream()`: prefers `language: 'ger'` / `'deu'` / `'de'` over `'eng'`; falls back to `title` containing `Deutsch` or `German`; falls back to `audioStreams[0].index`; returns `null` when empty (`[]`, Review Focus #2).
2. `buildTranscodeArgs()` for `hevc` VAAPI (`1080p` on `3840x2160` source): includes `-vaapi_device /dev/dri/renderD128`, `-vf scale=-2:1080,format=nv12,hwupload`, `-c:v hevc_vaapi`, `-rc_mode CQP`, `-qp 24`, `-tag:v hvc1`, `-c:a aac -b:a 160k -ac 2`, `-sn`, `-dn`, `-movflags +faststart`.
3. `buildTranscodeArgs()` never upscales: `720p` source with `resolution: '1080p'` omits `scale=`; `1080p` source with `resolution: '720p'` uses `scale=-2:720` (CPU uses `-vf scale=-2:720` + `libx265` `-crf 24 -pix_fmt yuv420p` or `libx264` `-crf 22`).
4. `buildTranscodeArgs()` video-only source (`audioStreams: []`, Review Focus #2): maps `-map 0:v:0` without `-map 0:a` or `-c:a` flags.
5. `buildTranscodeArgs()` for `remux`: `h264` or `hevc` uses `-c:v copy` (adding `-tag:v hvc1` for `hevc`), `remuxFallbackToH264 === false`; incompatible `vc1` or `mpeg2video` falls back to `h264` encode with `remuxFallbackToH264 === true`.
6. `parseFfmpegProgressChunk()`: parses split multi-line `-progress pipe:1` chunks into accurate `outTimeSec`, `speed`, and `progressEnd` updates.
7. `resolveEncoderConfig()`: caches VAAPI probe results, picks `renderD128` first in `auto` mode, falls back to `cpu` when probe fails.
8. `transcodeFile()` runtime VAAPI fallback via `_deps` (Review Focus #4): when `hwAccel === 'auto'` and initial VAAPI `spawn` exits with code `1`, unlinks partial output, calls `onStatusNote('VAAPI fehlgeschlagen → CPU-Fallback')`, retries once with CPU encoder, and resolves with `{ encoderUsed: 'libx265' }`.
9. `transcodeFile()` aborts cleanly via `AbortController`: sends `SIGTERM` to spawned FFmpeg process and rejects with `AbortError`.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/transcoder.test.js`
Expected: FAIL (`Cannot find module '../lib/transcoder.js'`).

- [ ] **Step 3: Implement `lib/transcoder.js`**

- Reuse `runFfprobeCommand` pattern from `lib/proxy.js` (or self-contained `execFile`/`spawn` JSON helper) for `probeMedia(filePath)`.
- `listVaapiDevices()`: reads `/dev/dri` (`fs.promises.readdir`), filters `^renderD(\d+)$`, sorts numerically ascending, optionally queries `vainfo --display drm --device <path>` (2s timeout, extracts renderer string, fallback to device path).
- `probeVaapiEncoder(devicePath, encoderName)`: runs 1-frame null probe with `-rc_mode CQP -qp 24`, cached in `probeCache` Map (clearable via `clearProbeCache()`).
- `buildTranscodeArgs(...)`: builds deterministic argument arrays; handles `remux` fallback (`remuxCodecFallback` using resolved `h264` VAAPI/CPU config).
- `transcodeFile(...)`: injects defaults for `{ probeMedia, listVaapiDevices, probeVaapiEncoder, resolveEncoderConfig, spawn, unlink }` via `_deps`; parses `stdout` via `parseFfmpegProgressChunk()`, reports `{ percent, speed, etaSec, outTimeSec }`; implements single runtime VAAPI->CPU fallback when `hwAccel === 'auto'` and not aborted; sends `SIGTERM` + 3s `SIGKILL` escalation on `signal` abort.

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/transcoder.test.js`
Expected: All 9 tests in `test/transcoder.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/transcoder.js test/transcoder.test.js
git commit -m "feat(download): add FFprobe/FFmpeg VAAPI and CPU transcoder module"
```

---

### Task 4: 2-Stage Pipeline Orchestrator (`lib/download-manager.js`)

**Files:**
- Create: `lib/download-manager.js`
- Create: `test/download-manager.test.js`

**Interfaces:**
- Consumes: `lib/downloader.js` (`downloadFile`, `redactUrl`), `lib/transcoder.js` (`transcodeFile`, `listVaapiDevices`).
- Produces in `lib/download-manager.js`:
  - `sanitizeName(str: string) -> string`
  - `resolveTargetPath({ baseDir, structure, mediaType, title, seriesName, seasonNum, episodeNum, episodeTitle, sourceExt, preset }) -> string`
  - `resolveDuplicatePath(targetPath: string, action: 'skip'|'rename'|'overwrite', existsFn?) -> { action: string, finalPath: string }`
  - `createDownloadManager(deps)` returning:
    - `checkConflicts(items, options) -> Promise<{ conflicts: Array<{ index, itemKey, title, existingPath, existingSizeBytes, reason }>, resolvedTargets: Array<{ index, itemKey, targetPath }> }>`
    - `enqueueDownloads(items, options) -> Promise<{ added: number, skippedDuplicateItem: number, skippedExisting: number, jobs: Array<object> }>`
    - `getStateSnapshot() -> { jobs: Array<object>, summary: { downloading: number, transcoding: number, queued: number, queuedTranscode: number, completed: number, error: number, activeTotal: number } }`
    - `cancelJob(jobId) -> Promise<void>`
    - `cancelAll() -> Promise<void>`
    - `retryJob(jobId) -> Promise<boolean>`
    - `removeJob(jobId) -> Promise<void>`
    - `clearCompleted() -> void`
    - `hasActiveJobs() -> boolean`
    - `shutdown() -> Promise<void>`
  - Electron singleton wrapper exports: `{ sanitizeName, resolveTargetPath, resolveDuplicatePath, createDownloadManager, init, hasActiveJobs, shutdown }` where `init(getMainWindow, app)` registers IPC handlers (`download:get-default-dir`, `download:select-dir`, `download:list-vaapi-devices`, `download:check-conflicts`, `download:enqueue`, `download:get-state`, `download:cancel`, `download:cancel-all`, `download:retry`, `download:remove`, `download:clear-completed`, `download:open-folder`).

- [ ] **Step 1: Write failing tests in `test/download-manager.test.js`**

Test path rules, conflicts, and orchestrated 2-stage pipeline with fake fs/downloader/transcoder stubs in `os.tmpdir()`:
1. `sanitizeName()` keeps German umlauts (`äöüÄÖÜß`), strips `/\:*?"<>|`, neutralizes `..` traversal segments (Review Focus #2).
2. `resolveTargetPath()` produces `<baseDir>/Movies/<Title>.mp4` and `<baseDir>/Series/<Serie>/Season 01/<Serie> - S01E02 - <EpTitle>.mp4` in `structured` mode, omits redundant `episodeTitle` when it equals `Episode 2` or starts with `seriesName` (Review Focus #2), and writes directly into `<baseDir>/` in `flat` mode; keeps `sourceExt` for `original` preset.
3. `resolveDuplicatePath()` handles `skip`, `overwrite`, and `rename` (`Name (1).mp4`, `Name (2).mp4`).
4. `checkConflicts()` detects existing files on disk (`reason: 'disk'`), colliding paths within the same batch (`reason: 'batch'`, Review Focus #3), and active in-flight targets (`reason: 'inflight'`).
5. `enqueueDownloads()` ignores duplicate active `itemKey`s (Review Focus #3) and strips `url` completely from `getStateSnapshot().jobs`.
6. 2-stage pipeline concurrency & backpressure: with 3 queued items and controllable promises for `downloadFile` and `transcodeFile`, proves:
   - Never more than `1` simultaneous `downloadFile` call.
   - Item 2 starts downloading while Item 1 is `transcoding`.
   - Item 3 stays `queued` (does NOT start downloading) while Item 1 is `transcoding` AND Item 2 is `queued_transcode` (backpressure cap = 1).
7. Pre-flight disk space check (`statfs` returning `< 500 MB`): fails Stage 2 cleanly with German error message, retains `.raw.part`, and sets `errorStage: 'transcode'`.
8. Stage-2 failure retention & retry (Review Focus #4): when `transcodeFile` fails, `.transcode.part.mp4` is unlinked while `.raw.part` is retained; calling `retryJob(id)` re-runs Stage 2 without calling `downloadFile` again; calling `removeJob(id)` or `shutdown()` unlinks retained `.raw.part`.
9. Stage-1 error & active cancel: unlinks `.raw.part` and `.transcode.part.mp4` cleanly.

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/download-manager.test.js`
Expected: FAIL (`Cannot find module '../lib/download-manager.js'`).

- [ ] **Step 3: Implement `lib/download-manager.js`**

- Build clean pure helpers (`sanitizeName`, `resolveTargetPath`, `resolveDuplicatePath`) and `createDownloadManager(deps)`.
- Enforce `statfs(targetDir)` free-space check (`bavail * bsize >= 500 * 1024 * 1024`) before Stage 2 transcode and before Stage 1 download when `totalBytes` is unknown or exceeds available space.
- Implement job state transitions, Stage-2 `.raw.part` retention (`job.errorStage = 'transcode'`), `retryJob()` Stage-2 shortcut when `job.errorStage === 'transcode'` and `rawPartPath` exists, credential-free `serializeJob(job)`, and throttled `scheduleEmit()` (`300 ms` during progress, immediate on status transition).
- Implement `init(getMainWindow, app)` wiring Electron `ipcMain.handle` endpoints (`dialog.showOpenDialog` for folder selection, `shell.showItemInFolder` / `shell.openPath` for folder opening).

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/download-manager.test.js`
Expected: All 9 tests in `test/download-manager.test.js` PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/download-manager.js test/download-manager.test.js
git commit -m "feat(download): add 2-stage download manager with queue and conflict handling"
```

---

### Task 5: Main Process, Preload IPC Bridge, Context Menu & Local MPV Launcher

**Files:**
- Modify: `lib/external-player.js:1-103`
- Modify: `preload.js:1-49`
- Modify: `main.js:1-175`
- Modify: `package.json:32-50`

**Interfaces:**
- Consumes: `lib/download-manager.js` (`init`, `hasActiveJobs`, `shutdown`).
- Produces:
  - `lib/external-player.js`: `openLocalFileInMpv(filePath) -> { ok: boolean, error?: string }` and extended `show-context-menu` supporting `{ name, url, meta }`.
  - `preload.js`: `window.electronAPI` methods `getDefaultDownloadDir`, `selectDownloadDir`, `listVaapiDevices`, `checkDownloadConflicts`, `enqueueDownloads`, `getDownloadState`, `cancelDownload`, `cancelAllDownloads`, `retryDownload`, `removeDownload`, `clearCompletedDownloads`, `openDownloadFolder`, `openDownloadedInMpv`, `onDownloadStateUpdate`, `onContextMenuDownload`, plus `showContextMenu(name, url, meta = null)`.
  - `main.js`: initializes `downloadManager`, handles `download:open-in-mpv`, prompts & runs `downloadManager.shutdown()` on `mainWindow` close when active jobs exist.

- [ ] **Step 1: Update `lib/external-player.js`**

- Add `fs` require and `openLocalFileInMpv(filePath)`: verify `filePath && fs.existsSync(filePath)`, then `spawn('mpv', [filePath], { detached: true, stdio: 'ignore' })` + `.unref()`. Do **not** call `killActiveFfmpegRef()`, do **not** emit `stop-playback` or `mpv-status-changed`. On `'error'`, log and optionally show `dialog.showErrorBox`. Return `{ ok: true }` or `{ ok: false, error }`.
- Update `ipcMain.on('show-context-menu', (event, { name, url, meta }) => { ... })`: when `meta && meta.downloadable`, append `{ type: 'separator' }`, `{ label: '⬇ Herunterladen (Standard)', click: () => event.sender.send('context-menu-download', { item: meta, mode: 'default' }) }`, and `{ label: '⚙ Herunterladen mit Optionen...', click: () => event.sender.send('context-menu-download', { item: meta, mode: 'options' }) }`.
- Export `openLocalFileInMpv` alongside `init` and `killActiveExternal`.

- [ ] **Step 2: Update `preload.js`**

- Update `showContextMenu: (name, url, meta = null) => ipcRenderer.send('show-context-menu', { name, url, meta })`.
- Expose all 13 invoke channels (`getDefaultDownloadDir`, `selectDownloadDir`, `listVaapiDevices`, `checkDownloadConflicts`, `enqueueDownloads`, `getDownloadState`, `cancelDownload`, `cancelAllDownloads`, `retryDownload`, `removeDownload`, `clearCompletedDownloads`, `openDownloadFolder`, `openDownloadedInMpv`) and 2 event listeners (`onDownloadStateUpdate`, `onContextMenuDownload`).

- [ ] **Step 3: Update `main.js` and `package.json`**

- In `main.js`:
  - Require `./lib/download-manager` and `{ dialog, ipcMain }` cleanly (`dialog` added to `electron` import).
  - In `app.whenReady()`: call `downloadManager.init(getMainWindow, app)` and `ipcMain.handle('download:open-in-mpv', (_e, filePath) => externalPlayer.openLocalFileInMpv(filePath))`.
  - On `mainWindow.on('close', async (e) => { ... })`: guard with `isClosingConfirmed`; if `!isClosingConfirmed && downloadManager.hasActiveJobs()`, call `e.preventDefault()`, show `dialog.showMessageBox` (`"Downloads laufen noch"`, `"Abbrechen (weiterlaufen)"` vs `"Beenden & abbrechen"`), and on confirm set `isClosingConfirmed = true`, `await downloadManager.shutdown()`, `mainWindow.destroy()`.
  - Also call `downloadManager.shutdown()` in `will-quit` if needed cleanly.
- In `package.json`: add `"renderer-settings.js"` and `"renderer-downloads.js"` to `build.files`.

- [ ] **Step 4: Verify syntax and existing tests**

Run: `node -c main.js && node -c preload.js && node -c lib/external-player.js && node -c lib/download-manager.js && npm test`
Expected: Syntax checks exit 0 and all tests in `npm test` PASS.

- [ ] **Step 5: Commit**

```bash
git add lib/external-player.js preload.js main.js package.json
git commit -m "feat(download): wire main process lifecycle, IPC bridge, context menu, and packaging"
```

---

### Task 6: Settings Modal UI Extension (`Downloads & Transcoding`)

**Files:**
- Modify: `index.html:296-326`
- Modify: `renderer-settings.js:1-116`
- Modify: `style.css` (append settings layout rules)

**Interfaces:**
- Consumes: `window.AppSettings`, `window.AppSettingsSchema`, `window.electronAPI.{getDefaultDownloadDir, selectDownloadDir, listVaapiDevices}`.
- Produces: Settings modal form supporting both existing EPG/Cache integers and the 7 new download settings.

- [ ] **Step 1: Update `#settings-modal` in `index.html`**

Keep the existing EPG/Cache inputs intact (`#set-concurrency`, `#set-cache`, `#set-historic`), group them cleanly above a new `"Downloads & Transcoding"` section containing:
- `#set-download-dir` (`<input type="text">`) + `#btn-browse-download-dir` (`Durchsuchen...`)
- `#set-download-structure` (`<select>`: `structured`, `flat`)
- `#set-download-preset` (`<select>`: `hevc`, `h264`, `remux`, `original`)
- `#set-download-resolution` (`<select>`: `1080p`, `720p`, `original`)
- `#set-download-click-action` (`<select>`: `dialog`, `instant`)
- `#set-download-duplicate` (`<select>`: `ask`, `skip`, `rename`, `overwrite`)
- `#set-download-hwaccel` (`<select>`: `auto`, `cpu`, plus dynamically populated `/dev/dri/renderD*` options)
Ensure `#settings-modal .modal-card` allows comfortable width (`max-width: 620px`) and scrollable body.

- [ ] **Step 2: Update `renderer-settings.js` and `style.css`**

- Extend `inputIdForKey(key)` in `renderer-settings.js` to map all 10 keys in `AppSettingsSchema`.
- Update `openSettingsModal()` (`async`): populate all inputs from `AppSettings.get(key, meta.default)`; fetch `electronAPI.getDefaultDownloadDir()` for `#set-download-dir` placeholder (and pre-fill if `''`); fetch `electronAPI.listVaapiDevices()` to populate `/dev/dri/renderD*` options while preserving the saved `downloadHwAccel` value (even if a previously configured node is currently absent).
- Wire `#btn-browse-download-dir` click -> `await window.electronAPI.selectDownloadDir(input.value)` -> update `#set-download-dir`.
- Update `saveSettings()` to validate per `meta.type` (`'int'` keeps existing integer check; `'enum'` checks `meta.values.includes(val)`; `'string'` checks `meta.pattern` if present) and store `''` if user leaves `#set-download-dir` equal to default or empty.
- Add `.settings-section`, `.settings-section-head`, `.settings-grid`, `.form-group.full`, `.path-input-row`, and styled `<select>` rules in `style.css`.

- [ ] **Step 3: Verify syntax and tests**

Run: `node -c renderer-settings.js && npm test`
Expected: Syntax clean and all tests PASS.

- [ ] **Step 4: Commit**

```bash
git add index.html renderer-settings.js style.css
git commit -m "feat(settings): add Downloads and Transcoding section to Settings modal"
```

---

### Task 7: Renderer Download Controller, Modals, Top-Bar Button & Floating Status Bar

**Files:**
- Create: `renderer-downloads.js`
- Create: `test/download-ui.test.js`
- Modify: `index.html:61-69,328-352`
- Modify: `style.css`
- Modify: `renderer.js:30-56,179-206` (init + Escape/overlay dismissal if handled in `renderer-xtream.js` / `renderer.js`)

**Interfaces:**
- Consumes: `window.electronAPI.*`, `window.AppSettings`.
- Produces in `renderer-downloads.js` (dual CommonJS + `window.DownloadUI` export; guard all DOM/window wiring behind `typeof document !== 'undefined'` so Node tests can `require('../renderer-downloads.js')` cleanly):
  - `createDownloadController({ AppSettings, electronAPI, openOptionsModal, openConflictModal, onBatchEnqueued }) -> { triggerDownload, runEnqueueWithConflictCheck, updateSnapshot, getJobForItemKey, getSnapshot }`
  - `window.DownloadUI.init()`
  - `window.DownloadUI.triggerDownload(items, { source, forceDialog } = {})`
  - `window.DownloadUI.openManagerModal()`
  - `window.DownloadUI.getJobForItemKey(itemKey)`

- [ ] **Step 1: Write failing logic test in `test/download-ui.test.js`**

Test pure controller routing (`createDownloadController` with stubbed `AppSettings`, `electronAPI`, and modal callbacks) covering:
1. Default click (`downloadClickAction === 'dialog'`): `triggerDownload([item], { source: 'button' })` opens the Options modal instead of immediately calling `enqueueDownloads`.
2. Instant click (`downloadClickAction === 'instant'` or context-menu `'default'` mode) when `downloadDuplicateAction === 'ask'` and `checkDownloadConflicts` returns 1 conflict (Review Focus #5): does **not** call `enqueueDownloads` directly; opens the Conflict modal (`openConflictModal`), and only calls `enqueueDownloads` after user chooses `'rename'` / `'skip'` / `'overwrite'`.
3. Instant click with zero conflicts calls `enqueueDownloads` directly.
4. `getJobForItemKey(itemKey)` returns the matching job from the latest `download-state-update` snapshot (prioritizing active jobs over older finished ones).

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/download-ui.test.js`
Expected: FAIL (`Cannot find module '../renderer-downloads.js'`).

- [ ] **Step 3: Add markup in `index.html` and styles in `style.css`**

- In `index.html` `.top-bar-right`: add `<button id="btn-downloads" class="btn-sm btn-sm-cyan" style="display: none;">⬇ Downloads <span id="downloads-badge-count" class="badge-count" style="display: none;">0</span></button>`.
- Add `#download-status-bar` (analogous to `#mpv-status-bar`, hidden by default) with progress track, active download/transcode text, `Queue (n)` button, and `✕` dismiss button.
- Add `#download-options-modal` (matching Mockup Tab 3: target summary, 2×2 preset cards, resolution segmented control disabled on `remux`/`original`, info chips, path preview + `Ordner...` override button, `"Als Standard-Preset merken"` checkbox, Abbrechen / Download starten).
- Add `#download-conflict-modal` (lists colliding filenames + `Überspringen`, `Alle umbenennen`, `Überschreiben`, `Abbrechen`).
- Add `#downloads-modal` (matching Mockup Tab 4: summary bar, `Alle`/`Aktiv`/`Fertig` filter pills, queue list, `📁 Zielordner öffnen` / `Fertige leeren` / `Alle abbrechen`).
- Add `<script src="renderer-downloads.js"></script>` before `<script src="renderer.js"></script>`.
- In `style.css`: style all new elements matching `--bg-dark`, `--accent-cyan`, `--accent-blue`, `--accent-purple` tokens, and stack `#download-status-bar` cleanly above `#mpv-status-bar` when `.app-container.mpv-active` is set.

- [ ] **Step 4: Implement `renderer-downloads.js` and wire init/dismissal**

- Implement pure testable `createDownloadController(...)` (dual CommonJS + browser global) handling `triggerDownload`, conflict check, options submission, and `getJobForItemKey`.
- Wire DOM modals, preset/resolution toggling, path preview (using simple client mirror or IPC preview), status bar dismissal (resets `isStatusBarDismissed = false` whenever `enqueueDownloads` adds >= 1 job), queue rendering with `openDownloadFolder` and `openDownloadedInMpv`, and `window.refreshEpisodeDownloadBadges?.()` notification on state updates.
- In `renderer.js`: call `window.DownloadUI?.init()` inside `DOMContentLoaded`.
- Ensure `Escape` and overlay backdrop click close `#download-options-modal`, `#download-conflict-modal`, and `#downloads-modal` cleanly.

- [ ] **Step 5: Run tests and syntax checks**

Run: `node --test test/download-ui.test.js && node -c renderer-downloads.js && node -c renderer.js`
Expected: All tests in `test/download-ui.test.js` PASS; syntax checks exit 0.

- [ ] **Step 6: Commit**

```bash
git add index.html style.css renderer-downloads.js renderer.js test/download-ui.test.js
git commit -m "feat(download): add download modals, status bar, and renderer controller"
```

---

### Task 8: Movies Sidebar & Series Episodes / Staffel / Multi-Select Integration + Full Verification

**Files:**
- Modify: `renderer.js:322-379`
- Modify: `index.html:128-147`
- Modify: `renderer-xtream.js:710-818`
- Modify: `style.css`

**Interfaces:**
- Consumes: `window.DownloadUI.{triggerDownload, getJobForItemKey}`, `window.electronAPI.showContextMenu(name, url, meta)`.
- Produces: `window.refreshEpisodeDownloadBadges()` called by `renderer-downloads.js` on state snapshots.

- [ ] **Step 1: Add Movie `⬇` button and context-menu metadata in `renderer.js`**

- In `renderChannelList(list)`:
  - Keep existing `.mpv-direct-btn`.
  - When `activePlaylistType === 'xtream' && activeTab === 'vod'`, construct `movieMeta = { itemKey: 'movie:' + ch.streamId, mediaType: 'movie', title: ch.name, url: streamUrl, sourceExt: ch.containerExtension || 'mp4', downloadable: true }`.
  - Append `<button class="download-direct-btn" title="Herunterladen">⬇</button>` next to `.mpv-direct-btn` with `e.stopPropagation()` calling `window.DownloadUI.triggerDownload([movieMeta], { source: 'button' })`.
  - In `li.addEventListener('contextmenu', ...)`, pass `movieMeta` as the 3rd argument to `window.electronAPI.showContextMenu(ch.name, streamUrl, movieMeta)` for `activeTab === 'vod'` (and `null`/omitted for `live` and `m3u`).

- [ ] **Step 2: Add Series batch toolbar, Multi-Select bar & episode hooks (`index.html`, `renderer-xtream.js`, `style.css`)**

- In `index.html` inside `#episodes-container` `.series-details`: place `#season-select` inside a `.series-toolbar` row alongside:
  - `<button id="btn-download-season" class="btn btn-primary">⬇ Ganze Staffel laden (0)</button>`
  - `<button id="btn-toggle-ep-multiselect" class="btn btn-cyan-outline">☑ Auswählen</button>`
- Above `#episodes-grid`, add `#episodes-multiselect-bar` (hidden by default) with `#ep-multiselect-count`, `#btn-ep-ms-all`, `#btn-ep-ms-none`, `#btn-ep-ms-download`, `#btn-ep-ms-done`.
- In `renderer-xtream.js`:
  - Helper `buildEpisodeItemMeta(ep, seasonNum)` building `{ itemKey: 'episode:' + ep.id, mediaType: 'episode', title: seriesTitle.textContent + ' - S' + paddedSeason + 'E' + paddedEp, seriesId: activeSeriesData.seriesId, seriesName: seriesTitle.textContent, seasonNum, episodeNum: ep.episode_num, episodeTitle: ep.title, url, sourceExt: ep.container_extension || 'mp4', downloadable: true }`.
  - Reset Multi-Select mode cleanly whenever `loadSeriesEpisodes()` or `seasonSelect.onchange` runs; update `#btn-download-season` label (`⬇ Ganze Staffel laden (N)`) and disable when `N === 0`.
  - On each `.episode-card` in `renderEpisodesGrid()`:
    - Store `card.dataset.itemKey = epMeta.itemKey` and attach `epMeta`.
    - Render corner `.ep-dl-btn` (`⬇`, `e.stopPropagation()` -> `DownloadUI.triggerDownload([epMeta], { source: 'button' })`), `.ep-checkbox` (visible in Multi-Select mode), and `.ep-dl-badge` container.
    - When Multi-Select mode is active, clicking the card toggles `.selected` instead of playing the episode; otherwise plays the episode as before.
    - On `contextmenu`, pass `epMeta` as the 3rd argument to `window.electronAPI.showContextMenu(name, url, epMeta)`.
  - Implement `window.refreshEpisodeDownloadBadges()`: updates `.ep-dl-badge` on visible `.episode-card`s from `window.DownloadUI.getJobForItemKey(card.dataset.itemKey)` (`⚙ 68%`, `⬇ 34%`, `⏳`, `✓ Geladen`).
- In `style.css`: style `.series-toolbar`, `.multiselect-bar`, `.episode-card.selected`, `.ep-dl-btn`, `.ep-checkbox`, `.ep-dl-badge`, and `.download-direct-btn`.

- [ ] **Step 3: Run full verification gate**

Run:
```bash
npm test && \
node -c main.js && node -c preload.js && node -c renderer.js && \
node -c renderer-xtream.js && node -c renderer-settings.js && node -c renderer-downloads.js && \
node -c lib/settings.js && node -c lib/external-player.js && \
node -c lib/downloader.js && node -c lib/transcoder.js && node -c lib/download-manager.js && \
fallow dead-code && fallow health --file-scores
```
Expected: All unit tests pass (0 failures), all syntax checks exit 0, `fallow` reports no unexpected dead code or unaddressed hotspots. (If `fallow dead-code` flags anything exported solely for tests or HTML onclicks, document or clean unused helpers.)

- [ ] **Step 4: Commit**

```bash
git add renderer.js renderer-xtream.js index.html style.css
git commit -m "feat(download): integrate movie, season, and episode multi-select download UI"
```
