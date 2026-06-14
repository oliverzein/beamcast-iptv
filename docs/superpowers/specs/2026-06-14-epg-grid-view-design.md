# EPG Grid View — Design Spec

**Date:** 2026-06-14
**Status:** Approved (pending written-spec review)
**Author:** Brainstorming session (Devin + user)

## Summary

Add a classic TV-guide **grid view** (channels as rows × time as horizontal axis) to the
IPTV player. It coexists with the existing single-channel EPG sidebar and is opened on
demand via a **"Guide"** toggle. The grid shows the **current live category**, covering a
**past+future window** (past extent = provider `catchup_days`), and lets the user **smart-play**
any program: live now → play channel live, past + catchup → timeshift, future → details only.
All playback reuses the existing internal/MPV auto-routing (Always-MPV honored).

EPG data for **all live channels** is prefetched during the existing account sync via a single
**XMLTV dump** (`xmltv.php`), parsed and cached in IndexedDB, and refreshed manually via a
**Refresh** button (no TTL/background refresh).

This feature is **Xtream-only**; the Guide toggle is hidden/disabled for M3U playlists.

## Background / Current State

- Existing EPG is a vertical right-hand **sidebar** (`#live-epg-container` / `#epg-list`),
  populated per channel via `fetchXtreamApi(account, 'get_simple_data_table', { stream_id })`
  in `loadEpgSidebar()` (`renderer.js`). Titles/descriptions are base64-encoded.
- Catchup/timeshift already works: `playTimeshift(listing, streamId)` builds a
  `/timeshift/<user>/<pass>/<mins>/<start>/<streamId>.ts` URL; archive items also offer MPV
  and a right-click context menu.
- `live_streams` records (db.js `saveStreams`) currently store `name`, `logo`, `catchup`,
  `catchupDays` — but **not** `epg_channel_id`.
- Xtream API requests are proxied through the main process at
  `http://127.0.0.1:18080/xtream/api` (`handleXtreamApiRequest` in `main.js`, routed by
  `reqUrl.pathname`).
- IPC bridge is `preload.js` via `contextBridge.exposeInMainWorld('electronAPI', …)`.
- IndexedDB is at `dbVersion: 2` (db.js), object stores keyed by compound keys with an
  `accountId` index.
- The renderer is a Chromium context, so `DOMParser` and Web Workers are available.

## Decisions (from interview)

| Topic | Decision |
|---|---|
| Role vs sidebar | **Coexist** — sidebar stays; grid is an on-demand overview. |
| Channel scope | **Current live category.** |
| Data source | **XMLTV dump** prefetched on full sync, cached in IndexedDB (Approach B). |
| Time window | **Past+future**; past extent = provider `catchup_days`. Catchup playable from grid. |
| Click behavior | **Smart by time**, reusing existing internal/MPV routing. |
| Open/display | **Replace central area** (Approach A: also hide left channel pane; grid full width). |
| Prefetch | During the existing **full account sync**. |
| Freshness | **Manual Refresh button** + full sync. No TTL/auto-refresh. |
| Layout consistency | **Hide left pane while Guide open** (Approach A); grid owns its channel column. |
| XML parsing | **Renderer Web Worker + `DOMParser`** (no new dependency, non-blocking). |

## Architecture

```
Full sync (renderer)                Main process              Provider
  syncAllData()                     /xtream/xmltv  --GET-->   xmltv.php
   ├─ get_live_streams (+epgChannelId persisted)
   └─ fetch /xtream/xmltv  <----- raw XMLTV string ----------
        │
        ▼
  epg-worker.js (DOMParser)  → { channelId: [programmes] }
        │
        ▼
  IPTVDb.saveEpg() → epg_programmes (1 record/channel) + epg_meta

Guide toggle (renderer)
  hide left pane + player area → render #epg-grid-container
   rows  = getStreamsByCategory('live_streams', acct, currentCat)  (join via epgChannelId)
   cells = programmes positioned by start/stop (px per minute)
   click = smart play → existing internal/MPV routing
   Refresh button → re-run fetch → worker → saveEpg → re-render
```

## Components

### 1. Data model — IndexedDB v2 → v3 (db.js)

- Bump `dbVersion` to `3`. In `onupgradeneeded`, create:
  - **`epg_programmes`**: `keyPath: 'compoundKey'` where `compoundKey = ${accountId}_${epgChannelId}`.
    Value: `{ compoundKey, accountId, epgChannelId, programmes: [ { start, stop, title, desc, category } ] }`,
    `programmes` sorted ascending by `start` (epoch seconds). Index `accountId`.
  - **`epg_meta`**: `keyPath: 'accountId'`. Value `{ accountId, lastFetched, channelCount, programmeCount }`.
- Extend `saveStreams` live branch: `record.epgChannelId = item.epg_channel_id || null`.
  (No migration needed — re-populated on next sync.)
- New methods:
  - `saveEpg(accountId, channelMap)` — bulk `put` one record per channel into `epg_programmes`,
    plus a single `epg_meta` record. Wrapped in one transaction.
  - `getEpgForChannels(accountId, epgChannelIds[])` — returns map `epgChannelId → programmes`.
  - `getEpgMeta(accountId)` — for the "last updated" label.
  - Add `epg_programmes`/`epg_meta` to `clearAccountCache` store list.

### 2. Main process — XMLTV proxy (main.js)

- Add route: `else if (reqUrl.pathname === '/xtream/xmltv') handleXtreamXmltvRequest(req, res, reqUrl);`
- `handleXtreamXmltvRequest(req, res, reqUrl)`: read `host`, `username`, `password` from query
  (mirroring `handleXtreamApiRequest`), build
  `http(s)://<host>/xmltv.php?username=<u>&password=<p>`, fetch, and **stream/pipe** the raw XML
  body back with `Content-Type: application/xml`. On upstream error or non-200, respond JSON
  `{ error }` with the appropriate status (non-fatal to caller).
- No new npm dependency in the main process.

### 3. XMLTV parsing — worker + pure function

- **`epg-worker.js`** (new Web Worker): receives `{ xml }`, runs `parseXmltv(xml)`, posts back
  `{ channelMap }` or `{ error }`.
- **`parseXmltv(xmlString)`** — pure, testable module (e.g. `epg-parse.js`):
  - Parse with `DOMParser` (`text/xml`).
  - Build `channelMap`: for each `<programme>`, read `channel`, `start`, `stop`, `<title>`,
    `<desc>`, `<category>`; convert XMLTV time `YYYYMMDDHHMMSS ±ZZZZ` to epoch seconds; push to
    `channelMap[channel]`. Sort each array by `start`.
  - Robust to: missing `<desc>`/`<category>`, missing/blank timezone offset (assume local or +0000
    consistently — see Open Questions), malformed/empty input → return `{}` without throwing.
  - Note: XMLTV text is **plain** (not base64), unlike `get_simple_data_table`.
- The worker keeps the (multi-MB) parse off the UI thread.

### 4. Sync + refresh (renderer.js)

- In `syncAllData`, after `saveStreams('live_streams', …)`:
  - Set loader text `"Syncing TV Guide…"`.
  - `fetch('http://127.0.0.1:18080/xtream/xmltv?…')` → text → post to `epg-worker` → on result
    `IPTVDb.saveEpg(accountId, channelMap)`.
  - **Non-fatal:** any failure (404/no `xmltv.php`, parse error) logs a warning and lets sync
    complete; the grid later shows a "no guide data" state.
- **Refresh button** (in grid header) runs the same fetch → worker → `saveEpg` → re-render, with
  an inline spinner and updated "last updated" label from `epg_meta`.

### 5. Renderer — grid UI (Approach A)

- **Markup:** new `#epg-grid-container` in the central area (sibling of the player area), hidden
  by default. A **"Guide"** toggle button in the control/tab bar.
- **Toggle behavior:** opening hides the **left channel pane** and the **player area**; the grid
  spans the full content width. Audio keeps playing in the background. Toggling off or pressing
  **Esc** restores the previous layout. Toggle is hidden/disabled when `activePlaylistType !== 'xtream'`.
- **Structure:**
  - Sticky **channel column** (left): logo + name per row, rendered from the same channel data and
    row styling used by the sidebar for visual consistency.
  - Sticky **time header** (top): hour ticks across the window.
  - Scroll: horizontal across time, vertical across channels; channel column and time header stay pinned.
- **Rows:** `getStreamsByCategory('live_streams', activeAccount.id, currentLiveCategory)`,
  joined to programmes via `epgChannelId` (`getEpgForChannels`).
- **Time window:** start = `now - max(catchupDays across visible channels)`; end = latest programme
  `stop` in the window. Scale = fixed **px per minute**; each program is an absolutely-positioned
  block (`left` = offset from window start, `width` = duration).
- **Visual states:** vertical **now-line**; **current** program highlighted; past blocks where the
  channel has catchup and `start` is within that channel's `catchupDays` get **archive** styling.
- **Empty/edge:** channel without `epgChannelId` or with no programmes → row placeholder
  ("Keine Programmdaten"). No EPG cached at all → full-grid empty state with a Refresh hint.

### 6. Interaction — smart click (reuses existing routing)

For a clicked program on channel `streamId`, `now = Date.now()/1000`:
- **Live** (`start ≤ now < stop`): play the channel **live** via the existing channel-play path →
  honors Always-MPV / internal auto-routing.
- **Past + catchup** (`stop < now` && channel.catchup && within `catchupDays`):
  `playTimeshift(listing, streamId)` (existing) → same routing.
- **Future** (`start > now`): show a small **details popover** (title, desc, time). No playback.
- **Right-click:** existing `showContextMenu(name, url)` (MPV/external), matching the sidebar.

The grid maps XMLTV programmes to the shape `playTimeshift` expects (`start_timestamp`,
`stop_timestamp`/`end_timestamp`, base64 `title`) — provide a small adapter so the existing
timeshift URL builder and the sidebar stay unchanged.

### 7. Styling (style.css)

- New grid styles consistent with the cyberpunk-glassmorphism theme: container, channel column,
  time header, program blocks, current/now-line/archive states, header bar with Refresh + "last
  updated". Reuse existing CSS variables (`--accent-cyan`, `--text-muted`, etc.).

## Data Flow Summary

1. **Sync:** save live streams (now incl. `epgChannelId`) → fetch XMLTV dump → worker parse →
   `saveEpg` → `epg_meta`.
2. **Open Guide:** hide left pane + player → load category channels → join cached programmes →
   render grid.
3. **Click:** classify by time → live play / timeshift / details, via existing routing.
4. **Refresh:** re-fetch → worker → `saveEpg` → re-render; update "last updated".

## Error Handling

- **No `xmltv.php` / upstream error:** main returns JSON error; renderer logs warning; sync still
  completes; grid shows empty state + Refresh hint.
- **Parse failure / malformed XML:** `parseXmltv` returns `{}`; treated as "no guide data".
- **Channel without programmes / `epgChannelId`:** per-row placeholder.
- **M3U active:** Guide toggle hidden/disabled.
- **Worker unsupported / errors:** fall back to parsing on the main renderer thread (one-time,
  during a loader) so the feature still functions.

## Testing

- **Unit (`parseXmltv`)** — runnable with node:
  - Well-formed multi-channel/multi-programme dump → correct grouping + sort.
  - Missing `<desc>`/`<category>`.
  - Timezone offsets (`+0000`, `+0200`, missing) → correct epoch conversion.
  - Empty string / malformed XML → `{}`, no throw.
- **Syntax:** `node -c main.js && node -c renderer.js`.
- **Manual:**
  - Open Guide → left pane + player hide, grid full width; Esc restores.
  - Scroll horizontal/vertical with pinned column + header; now-line position correct.
  - Click live → live play; past+catchup → timeshift; future → details popover; both internal and
    Always-MPV modes.
  - Refresh updates data + "last updated".
  - M3U playlist → Guide hidden.
  - Provider without `xmltv.php` → empty state, sync still succeeds.
- **Quality:** `fallow health --file-scores` after implementation (per CLAUDE.md).

## Out of Scope (YAGNI)

- Reminders / scheduled recording.
- All-channels (cross-category) mega-grid.
- TTL / background auto-refresh.
- Per-category deep `get_simple_data_table` backfill (Approach C) — structure the data layer so it
  can be added later without rework.

## Open Questions (resolve during implementation)

- **Timezone handling:** XMLTV times carry an explicit offset; convert to epoch using that offset.
  If an offset is ever absent, decide on a single consistent assumption (UTC) and document it.
- **px-per-minute scale + default scroll position** (e.g., open scrolled to now-line): pick sensible
  defaults, tune during manual testing.
