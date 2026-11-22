# VOD Download & Mobile Transcoding Pipeline — Design Spec

**Status:** Draft (Pending User Approval)  
**Date:** 2026-11-22  
**Primary Use Case:** Download Xtream Codes VOD content (Movies and TV Series episodes) locally and optionally transcode to compact, universally playable mobile MP4 files (e.g., Samsung Galaxy S25 / Android / iOS), shrinking 10+ GB MKVs to ~1–2 GB with guaranteed audio compatibility.

---

## 1. Intent & Why

Users want to save Xtream VOD movies and series episodes offline for mobile viewing. Xtream providers typically distribute 4K/1080p `.mkv` files with AC3/E-AC3/DTS audio and huge bitrates, while their HTTP servers enforce tight concurrent connection caps (often 1–2 connections) and respond with quirks such as `HTTP 206 Partial Content` on fresh `GET` requests without a `Range` header, cross-protocol redirects, and premature socket drops.

A reliable desktop download feature must therefore:
1. Handle Xtream HTTP quirks natively without exceeding 1 provider connection at a time.
2. Separate network download from FFmpeg transcoding into a 2-stage pipeline so server disconnects or slow encodes never lose progress or hold a provider connection slot idle.
3. Leverage local hardware acceleration (Linux VAAPI on AMD dGPU/iGPU, with automatic CPU fallback) to produce mobile-ready `.mp4` files fast, prioritizing German audio tracks and stripping subtitles.

---

## 2. Scope

### In scope (v1)
- **Media Sources:** Xtream Codes VOD Movies (`vod_streams`) and TV Series episodes (`get_series_info`).
- **Selection Modes:**
  - Single Movie download (inline `⬇` button in sidebar + right-click context menu).
  - Series: single Episode download (inline `⬇` button on episode card + right-click context menu), **"⬇ Ganze Staffel laden (N)"** (full season), and interactive **"☑ Auswählen"** Multi-Select mode with contextual batch action bar.
- **2-Stage Pipeline:**
  - Stage 1: Pure Node.js HTTP/HTTPS streaming downloader (`lib/downloader.js`).
  - Stage 2: Local FFmpeg/FFprobe transcoder (`lib/transcoder.js`).
  - Orchestration: Queue, path builder, conflict resolver, and IPC coordinator (`lib/download-manager.js`).
- **4 Presets:**
  - `hevc` — *Handy Kompakt (HEVC / MP4)* (default): `hevc_vaapi` (fallback `libx265`), AAC Stereo 160k, `-movflags +faststart`.
  - `h264` — *Handy Kompatibel (H.264 / MP4)*: `h264_vaapi` (fallback `libx264`), AAC Stereo 160k, `-movflags +faststart`.
  - `remux` — *Audio/Container-Remux (MP4)*: video stream copy + AAC Stereo 160k -> MP4 (with automatic fallback to H.264 encode if source video codec is MP4-incompatible).
  - `original` — *Original (1:1)*: raw downloaded container (`.mkv`/`.mp4`) without FFmpeg processing.
- **Target Resolutions (for `hevc` / `h264`):** `original`, `1080p` (default), `720p`. Never upscale sources already at or below target height.
- **Audio & Subtitles (for `hevc` / `h264` / `remux`):**
  - Prefer German audio track (`language` tag `ger` / `deu` / `de`, or stream `title` matching `/german|deutsch/i`); fallback to the first audio stream.
  - Encode selected audio track to AAC Stereo 160k (`-c:a aac -b:a 160k -ac 2`).
  - Drop all subtitle (`-sn`) and data (`-dn`) streams.
- **Hardware Acceleration:**
  - Linux VAAPI auto-detection across `/dev/dri/renderD*` (`hevc_vaapi` / `h264_vaapi`) with session-cached 1-frame encoder probe and automatic CPU fallback (`libx265` / `libx264`).
  - Explicit device or CPU-only override selectable in Settings.
- **UI & UX (confirmed via interactive mockup):**
  - Clicking `⬇` opens the **Download-Optionen** (Preset) modal by default (`quick-dialog`, configurable in Settings to instant 1-click download).
  - Top-Bar **`⬇ Downloads (n)`** pill button + dismissible floating bottom **Download Status Bar** (`bar-yes`, reappears on new activity) showing active download and active transcode side-by-side.
  - **Download-Manager Modal** with filter pills (`Alle`, `Aktiv`, `Fertig`), per-job progress/speed/ETA, Cancel, Retry, Open in Folder (`shell.showItemInFolder`), Play in MPV, Clear Completed, Cancel All, and Open Download Folder.
  - **Settings Modal** extension (*"Downloads & Transcoding"*) with native Electron folder picker (`dialog.showOpenDialog`), folder structure (`structured` vs `flat`), default preset, default resolution, `⬇` click action, duplicate handling (`ask` / `skip` / `rename` / `overwrite`), and hardware acceleration selector.
- **Session Persistence:** In-memory queue for the active session only (no cross-restart queue persistence).
- **Tests:** Automated `node --test` suites covering downloader, transcoder, download manager, and extended settings schema.

### Out of scope (v1 / Non-Goals)
- M3U playlist VOD downloads.
- Queue persistence or Pause/Resume across application restarts.
- Subtitle retention (`mov_text` / burn-in) or HDR-to-SDR tone mapping.
- Multi-connection concurrent HTTP downloads (must strictly stay at max 1 active Xtream HTTP download).
- Automated transfer to mobile devices (ADB / MTP / Syncthing).

### Anti-Goals
- **Credential Leaks:** Plaintext Xtream credentials (`username` / `password` embedded in stream URLs) must never appear in UI labels, error dialogs, notifications, file paths, IPC state snapshots, or unredacted logs.
- **Orphaned Temp Files:** Cancelled, failed, or aborted jobs must never leave `.raw.part` or `.transcode.part.mp4` temp files on disk.
- **Regression:** Existing Live TV, EPG Grid, Timeshift, MPV integration, and all 34 existing unit tests must continue to pass untouched or cleanly extended.

---

## 3. Approaches Considered & Selected

### Download Engine
- **Selected: Custom Node.js `http`/`https` streaming downloader (`lib/downloader.js`).**
  - Gives full control over Xtream HTTP quirks verified during Fermata TV live testing: `HTTP 206 Partial Content` on fresh `GET` requests without `Range`, chunked `206` continuation loops, cross-protocol `http` ↔ `https` redirects, `User-Agent` preservation, exponential-backoff `Range` retries, strict 1-connection cap, and full `node --test` coverage against local mock servers.
- **Rejected: Inline `ffmpeg -i <url>` during download.**
  - Vulnerable to Xtream server idle/timeout disconnects when CPU/GPU encoding lags behind network speed; cannot seek trailing `moov` atoms over stdin pipes; holds an Xtream connection slot hostage for the entire duration of encoding.
- **Rejected: Electron `session.downloadURL()`.**
  - Brittle on unexpected `HTTP 206` responses, lacks per-provider concurrency throttling, offers coarse retry control, and logs raw credential URLs in Chromium download metadata.

### Transcoding Pipeline
- **Selected: 2-Stage Pipeline (Sequential Download -> Local Transcode).**
  - Stage 1 downloads the source container into a local `.raw.part` file as fast as the network allows and immediately releases the Xtream connection slot.
  - Stage 2 probes and transcodes locally using FFmpeg (full file seek, deterministic `%` and ETA via `ffprobe` duration + `-progress pipe:1`).
  - **Pipelining with Backpressure:** Episode N+1 can download while Episode N transcodes locally, keeping total batch time close to inline transcoding. A hard cap of `max 1` job in `queued_transcode` pauses Stage 1 before starting Episode N+2 if Stage 2 falls behind, preventing unbounded disk consumption from queued raw `.mkv` files.

### UI Integration
- **Selected: Top-Bar `⬇ Downloads (n)` Button + Floating Bottom Status Bar + Modals** (confirmed by user in mockup choices `quick-dialog` and `bar-yes`).
- **Rejected: Dedicated Sidebar Tab.**
  - `#sidebar-tabs` is hidden in M3U mode and switching tabs loses the user's current scroll position/category filter in the VOD catalog.

---

## 4. Technical Design & Module Boundaries

### Architecture Overview

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Renderer Process                                                        │
│  ├─ renderer.js / renderer-xtream.js                                    │
│  │   └─ Movie ⬇ btn, Series Staffel/Multi-Select/Episode ⬇, ContextMenu │
│  ├─ renderer-downloads.js                                               │
│  │   ├─ Download-Optionen Modal (preset, resolution, path preview)      │
│  │   ├─ Conflict Prompt Modal (ask mode: skip / rename / overwrite)     │
│  │   ├─ Download-Manager Modal (queue, progress, retry, folder, MPV)    │
│  │   ├─ Top-Bar "⬇ Downloads (n)" + Floating Bottom Status Bar          │
│  │   └─ Live Episode Card Status Badges (⚙ %, ⬇ %, ✓ Geladen)         │
│  └─ renderer-settings.js + lib/settings.js (IDB settings persistence)   │
└───────────────────────────────▲───────────────────────┬─────────────────┘
                                │ IPC (sanitized state) │ IPC invoke/send
┌───────────────────────────────┴───────────────────────▼─────────────────┐
│ Main Process                                                            │
│  ├─ main.js / preload.js / lib/external-player.js (Context Menu)        │
│  └─ lib/download-manager.js (Orchestrator, Queue, Paths, Temp Cleanup)  │
│      ├─ lib/downloader.js   (HTTP/HTTPS, 206 loop, redirects, retries)  │
│      └─ lib/transcoder.js   (ffprobe, audio pick, VAAPI probe, ffmpeg)  │
└─────────────────────────────────────────────────────────────────────────┘
```

---

### 4.1 `lib/downloader.js` — Streaming HTTP/HTTPS Downloader

Pure Node.js module (`http`, `https`, `fs`, `path`, `url`), zero Electron dependencies.

- **`redactUrl(rawUrl)`**: Parses URL and replaces `username`/`password` path segments in Xtream URLs (`/movie/<user>/<pass>/...`, `/series/<user>/<pass>/...`, `/live/<user>/<pass>/...`) and URL `username:password@` authority or query tokens with `***` before logging or constructing error messages.
- **`downloadFile({ url, partPath, signal, onProgress, userAgent, maxRedirects = 10, maxRetries = 3, requestTimeoutMs = 30000 })`**:
  - Ensures parent directory exists (`fs.mkdirSync(..., { recursive: true })`).
  - Default `User-Agent`: `'BeamcastIPTV/1.3.1'` (or passed value); preserved across all redirects.
  - **Redirect handling:** Follows `301`, `302`, `303`, `307`, `308` up to `maxRedirects`, resolving relative `Location` headers against the current URL and switching smoothly between `http:` and `https:` agents. Preserves `Range` header when resuming.
  - **HTTP 200 & 206 handling:**
    - `200 OK`: Writes from offset 0 (`fs.createWriteStream(partPath, { flags: 'w' })`), reads total size from `Content-Length` if present.
    - `206 Partial Content`: Parses `Content-Range: bytes <start>-<end>/<total|*>`. Appends or writes at expected offset (`flags: 'a'` when continuing from `bytesWritten`, or `'w'` when `start === 0`). Determines `totalBytes` from `<total>` (or `Content-Length` if single chunk from 0).
    - Unexpected status (4xx/5xx): Drains response, throws structured error (with `statusCode`, non-retryable for `401`/`403`/`404`/`410`).
  - **Chunked-206 continuation loop:** If response ends cleanly (`res` `end` + `writeStream` finished) with `totalBytes > 0 && bytesWritten < totalBytes`, immediately issues the next request with `Range: bytes=${bytesWritten}-` until `bytesWritten >= totalBytes`.
  - **Retry logic (transient network errors / premature EOF / socket timeout):**
    - Up to `maxRetries` (3) attempts per stalled leg with exponential backoff (`1000ms`, `2000ms`, `4000ms`), abortable immediately via `signal`.
    - Resumes with `Range: bytes=${bytesWritten}-` if `bytesWritten > 0` and server advertised `Accept-Ranges: bytes` or previously returned `206`; otherwise resets `bytesWritten = 0` and restarts from byte 0.
  - **Backpressure & Progress:** Uses `stream.pipeline` / proper `drain` handling on `fs.createWriteStream` (no unbounded RAM buffering). Reports `{ bytesWritten, totalBytes, speedBps, etaSec }` via `onProgress`.
  - **Cancellation (`AbortSignal`):** Immediately destroys active `http.ClientRequest` / `IncomingMessage`, closes write stream, and throws `AbortError`.

---

### 4.2 `lib/transcoder.js` — FFprobe, Audio Selection & FFmpeg VAAPI/CPU Pipeline

Pure Node.js module (`child_process`, `fs`, `path`), zero Electron dependencies.

- **`probeMedia(filePath)`**:
  - Runs `ffprobe -v error -show_entries format=duration:stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title -of json <filePath>`.
  - Returns `{ durationSec, width, height, videoCodec, audioStreams: [{ index, codec, channels, language, title }] }`.
- **`selectAudioStream(audioStreams)`**:
  - Returns the `index` (absolute FFmpeg stream index) or `null` if `audioStreams` is empty:
    1. First stream whose `language` (lowercased, trimmed) is `'ger'`, `'deu'`, or `'de'`.
    2. Else first stream whose `title` matches `/\b(german|deutsch|ger|deu)\b/i`.
    3. Else first audio stream (`audioStreams[0].index`).
- **`listVaapiDevices()`**:
  - Reads `/dev/dri` for `renderD*` entries sorted numerically (`renderD128`, `renderD129`, ...).
  - Probes optional friendly names via `vainfo --display drm --device <dev>` (timeout 2s, completely non-fatal; falls back to device path label such as `/dev/dri/renderD128`).
- **`probeVaapiEncoder(devicePath, encoderName)`**:
  - Session-cached (`Map<string, boolean>` keyed by `${devicePath}:${encoderName}`).
  - Runs a lightweight 1-frame null test using the actual rate-control flags (`-rc_mode CQP -qp 24`):
    `ffmpeg -hide_banner -loglevel error -vaapi_device <devicePath> -f lavfi -i color=c=black:s=128x128:d=0.04 -vf format=nv12,hwupload -c:v <encoderName> -rc_mode CQP -qp 24 -frames:v 1 -f null -`
  - Timeout 5s. Returns `true` iff exit code === 0.
- **`resolveEncoderConfig({ preset, hwAccel })`**:
  - Returns `{ mode: 'vaapi'|'cpu'|'remux'|'original', videoEncoder, hwDevice }`.
  - If `preset` is `'original'` or `'remux'`, returns immediately (no GPU probe needed).
  - If `hwAccel === 'cpu'`, picks `libx265` (`hevc`) or `libx264` (`h264`).
  - If `hwAccel` is a specific `/dev/dri/renderD*` path, probes `${encoder}_vaapi` on that device; falls back to CPU if probe fails.
  - If `hwAccel === 'auto'`, iterates `listVaapiDevices()` in numeric order (`renderD128` first, matching dGPU on the user's workstation) and selects the first device whose `${encoder}_vaapi` probe succeeds; falls back to CPU if none pass.
- **`buildTranscodeArgs({ inputPath, outputPath, preset, resolution, probe, encoderConfig })`**:
  - **Stream mapping:**
    - `-map 0:v:0`
    - If `selectedAudioIndex !== null`: `-map 0:${selectedAudioIndex}`
    - Always `-sn -dn` (drop subtitles and data streams).
  - **Scaling check:**
    - `targetHeight = resolution === '720p' ? 720 : (resolution === '1080p' ? 1080 : 0)`.
    - `needsScale = targetHeight > 0 && probe.height > targetHeight` (never upscale).
  - **Codec & filter args by preset:**
    - `hevc` + VAAPI (`hevc_vaapi`):
      `-vaapi_device <hwDevice> -i <inputPath> ... -vf "[scale=-2:<targetHeight>,]format=nv12,hwupload" -c:v hevc_vaapi -rc_mode CQP -qp 24 -tag:v hvc1` (software `format=nv12` before `hwupload` normalizes 10-bit/unusual pixel formats for VAAPI).
    - `hevc` + CPU (`libx265`):
      `-i <inputPath> ... [-vf scale=-2:<targetHeight>] -c:v libx265 -preset medium -crf 24 -pix_fmt yuv420p -tag:v hvc1`
    - `h264` + VAAPI (`h264_vaapi`):
      `-vaapi_device <hwDevice> -i <inputPath> ... -vf "[scale=-2:<targetHeight>,]format=nv12,hwupload" -c:v h264_vaapi -rc_mode CQP -qp 22`
    - `h264` + CPU (`libx264`):
      `-i <inputPath> ... [-vf scale=-2:<targetHeight>] -c:v libx264 -preset medium -crf 22 -pix_fmt yuv420p`
    - `remux`:
      - Checks `['h264', 'hevc', 'h265', 'mpeg4', 'av1'].includes((probe.videoCodec || '').toLowerCase())`.
      - If compatible: `-i <inputPath> ... -c:v copy` (plus `-tag:v hvc1` if `hevc`/`h265`).
      - If incompatible (e.g., `mpeg2video`, `vc1`, `wmv3`): transparently falls back to `h264` encode (VAAPI/CPU via `resolveEncoderConfig`) and flags `{ remuxFallbackToH264: true }` in job metadata so the UI shows `"Remux nicht möglich → H.264"` instead of failing.
  - **Audio & MP4 container (for `hevc`, `h264`, `remux`):**
    - If `selectedAudioIndex !== null`: `-c:a aac -b:a 160k -ac 2`
    - `-movflags +faststart -f mp4 -progress pipe:1 -nostats -y <outputPath>`
- **`parseFfmpegProgress(chunk)` & `transcodeFile(...)`**:
  - Parses key=value lines from FFmpeg `-progress pipe:1` (`out_time_us`, `speed`, `progress`).
  - Computes `percent = clamp(outTimeSec / probe.durationSec * 100, 0, 99.9)` and `etaSec` from `speed` & remaining duration.
  - **Runtime VAAPI Fallback *(Design call)*:** If `encoderConfig.mode === 'vaapi'` and FFmpeg exits non-zero (unless aborted via `signal`) when `hwAccel === 'auto'`, `transcodeFile()` deletes the partial output file, invokes `onProgress` / sets `statusNote: 'VAAPI fehlgeschlagen → CPU-Fallback'`, and automatically retries once with the CPU encoder (`libx265` / `libx264`).
  - On `AbortSignal` abort: sends `SIGTERM`, escalates to `SIGKILL` after 3000 ms if still alive, throws `AbortError`.

---

### 4.3 `lib/download-manager.js` — Pipeline Orchestrator, Paths & Conflict Handling

Main-process service initialized from `main.js` (`downloadManager.init(getMainWindow, app)`).

- **Path & Filename Helpers:**
  - `getDefaultDownloadDir(app)`: `path.join(app.getPath('downloads'), 'BeamcastIPTV')`.
  - `sanitizeName(str)`: keeps UTF-8 characters including German umlauts/ß; replaces `/ \ : * ? " < > |` and control characters with space; collapses whitespace; strips leading/trailing dots/spaces; fallback `'video'`.
  - `resolveTargetPath({ baseDir, structure, mediaType, title, seriesName, seasonNum, episodeNum, episodeTitle, sourceExt, preset })`:
    - `ext`: `preset === 'original' ? (sourceExt || 'mkv') : 'mp4'`.
    - `paddedSeason`: `String(seasonNum).padStart(2, '0')`, `paddedEpisode`: `String(episodeNum).padStart(2, '0')`.
    - Series filename: `<sanitizedSeries> - S<SS>E<EE>` + optional ` - <sanitizedEpTitle>` (omitted if `episodeTitle` is empty, equals `Episode <N>`, or already starts with `seriesName` / `S<SS>E<EE>` to avoid redundant names like `Serie - S01E01 - Serie S01E01`).
    - When `structure === 'structured'`:
      - Movie: `<baseDir>/Movies/<sanitizedTitle>.<ext>`
      - Series: `<baseDir>/Series/<sanitizedSeries>/Season <SS>/<seriesFilename>.<ext>`
    - When `structure === 'flat'`:
      - `<baseDir>/<sanitizedFilename>.<ext>`
  - `resolveDuplicatePath(targetPath, action)`:
    - `'skip'` -> returns `{ action: 'skip', finalPath: targetPath }`
    - `'overwrite'` -> returns `{ action: 'overwrite', finalPath: targetPath }`
    - `'rename'` -> probes `<dir>/<name> (1).<ext>`, `<dir>/<name> (2).<ext>`, ... until non-existent.

- **Conflict Pre-Flight (`checkConflicts(items, options)`):**
  - Resolves intended `finalPath` for every item in the batch + accounts for in-flight jobs targeting the same `finalPath`.
  - Returns list of colliding items (`{ index, title, existingPath, existingSizeBytes }`) so the renderer can prompt once for the whole batch (`Überspringen`, `Alle umbenennen`, `Überschreiben`, `Abbrechen`) when `duplicateAction === 'ask'`.

- **Job State Machine & Concurrency:**
  - **States:** `queued` → `downloading` → (`queued_transcode` → `transcoding` when `preset !== 'original'`) → `completed` | `cancelled` | `error` | `skipped`.
  - **Concurrency Limits:**
    - Max `1` job in `downloading` (protects Xtream 1–2 connection limits).
    - Max `1` job in `transcoding` (protects GPU/CPU and keeps thermal/IO predictable).
    - **Disk Backpressure Cap:** Max `1` job in `queued_transcode`. The scheduler will not start the next `downloading` job while `transcodingCount === 1 && queuedTranscodeCount >= 1`. As soon as Stage 2 begins transcoding item N+1 (clearing `queued_transcode`), Stage 1 starts downloading item N+2.
  - **Duplicate In-Flight Guard:** Prevents enqueuing two active jobs for the same `itemKey` (`movie:<streamId>` or `episode:<episodeId>`).

- **Temp Files, Retry & Atomic Finalization:**
  - Download writes to `<targetDir>/.<safeJobId>.raw.part`.
  - Original preset: on download completion, `await fs.promises.rename(rawPartPath, finalPath)`.
  - Transcoded/Remux preset: FFmpeg writes to `<targetDir>/.<safeJobId>.transcode.part.mp4`, on success `await fs.promises.rename(transcodePartPath, finalPath)` and `await fs.promises.unlink(rawPartPath)`.
  - **Stage-2 Error Retention & Transcode-Only Retry *(Design call)*:**
    - Always `unlink` `.transcode.part.mp4` on any error, cancel, retry, or removal.
    - On Stage-1 (`download`) error or any job cancel / dismissal (`✕`) / clear / app shutdown: `unlink` `.raw.part`.
    - On Stage-2 (`transcode`) error (e.g., VAAPI failure or `< 500 MB` disk check): retain `.raw.part` and record `errorStage: 'transcode'` on the job so clicking `↻ Retry` verifies `.raw.part` exists and resumes directly at `queued_transcode` without re-downloading multi-GB files from the Xtream server. Dismissing (`✕`), cancelling, or closing the app unlinks the retained `.raw.part`.
  - *(Design call)* Pre-flight disk space check: before starting Stage 2 transcoding (or Stage 1 download if `Content-Length` is known), fail gracefully with a German error message if `fs.statfs` reports `< 500 MB` free space rather than silently corrupting output.

- **Throttled IPC Updates & Credential Redaction:**
  - Pushes `download-state-update` to `mainWindow.webContents` at most every `300 ms` during progress updates and immediately on any state transition.
  - Snapshot payload `{ jobs, summary }` **omits `url`** completely. Each job exposes:
    `{ id, itemKey, mediaType, title, seriesId, seriesName, seasonNum, episodeNum, preset, resolution, status, statusNote, progress, bytesWritten, totalBytes, speedBps, etaSec, transcodeSpeed, finalPath, finalSizeBytes, originalSizeBytes, encoderUsed, error, createdAt }`.

- **App Shutdown Hook (`main.js` `mainWindow.on('close')`):**
  - If `downloadManager.hasActiveJobs()` is true (`downloading`, `queued_transcode`, `transcoding`, or `queued`):
    - Prevent immediate close (`e.preventDefault()`), show `dialog.showMessageBox` (`"Downloads laufen noch"`, `"Es laufen noch aktive Downloads oder Transcodings. Beim Beenden werden laufende Vorgänge abgebrochen und temporäre Dateien gelöscht."`, buttons: `Abbrechen (weiterlaufen)` / `Beenden & abbrechen`).
    - On confirmation, invoke `await downloadManager.shutdown()` (aborts active download, kills FFmpeg, unlinks all `.part` files), then destroy window cleanly.

---

### 4.4 Settings Schema Extension (`lib/settings.js` & `renderer-settings.js`)

Extend `lib/settings.js` `validate(key, value)` to support `'int'`, `'string'`, and `'enum'` (all existing `int` behavior and error messages preserved for full test backwards compatibility).

| Key | Type | Default | Allowed Values / Validation | Consumer |
|-----|------|---------|-----------------------------|----------|
| `epgPrefetchConcurrency` | `int` | `4` | `1..10` | `renderer-epg.js` (existing) |
| `cacheAgeLimitHours` | `int` | `24` | `1..168` | `renderer-xtream.js` (existing) |
| `epgHistoricFilterDays` | `int` | `7` | `1..30` | `db.js` (existing) |
| `downloadDir` | `string` | `''` | Non-null string; `''` resolves in main process to `~/Downloads/BeamcastIPTV` | `renderer-downloads.js` / `download-manager.js` |
| `downloadFolderStructure` | `enum` | `'structured'` | `'structured' \| 'flat'` | `download-manager.js` |
| `downloadDefaultPreset` | `enum` | `'hevc'` | `'hevc' \| 'h264' \| 'remux' \| 'original'` | `renderer-downloads.js` |
| `downloadDefaultResolution` | `enum` | `'1080p'` | `'original' \| '1080p' \| '720p'` | `renderer-downloads.js` |
| `downloadClickAction` | `enum` | `'dialog'` | `'dialog' \| 'instant'` | `renderer-downloads.js` |
| `downloadDuplicateAction` | `enum` | `'ask'` | `'ask' \| 'skip' \| 'rename' \| 'overwrite'` | `renderer-downloads.js` |
| `downloadHwAccel` | `string` | `'auto'` | `'auto' \| 'cpu' \| /^\/dev\/dri\/renderD\d+$/` | `lib/transcoder.js` |

- **No IndexedDB migration required:** `settings` object store (`keyPath: 'key'`) already stores arbitrary key/value records.
- **Settings UI (`index.html` + `renderer-settings.js`):**
  - Keep existing EPG/Cache section intact; add **"Downloads & Transcoding"** section below it matching Tab 5 of the mockup.
  - On `openSettingsModal()`: if `downloadDir` is `''`, invoke `window.electronAPI.getDefaultDownloadDir()` to display the resolved path placeholder/value, and populate the **Hardware-Beschleunigung** `<select>` options dynamically via `window.electronAPI.listVaapiDevices()`.
  - **"Durchsuchen..."** button calls `window.electronAPI.selectDownloadDir(currentValue)` and writes the chosen path back into the text input before Save.

---

### 4.5 IPC Contract (`preload.js`, `main.js`, `lib/external-player.js`)

Expose under `window.electronAPI` in `preload.js`:

```js
// Actions (invoke -> Promise)
getDefaultDownloadDir: () => ipcRenderer.invoke('download:get-default-dir'),
selectDownloadDir: (currentDir) => ipcRenderer.invoke('download:select-dir', currentDir),
listVaapiDevices: () => ipcRenderer.invoke('download:list-vaapi-devices'),
checkDownloadConflicts: (items, options) => ipcRenderer.invoke('download:check-conflicts', { items, options }),
enqueueDownloads: (items, options) => ipcRenderer.invoke('download:enqueue', { items, options }),
getDownloadState: () => ipcRenderer.invoke('download:get-state'),
cancelDownload: (jobId) => ipcRenderer.invoke('download:cancel', jobId),
cancelAllDownloads: () => ipcRenderer.invoke('download:cancel-all'),
retryDownload: (jobId) => ipcRenderer.invoke('download:retry', jobId),
removeDownload: (jobId) => ipcRenderer.invoke('download:remove', jobId),
clearCompletedDownloads: () => ipcRenderer.invoke('download:clear-completed'),
openDownloadFolder: (targetPath) => ipcRenderer.invoke('download:open-folder', targetPath),
openDownloadedInMpv: (filePath) => ipcRenderer.invoke('download:open-in-mpv', filePath),

// Events (main -> renderer)
onDownloadStateUpdate: (callback) => ipcRenderer.on('download-state-update', (event, data) => callback(data)),
onContextMenuDownload: (callback) => ipcRenderer.on('context-menu-download', (event, data) => callback(data)),
```

- **Local MPV Playback from Download Manager *(Design call)*:**
  - `download:open-in-mpv` invokes a dedicated `openLocalFileInMpv(filePath)` helper in `lib/external-player.js` that verifies `fs.existsSync(filePath)` and spawns an independent, detached `mpv <filePath>` process (`detached: true, stdio: 'ignore'`, unreffed) **without** killing active proxy FFmpeg playback, sending `stop-playback`, setting `.app-container.mpv-active`, or modifying `#mpv-status-bar`. This avoids tearing down the user's current IPTV view or breaking `"Intern abspielen"` when previewing a completed download. If `filePath` is missing on disk or `mpv` fails to spawn, return `{ ok: false, error }` / show an error alert cleanly.

- **Context Menu Extension (`lib/external-player.js`):**
  - Update `showContextMenu(name, url, meta = null)` in `preload.js` and `lib/external-player.js` backwards-compatibly.
  - When `meta && meta.downloadable`: append `{ type: 'separator' }`, `'⬇ Herunterladen (Standard)'` (sends `'context-menu-download'` with `{ item: meta, mode: 'default' }`), and `'⚙ Herunterladen mit Optionen...'` (sends `{ item: meta, mode: 'options' }`).
  - *(Design call)* Keep `meta` passing the full item payload only over internal IPC (`show-context-menu` -> `context-menu-download`), and omit `meta` completely for Live TV and M3U channels so only Movies and Series episodes offer download entries.

---

### 4.6 Renderer UI & Interactions (`renderer-downloads.js`, `renderer.js`, `renderer-xtream.js`, `index.html`, `style.css`)

1. **Movies Sidebar (`renderer.js`):**
   - When `activePlaylistType === 'xtream' && activeTab === 'vod'`, add an inline `⬇` button (`.download-direct-btn`, styled beside `.mpv-direct-btn`) on each movie row and pass download metadata to `showContextMenu(ch.name, streamUrl, itemMeta)`.
   - Click on `⬇` calls `window.DownloadUI.triggerDownload([itemMeta], { source: 'button' })`.

2. **Series Episodes View (`renderer-xtream.js`):**
   - In `#episodes-container` toolbar next to `#season-select`, add:
     - **`⬇ Ganze Staffel laden (N)`** button (updates count `N` dynamically per selected season).
     - **`☑ Auswählen`** toggle button (`toggleEpisodeMultiSelect()`).
   - Add contextual Multi-Select bar above `#episodes-grid` (hidden by default):
     - Live selection counter (`X Episoden ausgewählt`), `Alle auswählen`, `Auswahl aufheben`, **`⬇ X Episoden herunterladen`**, `Fertig`.
   - On each `.episode-card`:
     - Show corner `⬇` download button in normal mode (with `e.stopPropagation()` so it doesn't start playback), replaced by a checkbox badge when Multi-Select mode is active.
     - Pass episode download metadata to `showContextMenu(name, url, epMeta)`.
     - Render live download badge (`⚙ 68%`, `⬇ 34%`, `⏳`, `✓ Geladen`) keyed by `episode:<ep.id>` from the latest download state snapshot.
   - *(Design call)* Season switches or loading another series cleanly exits Multi-Select mode and clears temporary selection state.

3. **Download-Optionen Modal (`renderer-downloads.js`):**
   - Opened when `downloadClickAction === 'dialog'` (the default) or when `"Herunterladen mit Optionen..."` is selected from the context menu, or for batch actions (`Ganze Staffel laden` / Multi-Select).
   - Displays target title + item count pill, 2×2 interactive preset cards (`hevc`, `h264`, `remux`, `original`), resolution segmented control (`Original`, `1080p`, `720p` — disabled for `remux`/`original`), fixed policy chips (`Tonspur: Deutsch bevorzugt (AAC 160k Stereo)`, `Untertitel: Keine`, `Hardware: VAAPI Auto / CPU`), live target path preview + `Ordner...` override button, and `"Als Standard-Preset merken"` checkbox (persists preset & resolution to `AppSettings` on submit).
   - On submit: resolves effective `downloadDir` (custom override or `AppSettings.get('downloadDir')`), runs `checkDownloadConflicts(...)`; if `duplicateAction === 'ask'` and conflicts exist, opens the compact Conflict Modal (`Überspringen`, `Alle umbenennen`, `Überschreiben`, `Abbrechen`) before calling `enqueueDownloads(...)`.

4. **Top-Bar Button, Floating Status Bar & Download-Manager Modal (`renderer-downloads.js`):**
   - **Top Bar:** `<button id="btn-downloads">` (`⬇ Downloads` + active badge `(n)`). Visible whenever Xtream is active (or anytime `jobs.length > 0`).
   - **Floating Bottom Status Bar (`#download-status-bar`):**
     - Positioned above bottom edge (`z-index` coordinated with `#mpv-status-bar`; stacked cleanly via CSS if MPV is also active).
     - Shown automatically whenever a job is `downloading`, `queued_transcode`, or `transcoding`, unless manually dismissed by the user's `✕` button (auto-un-dismisses when a new batch is enqueued).
     - Displays active download progress (`⬇ Lädt: ...`) and/or active transcode (`⚙ Transkodiert: ... (VAAPI/CPU)`), progress bar, `Queue (n)` button (opens Download-Manager modal), and `✕` dismiss button.
   - **Download-Manager Modal (`#downloads-modal`):**
     - Summary bar (`X Download aktiv · Y Transcoding aktiv · Z wartend · W fertig`) + filter pills (`Alle`, `Aktiv`, `Fertig`).
     - Queue rows showing status badge, progress bar, speed/ETA, file size comparison (`1.84 GB (Original 9.6 GB · -81%)`), and row actions (`Abbrechen`, `Entfernen`, `↻ Retry`, `📁 Ordner`, `🎬 MPV`).
     - Footer actions: `📁 Zielordner öffnen`, `Fertige leeren`, `Alle abbrechen`.

5. **Packaging (`package.json`):**
   - Add `"renderer-downloads.js"` and `"renderer-settings.js"` to `build.files` in `package.json` so AppImage builds via `npm run dist` include both modules (`renderer-settings.js` is currently missing from `build.files` and would break Settings in packaged AppImages if omitted).

---

## 5. Verification & Testing Strategy

### Automated Tests (`npm test` via `node --test`)
1. **`test/downloader.test.js`** (against local ephemeral Node `http` mock servers):
   - Downloads complete file on `HTTP 200 OK`.
   - Handles `HTTP 206 Partial Content` on initial GET without `Range` header (single 206 matching entire `Content-Range` total).
   - Executes chunked `HTTP 206` continuation loop across multiple chunks until `bytesWritten === totalBytes`.
   - Follows `302`/`307` redirects across mock servers while preserving `User-Agent` and `Range`.
   - Recovers from mid-stream socket destruction using `Range` retry.
   - Cancels cleanly on `AbortSignal` and deletes no orphaned data.
   - `redactUrl()` masks Xtream credentials in `/movie/`, `/series/`, `/live/`, and `user:pass@` URLs.
2. **`test/transcoder.test.js`**:
   - `selectAudioStream()`: picks `ger`/`deu`/`de` over `eng`; falls back to title matching `Deutsch`/`German`; falls back to first audio track; returns `null` when no audio streams exist.
   - `buildTranscodeArgs()`: verifies all 4 presets (`hevc`, `h264`, `remux`, `original`), VAAPI vs CPU args, `-tag:v hvc1` on HEVC, `-sn -dn`, no upscaling when source `height <= targetHeight`, scaling `scale=-2:720` when source is `1080`, and `remux` fallback to `h264` on incompatible video codecs (`vc1`/`mpeg2video`).
   - `parseFfmpegProgress()`: parses `out_time_us`, `speed`, and `progress=end` lines across chunk boundaries.
   - Runtime VAAPI fallback: verifies `transcodeFile()` retries once on CPU when `hwAccel === 'auto'` and VAAPI exits non-zero.
3. **`test/download-manager.test.js`**:
   - `sanitizeName()` preserves umlauts/ß and strips illegal filesystem chars.
   - `resolveTargetPath()` generates expected `Movies/` and `Series/<Serie>/Season XX/` structured and flat paths without duplicate series names.
   - `resolveDuplicatePath()` handles `skip`, `rename` (`(1)`, `(2)`), and `overwrite`.
   - 2-stage pipeline concurrency test with stubbed downloader & transcoder: enforces max 1 active download, allows download N+1 to overlap with transcode N, enforces max 1 `queued_transcode` backpressure cap, retains `.raw.part` on Stage-2 failure for transcode-only `retryDownload()`, and unlinks temp `.part` files on cancellation/removal/Stage-1 error.
4. **`test/settings.test.js`**:
   - Extend existing test suite to verify `string` and `enum` schema validation, invalid VAAPI device path rejection, and defaults for all 7 new download keys.

### Syntax & Static Quality Gates
- `npm test` — all existing (34) + new tests pass.
- `node -c main.js && node -c preload.js && node -c renderer.js && node -c renderer-xtream.js && node -c renderer-settings.js && node -c renderer-downloads.js && node -c lib/settings.js && node -c lib/external-player.js && node -c lib/downloader.js && node -c lib/transcoder.js && node -c lib/download-manager.js`
- `fallow dead-code` & `fallow health --file-scores` (checking `.fallowrc.json` entrypoints and complexity).

---

## 6. Left to the Builder

- Exact CSS class naming, animations, and responsive spacing inside `style.css` matching the existing cyberpunk-glassmorphism design system.
- Internal helper decomposition inside `lib/downloader.js`, `lib/transcoder.js`, `lib/download-manager.js`, and `renderer-downloads.js` to keep functions short and maintainable.
- Exact IPC progress throttle interval tuning (~250–350 ms) and byte formatting helpers (`MB/s`, `GB`, `mm:ss`).
- Minor UI state wiring (e.g., disabling "Ganze Staffel laden" when a season has 0 episodes, updating `#mpv-status-bar` vertical offset when `#download-status-bar` is also visible).
