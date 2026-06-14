# EPG Grid View — Current State & Testing Steps

**Date:** 2026-06-14
**Feature:** Classic TV-guide grid (channels × time) for the current live category.
**Spec:** `docs/superpowers/specs/2026-06-14-epg-grid-view-design.md`
**Plan:** `docs/superpowers/plans/2026-06-14-epg-grid-view.md`

---

## Status summary

| Area | State |
|---|---|
| Feature implementation (9-task plan) | ✅ Complete, committed on `main` |
| Unit tests (`npm test`) | ✅ 9/9 pass (XMLTV parser) |
| Layout: grid full width | ✅ Fixed (was leaving a 360px gap) |
| Content: programmes show in grid | ❌ Open issue — toolbar shows "Keine Guide-Daten" |

Work is committed on local `main` (not pushed). Release via `./scripts/deploy.sh --release` when ready.

---

## What was fixed

### 1. Grid did not use the full width
**Cause:** `.app-container` is a CSS grid with `grid-template-columns: 360px 1fr`. The `guide-open`
state hid `.sidebar` with `display:none`, but the **360px column was still reserved**, so the grid
only filled the right `1fr` and left a 360px empty gap on the left.

**Fix** (`style.css`, commit `2c844d3`): added the rule the player-only mode already uses:
```css
.app-container.guide-open { grid-template-columns: 1fr; }
.app-container.guide-open .main-content { grid-template-rows: 80px 1fr; min-height: 0; }
```

---

## Open issue: no programme content ("Keine Guide-Daten")

"Keine Guide-Daten" means `IPTVDb.getEpgMeta(accountId)` returned `null` → `saveEpg` was **never
called successfully**. Because `saveEpg` writes a meta record even for an empty parse, a null meta
means the pipeline threw/hung **before** the save step.

### Known-good so far
- Main process **does** forward the request: log `Forwarding Xtream XMLTV request: http://stv-pr.cx:8080/xmltv.php?username=...&password=...`
- The XMLTV URL works in a browser and downloads a valid ~10MB `epg.xml`.
- No `Xtream XMLTV Proxy Error` logged → the main-process fetch succeeds.
- App was fully restarted, so IndexedDB should be on **v3** (has `epg_programmes` + `epg_meta`).

### Therefore the failure is in the renderer, downstream of the proxy fetch
Most likely one of:
1. **Web Worker hang/failure** — `parseXmltvAsync` never resolved (no `onmessage`/`onerror`), so
   `await` hung and `saveEpg` was never reached.
2. **Parser returns 0 channels** — the regex XMLTV parser doesn't match this provider's format.
3. **Join-key mismatch** — parse + save succeed, but XMLTV `<programme channel="...">` IDs don't
   match `live_streams.epgChannelId` (= `item.epg_channel_id`), so every row shows "Keine Programmdaten".

### Instrumentation added (commit `7c1125f`, `renderer.js`)
- Step-by-step `[EPG]` console logs across `fetchAndStoreEpg`.
- `parseXmltvAsync`: logs worker path, captures `worker.onerror` details (message/filename/lineno),
  logs channel counts, and now has a **30s watchdog timeout** that falls back to main-thread parsing
  instead of hanging.

---

## Next testing steps

1. **Reload** the app (`Ctrl+R` is enough — DB already v3; renderer JS reloads).
2. Open the **TV Guide**.
3. Open **DevTools → Console** (F12).
4. Click the in-grid **🔄 Refresh** button. (This runs the exact fetch → parse → `saveEpg` path
   without a full re-sync. A full re-sync also works but is slower.)
5. Capture all `[EPG]` log lines.

### Expected healthy sequence
```
[EPG] fetching XMLTV via proxy: http://127.0.0.1:18080/xtream/xmltv?...
[EPG] proxy response status: 200 true
[EPG] XMLTV downloaded, length: <N> chars; first 120: <?xml ...
[EPG] worker created, posting <N> chars for off-thread parse
[EPG] worker returned <N> channels
[EPG] parsed channelMap: <N> channels, <M> programmes
[EPG] saving to IndexedDB (saveEpg)...
[EPG] saveEpg complete for account acc_...
```

### Interpreting where it stops

| Observation | Diagnosis | Likely fix |
|---|---|---|
| Stops after "downloaded"; then `worker.onerror` / `worker timeout` warning, then `main-thread parse produced 0 channels` | Worker can't load AND parser doesn't match this XML | Inspect `epg.xml` format; adjust regex parser in `epg-parse.js` |
| `worker.onerror` / timeout, but `main-thread parse produced N>0 channels`, then `saveEpg complete` | Worker broken but fallback works | Keep fallback; optionally fix worker load path; content should now appear |
| `parsed channelMap: 0 channels, 0 programmes` | Regex parser doesn't match provider XMLTV (e.g. single-quoted attrs, CDATA, namespaces) | Adjust `parseXmltv`/`attr`/`tagText` in `epg-parse.js`; add a fixture test |
| `saveEpg complete` with channels > 0, but grid still empty rows ("Keine Programmdaten") | Join-key mismatch | Compare `<channel id>` / `<programme channel>` in `epg.xml` vs `live_streams.epgChannelId` |
| An `Uncaught`/throw before `saveEpg complete` | `saveEpg` or DB error | Read the thrown error; check `IPTVDb.db.version === 3` |

### Useful DevTools console checks
```js
// Confirm DB schema
console.log('DB version:', IPTVDb.db.version, '| stores:', [...IPTVDb.db.objectStoreNames]);

// Confirm EPG was cached
await IPTVDb.getEpgMeta(activeAccount.id);   // expect { lastFetched, channelCount, programmeCount }

// Inspect the join key on live streams (do the IDs look like the XMLTV channel IDs?)
(await IPTVDb.getStreamsByCategory('live_streams', activeAccount.id, 'all'))
  .slice(0, 10).map(c => ({ name: c.name, epgChannelId: c.epgChannelId }));

// Hit the proxy directly to see raw status + body
fetch(`http://127.0.0.1:18080/xtream/xmltv?host=${encodeURIComponent(activeAccount.host)}&username=${encodeURIComponent(activeAccount.username)}&password=${encodeURIComponent(activeAccount.password)}`)
  .then(r => r.text().then(t => console.log('STATUS', r.status, '\nBODY:', t.slice(0, 600))));
```

From your `epg.xml`, also grab a couple of IDs to compare against `epgChannelId`:
- `<channel id="...">`
- `<programme ... channel="...">`

---

## Relevant files
- `epg-parse.js` — regex XMLTV parser (`xmltvTimeToEpoch`, `parseXmltv`).
- `epg-worker.js` — Web Worker wrapper (`importScripts('epg-parse.js')`).
- `main.js` — `/xtream/xmltv` proxy (`handleXtreamXmltvRequest`, port 18080).
- `db.js` — IndexedDB v3 (`epg_programmes`, `epg_meta`, `saveEpg`/`getEpgForChannels`/`getEpgMeta`).
- `renderer.js` — `fetchAndStoreEpg`, `parseXmltvAsync` (instrumented), `renderEpgGrid`, smart-click.
- `style.css` — `.epg-grid-*` styles, `.guide-open` layout.

## Recent commits
```
7c1125f debug(epg): add step logging + worker timeout/error capture to EPG fetch
2c844d3 fix(epg): make guide grid span full width (collapse sidebar column)
6cfe387 build(epg): include EPG parser and worker in AppImage
8cb1c75 fix(epg): reset live UI state when playing live from guide grid
458fa6d feat(epg): render TV guide grid with smart-click playback
826f639 feat(epg): grid markup, Guide toggle button, and styles
cd8fb09 feat(epg): prefetch and cache XMLTV during account sync
961c6a4 feat(epg): IndexedDB v3 stores + epgChannelId + EPG methods
eadf697 feat(epg): add /xtream/xmltv proxy route in main process
f979ace feat(epg): add web worker wrapper for XMLTV parsing
3ad995c feat(epg): parse XMLTV programmes grouped per channel
d3dc1b3 feat(epg): add dependency-free XMLTV time parser with tests
```
