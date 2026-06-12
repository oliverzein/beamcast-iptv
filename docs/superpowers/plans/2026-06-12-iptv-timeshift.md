# IPTV Timeshift & EPG Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement server-side Timeshift and EPG sidebar in the IPTV Player using Xtream Codes APIs.

**Architecture:** Fetch short EPG via proxy, display EPG sidebar next to the video player, calculate timeshift parameters on click, and run the stream through the transcoding proxy with `isLive: false` to enable player-side seek/buffering controls.

**Tech Stack:** Electron, Node.js (spawn FFmpeg), HTML5, CSS (glassmorphism/flexbox), JavaScript (mpegts.js, IndexedDB).

---

### Task 1: Update Database Schema & Parse logic

**Files:**
- Modify: `db.js`
- Test: Create a temporary check script `test-db-update.js`

- [ ] **Step 1: Write a DB verify test script**

Create `test-db-update.js` in the project root:
```javascript
const IPTVDb = require('./db.js');
console.log("IndexedDB helper loaded successfully.");
```

- [ ] **Step 2: Run verification script**

Run: `node test-db-update.js`
Expected: Outputs "IndexedDB helper loaded successfully."

- [ ] **Step 3: Modify saveStreams in db.js**

Modify [db.js:170-173](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/db.js#L170-L173) to include `catchup` and `catchupDays`:
```javascript
        if (storeName === 'live_streams') {
          record.streamId = streamId;
          record.streamType = item.stream_type;
          record.catchup = item.catchup === 1 || item.catchup === '1' || item.catchup === true ? 1 : 0;
          record.catchupDays = parseInt(item.catchup_days) || 0;
        }
```

- [ ] **Step 4: Verify syntax and linting**

Run: `npx fallow`
Expected: No syntax errors.

- [ ] **Step 5: Commit (if auto_commit enabled)**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."

---

### Task 2: Update Main Process Proxy logic

**Files:**
- Modify: `main.js`
- Test: Create a verification script `test-proxy-timeshift.js`

- [ ] **Step 1: Create a timeshift detection check script**

Create `test-proxy-timeshift.js` in the project root:
```javascript
const path = require('path');
const url = require('url');

function isLiveUrl(streamUrl) {
  try {
    const parsed = url.parse(streamUrl);
    const pathname = (parsed.pathname || '').toLowerCase();
    
    if (pathname.includes('/timeshift/')) {
      return false; 
    }
    if (pathname.includes('/live/')) {
      return true;
    }
    return true;
  } catch (e) {
    return true;
  }
}

// Test cases
console.assert(isLiveUrl('http://host/live/user/pass/123.ts') === true, 'Live check failed');
console.assert(isLiveUrl('http://host/timeshift/user/pass/60/2026-06-12:12-00/123.ts') === false, 'Timeshift check failed');
console.log('Proxy test cases passed!');
```

- [ ] **Step 2: Run verification script**

Run: `node test-proxy-timeshift.js`
Expected: Outputs "Proxy test cases passed!"

- [ ] **Step 3: Update isLiveUrl in main.js**

Modify [main.js:96-108](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js#L96-L108) to recognize timeshift streams:
```javascript
function isLiveUrl(streamUrl) {
  try {
    const parsed = url.parse(streamUrl);
    const pathname = (parsed.pathname || '').toLowerCase();
    
    if (pathname.includes('/timeshift/')) {
      return false;
    }
    
    // Check Xtream Codes paths
    if (pathname.includes('/live/')) {
      return true;
    }
```

- [ ] **Step 4: Clean up test script**

Run: `rm test-proxy-timeshift.js`
Expected: File deleted.

- [ ] **Step 5: Commit (if auto_commit enabled)**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."

---

### Task 3: HTML EPG Sidebar & Controls

**Files:**
- Modify: `index.html`
- Test: Manually inspect index.html tags

- [ ] **Step 1: Update index.html for EPG list and "Back to Live" button**

Modify [index.html:73-86](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/index.html#L73-L86) to add the EPG container and back-to-live button:
Inside `<div class="player-frame">`:
```html
        <!-- Main video player container -->
        <div class="video-container" id="video-container">
          <video id="video-player" poster="assets/placeholder.png"></video>
          
          <!-- Custom Player Controls overlay -->
          <div class="custom-controls" id="custom-controls">
            <!-- VOD Seek Timeline (hidden for Live TV) -->
            <div class="timeline-container" id="timeline-container" style="display: none;">
              <span class="time-label" id="time-current">00:00:00</span>
              <input type="range" id="seek-bar" min="0" max="100" value="0">
              <span class="time-label" id="time-duration">00:00:00</span>
            </div>
            
            <div class="control-row">
              <button id="ctrl-play" class="ctrl-btn">▶</button>
              <button id="ctrl-stop" class="ctrl-btn">⏹</button>
              <div class="volume-container">
                <button id="ctrl-mute" class="ctrl-btn">🔊</button>
                <input type="range" id="ctrl-volume" min="0" max="1" step="0.05" value="1">
              </div>
              <div class="stream-info" id="stream-info">LIVE</div>
              <button id="ctrl-back-to-live" class="btn-sm btn-sm-primary" style="display: none; margin-left: 8px;">🔴 Back to Live</button>
              <button id="ctrl-mpv" class="ctrl-btn" title="Open in External MPV Player" style="margin-right: 6px; display: none;">🎬 MPV</button>
              <button id="ctrl-fullscreen" class="ctrl-btn">⛶</button>
              <button id="ctrl-player-only" class="ctrl-btn" title="Toggle Player Only View">📺</button>
            </div>
          </div>

          <!-- Loading Spinner overlay -->
          <div class="loader-overlay" id="loader-overlay">
            <div class="spinner"></div>
            <p id="loader-text">Decoding AC3 stream...</p>
          </div>

          <!-- Playback Error overlay -->
          <div class="error-overlay" id="playback-error-overlay" style="display: none; position: absolute; top: 0; left: 0; right: 0; bottom: 0; background: rgba(7, 9, 14, 0.9); backdrop-filter: blur(8px); flex-direction: column; align-items: center; justify-content: center; gap: 12px; z-index: 6; padding: 24px; text-align: center;">
            <div class="error-icon" style="font-size: 48px; filter: drop-shadow(0 0 10px rgba(255, 69, 58, 0.5));">⚠️</div>
            <h3 style="font-size: 18px; color: #ff453a; font-weight: 600;">Playback Error</h3>
            <p id="playback-error-text" style="font-size: 14px; color: var(--text-muted); max-width: 80%; line-height: 1.4;">Failed to decode stream. The stream might be offline or URL incorrect.</p>
            <button id="btn-close-error" class="btn-sm btn-sm-danger" style="margin-top: 10px;">Dismiss</button>
          </div>
        </div>

        <!-- Live TV EPG Sidebar (hidden by default) -->
        <div class="live-epg-container" id="live-epg-container" style="display: none;">
          <div class="epg-header">
            <h3>Programmübersicht</h3>
          </div>
          <ul class="epg-list" id="epg-list">
            <!-- EPG programs with timeshift options populated dynamically -->
          </ul>
        </div>
```

- [ ] **Step 2: Commit (if auto_commit enabled)**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."

---

### Task 4: CSS Styles for EPG Sidebar

**Files:**
- Modify: `style.css`
- Test: Manually inspect css file

- [ ] **Step 1: Append EPG sidebar styles to style.css**

Append the following styles to the end of [style.css](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/style.css):
```css
/* EPG Sidebar & Timeshift styles */
.live-epg-container {
  width: 320px;
  background: rgba(7, 9, 14, 0.45);
  border: 1px solid var(--border-color);
  border-radius: 16px;
  margin-left: 24px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.3);
  backdrop-filter: blur(12px);
  -webkit-backdrop-filter: blur(12px);
  height: 100%;
}

.epg-header {
  padding: 16px 20px;
  border-bottom: 1px solid var(--border-color);
  background: rgba(255, 255, 255, 0.01);
}

.epg-header h3 {
  font-size: 15px;
  font-weight: 600;
  color: #fff;
  margin: 0;
}

.epg-list {
  list-style: none;
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
  margin: 0;
}

.epg-item {
  padding: 12px;
  background: rgba(255, 255, 255, 0.01);
  border: 1px solid var(--border-color);
  border-radius: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  transition: all 0.2s ease;
}

.epg-item.has-catchup {
  cursor: pointer;
}

.epg-item.has-catchup:hover {
  background: rgba(0, 242, 254, 0.04);
  border-color: var(--accent-cyan);
  transform: translateX(2px);
}

.epg-item.playing {
  background: rgba(0, 122, 255, 0.1);
  border-color: var(--accent-blue);
  box-shadow: 0 0 8px rgba(0, 122, 255, 0.2);
}

.epg-title {
  font-size: 13px;
  font-weight: 600;
  color: #fff;
}

.epg-time {
  font-size: 11px;
  color: var(--text-muted);
}

.epg-desc {
  font-size: 11px;
  color: var(--text-muted);
  line-height: 1.4;
  margin-top: 4px;
}

.epg-badge {
  align-self: flex-start;
  font-size: 9px;
  font-weight: 700;
  padding: 2px 6px;
  border-radius: 4px;
  text-transform: uppercase;
  margin-top: 4px;
}

.epg-badge.archive {
  color: var(--accent-cyan);
  background: rgba(0, 242, 254, 0.1);
  border: 1px solid rgba(0, 242, 254, 0.2);
}

/* Adjust player-frame to lay out sidebar side-by-side */
.player-frame {
  display: flex;
  align-items: stretch;
  justify-content: center;
}

.app-container.player-only .live-epg-container {
  display: none !important;
}
```

- [ ] **Step 2: Commit (if auto_commit enabled)**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."

---

### Task 5: Renderer Integration & Timeshift Playback

**Files:**
- Modify: `renderer.js`
- Test: Verify with `npx fallow`

- [ ] **Step 1: Initialize states and elements**

At the top of [renderer.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js), declare global state variables:
```javascript
let isTimeshiftActive = false;
let timeshiftProgramInfo = null;
let currentLiveChannelUrl = null;
let currentLiveChannelName = null;
let currentLiveChannelGroup = null;
let currentLiveChannelLogo = null;
```
And retrieve the new DOM elements:
```javascript
const liveEpgContainer = document.getElementById('live-epg-container');
const epgList = document.getElementById('epg-list');
const ctrlBackToLive = document.getElementById('ctrl-back-to-live');
```

- [ ] **Step 2: Create base64 decode and date formatting helper functions**

Add helpers inside `renderer.js`:
```javascript
function safeBase64Decode(str) {
  if (!str) return "";
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return str;
  }
}

function formatTimeshiftDate(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  const hour = String(date.getUTCHours()).padStart(2, '0');
  const minute = String(date.getUTCMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}:${hour}-${minute}`;
}
```

- [ ] **Step 3: Modify playChannel to support timeline visibility in timeshift**

Modify [renderer.js:487-494](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js#L487-L494) to show the timeline seek bar if playing timeshift:
```javascript
  // Display Seek timeline for VOD, Series, or active Live Timeshift
  if ((activePlaylistType === 'xtream' && activeTab !== 'live') || isTimeshiftActive) {
    timelineContainer.style.display = 'flex';
    seekBar.value = 0;
    timeCurrent.textContent = '00:00:00';
    timeDuration.textContent = '00:00:00';
  } else {
    timelineContainer.style.display = 'none';
  }
```

- [ ] **Step 4: Update setupTimelineSeeking and loadStream**

Modify [renderer.js:746-770](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js#L746-L770) to allow seeking in timeshift:
```javascript
  videoPlayer.addEventListener('durationchange', () => {
    if ((activePlaylistType === 'xtream' && activeTab !== 'live') || isTimeshiftActive) {
      const playerDuration = videoPlayer.duration;
      if (playerDuration && isFinite(playerDuration) && playerDuration > 0) {
        if (!vodDuration || playerDuration > vodDuration) {
          vodDuration = Math.floor(playerDuration);
          seekBar.max = vodDuration;
          timeDuration.textContent = formatTime(vodDuration);
        }
      }
    }
  });

  videoPlayer.addEventListener('timeupdate', () => {
    if ((activePlaylistType === 'xtream' && activeTab !== 'live') || isTimeshiftActive) {
      const displayTime = seekOffset + videoPlayer.currentTime;
      timeCurrent.textContent = formatTime(displayTime);
      if (!isSeeking) {
        seekBar.value = Math.floor(displayTime);
      }
    }
  });
```

Modify `loadStream` around [renderer.js:502-506](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js#L502-L506) to disable `isLive` on mpegts player if timeshift is active:
```javascript
    const isLiveStream = (activePlaylistType === 'm3u' || activeTab === 'live') && !isTimeshiftActive;
```

- [ ] **Step 5: Write loadEpgSidebar and playTimeshift methods**

Add the EPG loading and timeshift playback functions:
```javascript
async function loadEpgSidebar(streamId, hasCatchup) {
  if (!liveEpgContainer || !epgList) return;
  
  if (activePlaylistType !== 'xtream') {
    liveEpgContainer.style.display = 'none';
    return;
  }

  liveEpgContainer.style.display = 'flex';
  epgList.innerHTML = '<div class="empty-list-placeholder">Lade Programmübersicht...</div>';
  
  try {
    const res = await fetchXtreamApi(activeAccount, 'get_short_epg', { stream_id: streamId });
    epgList.innerHTML = '';
    
    if (res && res.epg_listings && res.epg_listings.length > 0) {
      res.epg_listings.forEach(listing => {
        const item = document.createElement('li');
        item.className = 'epg-item';
        
        const title = safeBase64Decode(listing.title);
        const desc = safeBase64Decode(listing.description);
        
        // Format local times
        const startTimestamp = Number(listing.start_timestamp);
        const endTimestamp = Number(listing.end_timestamp);
        const startTimeStr = new Date(startTimestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        const endTimeStr = new Date(endTimestamp * 1000).toLocaleTimeString([], {hour: '2-digit', minute:'2-digit'});
        
        const timeSpan = document.createElement('div');
        timeSpan.className = 'epg-time';
        timeSpan.textContent = `${startTimeStr} - ${endTimeStr}`;
        item.appendChild(timeSpan);
        
        const titleSpan = document.createElement('div');
        titleSpan.className = 'epg-title';
        titleSpan.textContent = title;
        item.appendChild(titleSpan);
        
        if (desc) {
          const descSpan = document.createElement('div');
          descSpan.className = 'epg-desc';
          descSpan.textContent = desc;
          item.appendChild(descSpan);
        }
        
        const now = Math.floor(Date.now() / 1000);
        const hasArchive = hasCatchup && (endTimestamp < now);
        
        if (hasArchive) {
          item.classList.add('has-catchup');
          const badge = document.createElement('span');
          badge.className = 'epg-badge archive';
          badge.textContent = 'Archiv';
          item.appendChild(badge);
          
          item.addEventListener('click', () => {
            // Remove playing class from previous epg items
            const activeItems = epgList.querySelectorAll('.epg-item.playing');
            activeItems.forEach(el => el.classList.remove('playing'));
            item.classList.add('playing');
            
            playTimeshift(listing, streamId);
          });
        }
        
        epgList.appendChild(item);
      });
    } else {
      epgList.innerHTML = '<div class="empty-list-placeholder">Keine Programmdaten verfügbar.</div>';
    }
  } catch (e) {
    console.error("EPG fetch failed:", e);
    epgList.innerHTML = '<div class="empty-list-placeholder">Fehler beim Laden des EPGs.</div>';
  }
}

function playTimeshift(epgListing, streamId) {
  isTimeshiftActive = true;
  timeshiftProgramInfo = epgListing;
  
  const baseUrl = getAccountBaseUrl(activeAccount);
  const durationMins = Math.floor((Number(epgListing.end_timestamp) - Number(epgListing.start_timestamp)) / 60) || 60;
  const startFormatted = formatTimeshiftDate(epgListing.start_timestamp);
  
  const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
  
  const title = safeBase64Decode(epgListing.title);
  
  if (ctrlBackToLive) {
    ctrlBackToLive.style.display = 'inline-flex';
  }
  
  // Set custom stream-info text
  const streamInfo = document.getElementById('stream-info');
  if (streamInfo) {
    streamInfo.textContent = 'ARCHIV';
    streamInfo.style.background = 'var(--accent-cyan)';
    streamInfo.style.boxShadow = '0 0 8px rgba(0, 242, 254, 0.4)';
  }
  
  playChannel(`${currentLiveChannelName} (Archiv: ${title})`, 'Timeshift TV', currentLiveChannelLogo, url);
}
```

- [ ] **Step 6: Handle Back to Live button clicks & channel click resets**

Add listener for `ctrlBackToLive` in the init setup phase in `renderer.js`:
```javascript
  if (ctrlBackToLive) {
    ctrlBackToLive.addEventListener('click', () => {
      isTimeshiftActive = false;
      ctrlBackToLive.style.display = 'none';
      
      const streamInfo = document.getElementById('stream-info');
      if (streamInfo) {
        streamInfo.textContent = 'LIVE';
        streamInfo.style.background = 'red';
        streamInfo.style.boxShadow = '0 0 8px rgba(255, 0, 0, 0.4)';
      }
      
      // Clear playing class from EPG items
      if (epgList) {
        const activeItems = epgList.querySelectorAll('.epg-item.playing');
        activeItems.forEach(el => el.classList.remove('playing'));
      }
      
      playChannel(currentLiveChannelName, currentLiveChannelGroup, currentLiveChannelLogo, currentLiveChannelUrl);
    });
  }
```

Update `handleXtreamClick` around [renderer.js:1261-1264](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js#L1261-L1264) to record live stream parameters and trigger EPG load:
```javascript
  if (activeTab === 'live') {
    localStorage.setItem('lastSelectedId_live', item.streamId);
    const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${item.streamId}.ts`;
    
    // Save live details for "Back to Live"
    currentLiveChannelUrl = url;
    currentLiveChannelName = item.name;
    currentLiveChannelGroup = item.group || 'Live Channel';
    currentLiveChannelLogo = item.logo;
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

    playChannel(item.name, 'Live Channel', item.logo, url);
    
    // Load EPG Sidebar
    loadEpgSidebar(item.streamId, item.catchup === 1);
  }
```
And hide the EPG sidebar if VOD or Series are clicked:
```javascript
  } else if (activeTab === 'vod') {
    if (liveEpgContainer) liveEpgContainer.style.display = 'none';
    isTimeshiftActive = false;
    ...
  } else if (activeTab === 'series') {
    if (liveEpgContainer) liveEpgContainer.style.display = 'none';
    isTimeshiftActive = false;
    ...
  }
```

- [ ] **Step 7: Run static checker**

Run: `npx fallow`
Expected: Passes without warning or error.

- [ ] **Step 8: Commit (if auto_commit enabled)**

Check `.agent/config.yml` for `auto_commit` setting.
If `auto_commit: false`: skip commit and staging. Print: "Skipping commit (auto_commit: false)."
