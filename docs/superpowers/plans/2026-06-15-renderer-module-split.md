# renderer.js Module Split Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Split `renderer.js` (2514 lines, 34 CRAP violations) into four focused module files loaded via `<script>` tags, plus fix two known duplication hotspots in the files we touch.

**Architecture:** Plain browser globals — no bundler. Each new `renderer-*.js` file is loaded as a classic `<script>` before `renderer.js`. All files share the same `window` scope, so state declared in one file is visible to all later-loaded files. Load order: `renderer-state.js` → `renderer-playback.js` → `renderer-xtream.js` → `renderer-epg.js` → `renderer.js`.

**Tech Stack:** Vanilla JS, Electron renderer process, mpegts.js, IndexedDB via `IPTVDb` (db.js), `window.electronAPI` (preload.js)

---

## File Map

| File | Action | Lines (est.) | Responsibility |
|------|--------|-------------|----------------|
| `renderer-state.js` | **Create** | ~100 | All DOM refs + shared mutable state vars |
| `renderer-playback.js` | **Create** | ~380 | `playChannel`, `loadStream`, `destroyPlayer`, `stopPlayback`, `handlePlayError`, `formatTime`, all `setup*` player control helpers, `setupTranscodeStatusListener`, `setupMpvIntegrations`, `updateAlwaysMpvButtonState` |
| `renderer-xtream.js` | **Create** | ~500 | `setupAccountsModal`, `setupM3uModal`, `setupGlobalModalDismissal`, `showAccountsModal`, `loadAccountsList`, `clearEditState`, `setActiveXtreamAccount`, `connectXtreamAccount`, `openSyncDialog`, IIFE sync dialog setup, `runScopedSync`, `fetchXtreamApi`, `loadXtreamSidebar`, `getAccountBaseUrl`, `handleXtreamClick`, `loadSeriesEpisodes`, `renderEpisodesGrid`, `restoreLastStream`, `restoreLastState` |
| `renderer-epg.js` | **Create** | ~560 | `fetchAndStoreEpg`, `parseXmltvAsync`, EPG grid constants/vars, `openEpgGrid`, `closeEpgGrid`, `populateEpgGridCategory`, drag-scroll IIFE, `epgFormatClock`, `renderEpgGrid`, `epgToListing`, `playEpgLive`, `handleEpgProgramClick`, `epgContextMenu`, `showEpgDetails`, `safeBase64Decode`, `formatTimeshiftDate`, `loadEpgSidebar`, `playTimeshift` |
| `renderer.js` | **Shrink** | ~300 | DOM init block, `loadPresetChannels`, `parseM3U`, `updateCategories`, `renderChannelList`, `filterChannels`, `fetchPlaylist`, `resetStatus`, `setupEventListeners`, `defaultChannels` preset array |
| `index.html` | **Modify** | — | Add 4 new `<script>` tags before `renderer.js` |

---

## Task 1: Create `renderer-state.js`

**Files:**
- Create: `renderer-state.js`
- Read first: `renderer.js` lines 1–111

Move all DOM `const` declarations (lines 2–80) and all shared mutable `let`/`const` state variables (lines 85–111) into `renderer-state.js`. Leave nothing behind in renderer.js — these declarations will now be globals available to all scripts.

- [ ] **Step 1: Create `renderer-state.js`** with the following content (cut from renderer.js lines 2–111):

```js
// DOM Elements
const m3uUrlInput = document.getElementById('m3u-url');
const btnLoadUrl = document.getElementById('btn-load-url');
const m3uFileInput = document.getElementById('m3u-file');
const channelSearch = document.getElementById('channel-search');
const categoryFilter = document.getElementById('category-filter');
const channelList = document.getElementById('channel-list');
const channelCount = document.getElementById('channel-count');

const activeChannelName = document.getElementById('active-channel-name');
const activeChannelGroup = document.getElementById('active-channel-group');
const activeLogoContainer = document.getElementById('active-logo-container');
const statusDot = document.getElementById('status-dot');
const statusText = document.getElementById('status-text');
const playbackBadge = document.getElementById('playback-badge');

const videoPlayer = document.getElementById('video-player');
const videoContainer = document.getElementById('video-container');
const loaderOverlay = document.getElementById('loader-overlay');
const loaderText = document.getElementById('loader-text');
const playbackErrorOverlay = document.getElementById('playback-error-overlay');
const playbackErrorText = document.getElementById('playback-error-text');
const btnCloseError = document.getElementById('btn-close-error');

const ctrlPlay = document.getElementById('ctrl-play');
const ctrlStop = document.getElementById('ctrl-stop');
const ctrlMute = document.getElementById('ctrl-mute');
const ctrlVolume = document.getElementById('ctrl-volume');
const ctrlFullscreen = document.getElementById('ctrl-fullscreen');
const ctrlMpv = document.getElementById('ctrl-mpv');
const ctrlPlayerOnly = document.getElementById('ctrl-player-only');
const appContainer = document.querySelector('.app-container');

// Check if browser/Chromium has native HEVC hardware decoding enabled
const supportsHEVC = document.createElement('video').canPlayType('video/mp4; codecs="hvc1.1.1.L120.B0"') !== '';
console.log('[HEVC Check] Native browser HEVC support:', supportsHEVC);

// Xtream Codes UI elements
const sidebarTabs = document.getElementById('sidebar-tabs');
const tabButtons = document.querySelectorAll('.tab-btn');
const timelineContainer = document.getElementById('timeline-container');
const timeCurrent = document.getElementById('time-current');
const timeDuration = document.getElementById('time-duration');
const seekBar = document.getElementById('seek-bar');

const episodesContainer = document.getElementById('episodes-container');
const seriesCover = document.getElementById('series-cover');
const seriesTitle = document.getElementById('series-title');
const seriesPlot = document.getElementById('series-plot');
const seasonSelect = document.getElementById('season-select');

// EPG and Timeshift variables
let isTimeshiftActive = false;
let timeshiftProgramInfo = null;
let currentLiveChannelUrl = null;
let currentLiveChannelName = null;
let currentLiveChannelGroup = null;
let currentLiveChannelLogo = null;
let currentEpgListings = [];
let currentLiveChannelId = null;

const liveEpgContainer = document.getElementById('live-epg-container');
const epgList = document.getElementById('epg-list');
const ctrlBackToLive = document.getElementById('ctrl-back-to-live');
const episodesGrid = document.getElementById('episodes-grid');

const accountsModal = document.getElementById('accounts-modal');
const btnCloseModal = document.getElementById('btn-close-modal');
const accountsList = document.getElementById('accounts-list');
const accountForm = document.getElementById('account-form');

const btnToggleGuide = document.getElementById('btn-toggle-guide');
const btnEpgClose = document.getElementById('btn-epg-close');
const epgGridContainer = document.getElementById('epg-grid-container');
const epgGridScroll = document.getElementById('epg-grid-scroll');
const epgGridUpdated = document.getElementById('epg-grid-updated');
const epgGridCategory = document.getElementById('epg-grid-category');
const accountFormTitle = document.getElementById('account-form-title');
const btnSaveAccount = document.getElementById('btn-save-account');
const btnCancelEdit = document.getElementById('btn-cancel-edit');

const m3uModal = document.getElementById('m3u-modal');
const btnCloseM3uModal = document.getElementById('btn-close-m3u-modal');

// State Variables
let channels = [];
let categories = new Set();
let mpegtsPlayer = null;

let activePlaylistType = 'm3u'; // 'm3u' or 'xtream'
let activeAccount = null;
let activeTab = 'live'; // 'live', 'vod', 'series'
let activeStreamUrl = '';
let seekOffset = 0;
let isSeeking = false;
let vodDuration = 0;
let activeSeriesData = null;
let streamLoadTimeout = null;
let seekDebounceTimeout = null;
let editingAccountId = null;
let controlsTimeout = null;

// MPV playback state
let isAlwaysMpvEnabled = localStorage.getItem('alwaysUseMpv') === 'true';
let isMpvActive = false;

const btnToggleAlwaysMpv = document.getElementById('btn-toggle-always-mpv');
const mpvStatusBar = document.getElementById('mpv-status-bar');
const mpvStatusText = document.getElementById('mpv-status-text');
const btnMpvStop = document.getElementById('btn-mpv-stop');
const btnMpvInternal = document.getElementById('btn-mpv-internal');
```

- [ ] **Step 2: Delete lines 2–111 from `renderer.js`** (the exact same block just moved). Keep only the `window.addEventListener('DOMContentLoaded', ...)` init block and everything below it.

- [ ] **Step 3: Verify `renderer.js` now starts at the `// Preset Channels` comment (line ~190 in original numbering).**

---

## Task 2: Create `renderer-playback.js`

**Files:**
- Create: `renderer-playback.js`
- Modify: `renderer.js` (delete moved functions)

Move these functions from `renderer.js` into `renderer-playback.js` (in this order):

- `updateAlwaysMpvButtonState` (orig L113)
- `setEpgContainerDisplay` (orig L124)
- `setupMpvIntegrations` (orig L139)
- `playChannel` (orig L602)
- `loadStream` (orig L671)
- `handlePlayError` (orig L838)
- `destroyPlayer` (orig L847)
- `stopPlayback` (orig L872)
- `setupPlayerControls` (orig L901)
- `setupBasicPlaybackControls` (orig L909)
- `setupViewModeToggles` (orig L959)
- `setupExternalMpvPlayer` (orig L977)
- `setupTimelineSeeking` (orig L992)
- `setupControlAutohide` (orig L1043)
- `formatTime` (orig L1067)
- `setupTranscodeStatusListener` (orig L1075)

Also fix the **`dup:7073d96d`** duplication: the "reset to LIVE" block appears identically in `handleXtreamClick` (renderer.js L1688–1697) and in `playEpgLive` (renderer.js L2256–2268). Extract it into a helper `resetToLive()` in `renderer-playback.js`:

```js
function resetToLive() {
  isTimeshiftActive = false;
  if (ctrlBackToLive) {
    ctrlBackToLive.style.display = 'none';
  }
  const streamInfo = document.getElementById('stream-info');
  if (streamInfo) {
    streamInfo.textContent = 'LIVE';
    streamInfo.style.background = 'red';
    streamInfo.style.boxShadow = '0 0 8px rgba(255, 0, 0, 0.4)';
  }
}
```

- [ ] **Step 1: Create `renderer-playback.js`** — cut all 16 functions listed above from `renderer.js` and paste them verbatim into `renderer-playback.js`.

- [ ] **Step 2: Add `resetToLive()` helper** at the top of `renderer-playback.js` (before `updateAlwaysMpvButtonState`).

- [ ] **Step 3: Replace the duplicate reset block in `handleXtreamClick`** (in renderer.js, around where it sets `currentLiveChannelLogo`):

  Old block (appears twice; this is the one in `handleXtreamClick`):
  ```js
  isTimeshiftActive = false;
  
  if (ctrlBackToLive) {
    ctrlBackToLive.style.display = 'none';
  }
  
  const streamInfo = document.getElementById('stream-info');
  if (streamInfo) {
    streamInfo.textContent = 'LIVE';
    streamInfo.style.background = 'red';
    streamInfo.style.boxShadow = '0 0 8px rgba(255, 0, 0, 0.4)';
  }
  ```
  Replace with: `resetToLive();`

- [ ] **Step 4: Replace the duplicate reset block in `playEpgLive`** (in renderer-epg.js once it exists — for now note this; done in Task 4 Step 3).

- [ ] **Step 5: Delete all 16 moved function bodies from `renderer.js`.**

---

## Task 3: Create `renderer-xtream.js`

**Files:**
- Create: `renderer-xtream.js`
- Modify: `renderer.js` (delete moved functions)

Move these from `renderer.js` into `renderer-xtream.js` (in this order):

- `clearEditState` (orig L1111)
- `setupAccountsModal` (orig L1121)
- `setupM3uModal` (orig L1214)
- `setupGlobalModalDismissal` (orig L1230)
- `showAccountsModal` (orig L1259)
- `loadAccountsList` (orig L1264)
- `setActiveXtreamAccount` (orig L1344)
- `connectXtreamAccount` (orig L1363)
- `openSyncDialog` (orig L1460) — includes `let syncTargetAccount = null;` declaration at L1458
- Sync dialog IIFE `(function setupSyncDialog() { ... })();` (orig L1484)
- `runScopedSync` (orig L1519)
- `fetchXtreamApi` (orig L1606)
- `loadXtreamSidebar` (orig L1625)
- `getAccountBaseUrl` (orig L1670)
- `handleXtreamClick` (orig L1676) — after applying the `resetToLive()` substitution from Task 2 Step 3
- `loadSeriesEpisodes` (orig L1717)
- `renderEpisodesGrid` (orig L1790)
- `restoreLastStream` (orig L1838)
- `restoreLastState` (orig L1850)

- [ ] **Step 1: Create `renderer-xtream.js`** — cut all 19 items above from `renderer.js` and paste verbatim into `renderer-xtream.js`.

- [ ] **Step 2: Delete all moved items from `renderer.js`.**

---

## Task 4: Create `renderer-epg.js`

**Files:**
- Create: `renderer-epg.js`
- Modify: `renderer.js` (delete moved block)

Move from `renderer.js` into `renderer-epg.js`:

- `fetchAndStoreEpg` (orig L1914)
- `parseXmltvAsync` (orig L1938)
- EPG constants/vars: `const EPG_PX_PER_MIN = 5;`, `const EPG_CHAN_WIDTH = 200;`, `let epgNowLineTimer = null;`, `let epgWindowStart = 0;` (orig L1985–1988)
- `openEpgGrid` (orig L1990)
- `populateEpgGridCategory` (orig L1998)
- `closeEpgGrid` (orig L2020)
- Drag-scroll IIFE `if (epgGridScroll) { ... }` (orig L2028–2049)
- `epgFormatClock` (orig L2051)
- `renderEpgGrid` (orig L2055)
- `epgToListing` (orig L2242)
- `playEpgLive` (orig L2250)
- `handleEpgProgramClick` (orig L2274)
- `epgContextMenu` (orig L2286)
- `showEpgDetails` (orig L2299)
- `safeBase64Decode` (orig L2304)
- `formatTimeshiftDate` (orig L2313)
- `loadEpgSidebar` (orig L2323)
- `playTimeshift` (orig L2489)

Also fix **`dup:5c552dfe`**: the timeshift URL build block is duplicated at L2443–2448 and L2462–2467 inside `loadEpgSidebar`. Extract a helper into `renderer-epg.js`:

```js
function buildTimeshiftUrl(listing, streamId) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  const durationMins = Math.floor((Number(listing.stop_timestamp || listing.end_timestamp) - Number(listing.start_timestamp)) / 60) || 60;
  const startFormatted = formatTimeshiftDate(listing.start_timestamp);
  return `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
}
```

Also apply the **`resetToLive()` substitution from Task 2** in `playEpgLive`: replace the duplicate reset block there with `resetToLive();`.

- [ ] **Step 1: Create `renderer-epg.js`** — cut all items above from `renderer.js` and paste verbatim.

- [ ] **Step 2: Add `buildTimeshiftUrl(listing, streamId)` helper** near the top of `renderer-epg.js` (before `fetchAndStoreEpg`).

- [ ] **Step 3: Apply `resetToLive()` in `playEpgLive`** inside `renderer-epg.js`. Find the duplicate LIVE reset block and replace it with `resetToLive();`.

- [ ] **Step 4: Replace the two duplicate timeshift URL build blocks** inside `loadEpgSidebar` in `renderer-epg.js`. Each occurrence of:
  ```js
  const baseUrl = getAccountBaseUrl(activeAccount);
  const durationMins = Math.floor((Number(listing.stop_timestamp || listing.end_timestamp) - Number(listing.start_timestamp)) / 60) || 60;
  const startFormatted = formatTimeshiftDate(listing.start_timestamp);
  const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
  ```
  Replace with: `const url = buildTimeshiftUrl(listing, streamId);`

- [ ] **Step 5: Delete all moved items from `renderer.js`.**

---

## Task 5: Update `index.html` and verify `renderer.js` residual

**Files:**
- Modify: `index.html`
- Verify: `renderer.js` (should now be ~300 lines: init block + M3U functions + channel list/filter + event wiring)

- [ ] **Step 1: Add 4 new `<script>` tags to `index.html`** in the correct load order, before the existing `renderer.js` tag:

  Current block in `index.html`:
  ```html
  <script src="node_modules/mpegts.js/dist/mpegts.js"></script>
  <script src="db.js"></script>
  <script src="epg-parse.js"></script>
  <script src="renderer.js"></script>
  ```

  Replace with:
  ```html
  <script src="node_modules/mpegts.js/dist/mpegts.js"></script>
  <script src="db.js"></script>
  <script src="epg-parse.js"></script>
  <script src="renderer-state.js"></script>
  <script src="renderer-playback.js"></script>
  <script src="renderer-xtream.js"></script>
  <script src="renderer-epg.js"></script>
  <script src="renderer.js"></script>
  ```

- [ ] **Step 2: Verify `renderer.js` line count** — should be roughly 280–350 lines. Run:
  ```bash
  wc -l renderer.js renderer-state.js renderer-playback.js renderer-xtream.js renderer-epg.js
  ```
  Total should be close to 2514. No function should exist in two files.

- [ ] **Step 3: Syntax-check all files:**
  ```bash
  node -c renderer-state.js && node -c renderer-playback.js && node -c renderer-xtream.js && node -c renderer-epg.js && node -c renderer.js
  ```
  Expected: each file prints `OK`.

---

## Task 6: Smoke test and commit

- [ ] **Step 1: Run the app:**
  ```bash
  npm start
  ```
  Verify: app launches, no console errors on startup, default preset channels load.

- [ ] **Step 2: Manual smoke checks:**
  - Load a preset channel → plays
  - Open Accounts modal → renders account list
  - Open EPG grid (if account connected) → renders
  - Timeshift click → plays archive stream
  - MPV toggle → state persists

- [ ] **Step 3: Run syntax check one more time for confidence:**
  ```bash
  node -c main.js && node -c renderer.js && node -c renderer-state.js && node -c renderer-playback.js && node -c renderer-xtream.js && node -c renderer-epg.js
  ```

- [ ] **Step 4: Run fallow health to confirm CRAP improvement:**
  ```bash
  FALLOW_AGENT_SOURCE=windsurf fallow health --file-scores --format json --quiet 2>/dev/null | python3 -c "
  import json,sys
  d=json.load(sys.stdin)
  for f in d['file_scores']:
      print(f\"{f['path']:<30} MI={f['maintainability_index']}  CRAP-violations={f['crap_above_threshold']}\")
  "
  ```

- [ ] **Step 5: Commit:**
  ```bash
  git add renderer-state.js renderer-playback.js renderer-xtream.js renderer-epg.js renderer.js index.html
  git commit -m "refactor(renderer): split 2514-line renderer.js into 5 focused modules

  - renderer-state.js: DOM refs + shared mutable state
  - renderer-playback.js: player, controls, MPV, transcode listener
  - renderer-xtream.js: accounts, sync, sidebar, series, state restore
  - renderer-epg.js: EPG grid, timeshift, catchup, XMLTV parse
  - renderer.js: M3U, channel list, filter, event wiring, init

  Also extract resetToLive() helper (dup:7073d96d) and
  buildTimeshiftUrl() helper (dup:5c552dfe) to eliminate
  two clone groups found by fallow dupes.

  Generated with Devin (https://cli.devin.ai/docs)

  Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>"
  ```
