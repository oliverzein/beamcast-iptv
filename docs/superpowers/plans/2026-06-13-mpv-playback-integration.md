# MPV Playback Integration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Integrate the external MPV player comfortably by supporting an "Always use MPV" toggle, sidebar/EPG-only mode when MPV is active, floating status bar controls, and direct-play buttons.

**Architecture:** Extend IPC bridge to synchronize MPV process lifetime (start/exit). Hide internal player container and collapse main window layout during MPV sessions.

**Tech Stack:** Electron (v31), HTML5, Vanilla CSS, Vanilla JavaScript (ES6).

---

### Task 1: Preload Gateway Update

**Files:**
- Modify: `preload.js`

- [ ] **Step 1: Write code changes**

Update [preload.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/preload.js#L16-L19) to add the new `openInMpv`, `stopMpv`, and `onMpvStatusChanged` handlers:

```javascript
  openInMpv: (streamUrl, streamName) => {
    ipcRenderer.send('open-in-mpv', { url: streamUrl, name: streamName });
  },
  stopMpv: () => {
    ipcRenderer.send('stop-mpv');
  },
  onMpvStatusChanged: (callback) => {
    ipcRenderer.on('mpv-status-changed', (event, data) => callback(data));
  },
```

- [ ] **Step 2: Run syntax check**

Run: `node -c preload.js`
Expected output: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add preload.js
git commit -m "feat(ipc): add MPV control and status APIs to preload bridge"
```

---

### Task 2: Main Process IPC and Subprocess Management

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Write code changes**

Modify `launchExternalPlayer` and replace the existing `open-in-mpv` handler in [main.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js#L493-L541):

```javascript
function launchExternalPlayer(streamUrl, streamName = 'Stream') {
  // 1. Kill active external player process if running
  if (activeExternalProcess) {
    console.log('Killing previous external player process');
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing previous external process:', e);
    }
    activeExternalProcess = null;
  }

  // 2. Kill active internal FFmpeg transcode process if running
  if (activeFfmpegProcess) {
    console.log('Killing active FFmpeg transcode process due to external player launch');
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing FFmpeg transcode process:', e);
    }
    activeFfmpegProcess = null;
  }

  // 3. Inform renderer that MPV is launching
  if (mainWindow) {
    mainWindow.webContents.send('stop-playback');
    mainWindow.webContents.send('mpv-status-changed', { active: true, name: streamName });
  }

  // 4. Launch MPV
  console.log(`Launching external player (mpv) for stream: ${streamUrl}`);
  const externalProcess = spawn('mpv', [streamUrl], {
    detached: true,
    stdio: 'ignore'
  });
  externalProcess.unref();

  activeExternalProcess = externalProcess;

  externalProcess.on('exit', () => {
    if (activeExternalProcess === externalProcess) {
      activeExternalProcess = null;
      if (mainWindow) {
        mainWindow.webContents.send('mpv-status-changed', { active: false });
      }
    }
  });
}
```

Add the IPC handlers for `open-in-mpv` (replacing the old one) and `stop-mpv`:

```javascript
ipcMain.on('open-in-mpv', (event, data) => {
  launchExternalPlayer(data.url, data.name);
});

ipcMain.on('stop-mpv', () => {
  if (activeExternalProcess) {
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {}
  }
});
```

- [ ] **Step 2: Run syntax check**

Run: `node -c main.js`
Expected output: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add main.js
git commit -m "feat(main): add MPV process tracking and status broadcasts"
```

---

### Task 3: HTML UI Components

**Files:**
- Modify: `index.html`

- [ ] **Step 1: Write code changes**

Add `#btn-toggle-always-mpv` inside `.top-bar-right` in [index.html](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/index.html#L61-L68):

```html
        <div class="top-bar-right" style="display: flex; align-items: center; gap: 12px;">
          <div id="playback-badge" class="playback-badge" style="display: none;"></div>
          <button id="btn-toggle-always-mpv" class="btn-sm btn-sm-secondary" style="display: flex; align-items: center; gap: 6px;">🎬 MPV Mode: OFF</button>
          <button id="btn-sync-xtream" class="btn-sm btn-sm-primary" style="display: none; align-items: center; gap: 6px;">🔄 Sync Cache</button>
```

Add `#mpv-status-bar` container at the bottom of the body (just before the closing `</body>` tag):

```html
  <!-- MPV status bar -->
  <div id="mpv-status-bar" class="mpv-status-bar" style="display: none;">
    <div class="mpv-status-content">
      <span class="pulse-dot green"></span>
      <span id="mpv-status-text">MPV playing: Stream</span>
    </div>
    <div class="mpv-status-actions">
      <button id="btn-mpv-stop" class="btn-sm btn-sm-danger">⏹ Stoppen</button>
      <button id="btn-mpv-internal" class="btn-sm btn-sm-primary">📺 Intern abspielen</button>
    </div>
  </div>
```

- [ ] **Step 2: Commit**

```bash
git add index.html
git commit -m "feat(ui): add Always-MPV toggle and bottom status bar markup"
```

---

### Task 4: Layout and Direct Buttons Styling

**Files:**
- Modify: `style.css`

- [ ] **Step 1: Write code changes**

Add styles for the MPV active layout state, status bar, and direct buttons at the end of [style.css](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/style.css):

```css
/* MPV Active Layout State */
.app-container.mpv-active .video-container {
  display: none !important;
}

.app-container.mpv-active:not(.epg-open) {
  grid-template-columns: 1fr;
}

.app-container.mpv-active:not(.epg-open) .main-content {
  display: none;
}

.app-container.mpv-active.epg-open .player-frame {
  padding: 0;
}

.app-container.mpv-active.epg-open .live-epg-container {
  width: 100%;
  max-width: 100%;
  border-left: none;
  height: calc(100vh - 80px);
}

/* Floating Status Bar */
.mpv-status-bar {
  position: fixed;
  bottom: 24px;
  left: 50%;
  transform: translateX(-50%);
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 24px;
  background: rgba(7, 9, 14, 0.75);
  border: 1px solid var(--border-color);
  backdrop-filter: blur(16px);
  -webkit-backdrop-filter: blur(16px);
  padding: 12px 24px;
  border-radius: 12px;
  box-shadow: 0 0 30px rgba(0, 240, 255, 0.15), inset 0 1px 0 rgba(255,255,255,0.05);
}

.mpv-status-content {
  display: flex;
  align-items: center;
  gap: 12px;
  font-size: 14px;
  font-weight: 500;
  color: var(--text-main);
  text-shadow: 0 0 5px rgba(255, 255, 255, 0.1);
}

.mpv-status-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}

/* Always MPV Toggle Neon States */
#btn-toggle-always-mpv.active {
  background: rgba(0, 242, 254, 0.15) !important;
  color: var(--accent-cyan) !important;
  border: 1px solid var(--accent-cyan) !important;
  box-shadow: 0 0 10px rgba(0, 242, 254, 0.4);
}

/* Direct Play Buttons */
.channel-list li .mpv-direct-btn,
.epg-item .mpv-direct-btn {
  display: none;
  background: rgba(0, 242, 254, 0.05);
  border: 1px solid rgba(0, 242, 254, 0.3);
  color: var(--accent-cyan);
  cursor: pointer;
  font-size: 11px;
  margin-left: auto;
  padding: 2px 6px;
  border-radius: 4px;
  transition: all 0.2s ease;
}

.channel-list li .mpv-direct-btn:hover,
.epg-item .mpv-direct-btn:hover {
  background: var(--accent-cyan);
  color: #000;
  box-shadow: 0 0 8px rgba(0, 242, 254, 0.5);
}

.channel-list li:hover .mpv-direct-btn,
.epg-item:hover .mpv-direct-btn {
  display: inline-block;
}
```

- [ ] **Step 2: Commit**

```bash
git add style.css
git commit -m "feat(ui): add layout, status bar, and direct-play CSS styles"
```

---

### Task 5: Renderer State and Event Logic

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Write code changes**

Expose status-bar and toggle elements at the top of [renderer.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js#L50-L70):

```javascript
// MPV playback state
let isAlwaysMpvEnabled = localStorage.getItem('alwaysUseMpv') === 'true';
let isMpvActive = false;

const btnToggleAlwaysMpv = document.getElementById('btn-toggle-always-mpv');
const mpvStatusBar = document.getElementById('mpv-status-bar');
const mpvStatusText = document.getElementById('mpv-status-text');
const btnMpvStop = document.getElementById('btn-mpv-stop');
const btnMpvInternal = document.getElementById('btn-mpv-internal');
```

Add helper functions to synchronize the toggle button class state and EPG visibility classes:

```javascript
function updateAlwaysMpvButtonState() {
  if (!btnToggleAlwaysMpv) return;
  if (isAlwaysMpvEnabled) {
    btnToggleAlwaysMpv.classList.add('active');
    btnToggleAlwaysMpv.textContent = '🎬 MPV Mode: ON';
  } else {
    btnToggleAlwaysMpv.classList.remove('active');
    btnToggleAlwaysMpv.textContent = '🎬 MPV Mode: OFF';
  }
}

function setEpgContainerDisplay(display) {
  if (!liveEpgContainer) return;
  liveEpgContainer.style.display = display;
  if (display === 'flex') {
    appContainer.classList.add('epg-open');
  } else {
    appContainer.classList.remove('epg-open');
  }
}
```

In [renderer.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js), replace all occurrences of `liveEpgContainer.style.display = 'none'` and `liveEpgContainer.style.display = 'flex'` with:
- `setEpgContainerDisplay('none')`
- `setEpgContainerDisplay('flex')`

Add the listeners for status change and UI actions in `initializeEventListeners` or at the bottom:

```javascript
function setupMpvIntegrations() {
  updateAlwaysMpvButtonState();

  if (btnToggleAlwaysMpv) {
    btnToggleAlwaysMpv.addEventListener('click', () => {
      isAlwaysMpvEnabled = !isAlwaysMpvEnabled;
      localStorage.setItem('alwaysUseMpv', isAlwaysMpvEnabled);
      updateAlwaysMpvButtonState();
    });
  }

  if (btnMpvStop) {
    btnMpvStop.addEventListener('click', () => {
      window.electronAPI.stopMpv();
    });
  }

  if (btnMpvInternal) {
    btnMpvInternal.addEventListener('click', () => {
      window.electronAPI.stopMpv();
      if (activeStreamUrl) {
        const tempAlways = isAlwaysMpvEnabled;
        isAlwaysMpvEnabled = false; // Bypass setting temporarily
        playChannel(activeChannelName.textContent, activeChannelGroup.textContent, currentLiveChannelLogo, activeStreamUrl);
        isAlwaysMpvEnabled = tempAlways;
      }
    });
  }

  window.electronAPI.onMpvStatusChanged((data) => {
    isMpvActive = data.active;
    if (data.active) {
      appContainer.classList.add('mpv-active');
      if (mpvStatusBar) {
        mpvStatusBar.style.display = 'flex';
        mpvStatusText.textContent = `MPV läuft: ${data.name}`;
      }
      // Auto-pause internal player
      if (!videoPlayer.paused) {
        videoPlayer.pause();
        ctrlPlay.textContent = "▶";
      }
    } else {
      appContainer.classList.remove('mpv-active');
      if (mpvStatusBar) {
        mpvStatusBar.style.display = 'none';
      }
    }
  });
}
```

Call `setupMpvIntegrations()` inside `document.addEventListener('DOMContentLoaded', ...)` or at startup in `renderer.js`.

Update the start of `playChannel` to check for `isAlwaysMpvEnabled`:

```javascript
function playChannel(name, group, logo, streamUrl) {
  if (isAlwaysMpvEnabled && !isMpvActive) {
    activeChannelName.textContent = name;
    activeChannelGroup.textContent = group || 'Live Stream';
    activeStreamUrl = streamUrl;
    window.electronAPI.openInMpv(streamUrl, name);
    return;
  }
  // Rest of playChannel...
```

- [ ] **Step 2: Run syntax check**

Run: `node -c renderer.js`
Expected output: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(renderer): implement MPV status changes, toggle settings, and auto-routing"
```

---

### Task 6: Direct Play Button Injection

**Files:**
- Modify: `renderer.js`

- [ ] **Step 1: Write code changes**

In [renderer.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js), modify EPG archive rendering to append an MPV button:

```javascript
        } else if (hasArchive) {
          item.classList.add('has-catchup');
          const badge = document.createElement('span');
          badge.className = 'epg-badge archive';
          badge.textContent = 'Archiv';
          item.appendChild(badge);

          const mpvBtn = document.createElement('button');
          mpvBtn.className = 'mpv-direct-btn';
          mpvBtn.innerHTML = '🎬 MPV';
          mpvBtn.title = 'In MPV abspielen';
          mpvBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const baseUrl = getAccountBaseUrl(activeAccount);
            const durationMins = Math.floor((Number(listing.stop_timestamp || listing.end_timestamp) - Number(listing.start_timestamp)) / 60) || 60;
            const startFormatted = formatTimeshiftDate(listing.start_timestamp);
            const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
            const title = safeBase64Decode(listing.title);
            window.electronAPI.openInMpv(url, `${currentLiveChannelName} (Archiv: ${title})`);
          });
          item.appendChild(mpvBtn);
```

Also find where channel elements are built in the sidebar channel list rendering, and append a direct MPV play button:

```javascript
    // Inside renderChannels or channel list building loop
    const mpvBtn = document.createElement('button');
    mpvBtn.className = 'mpv-direct-btn';
    mpvBtn.innerHTML = '🎬';
    mpvBtn.title = 'Direkt in MPV abspielen';
    mpvBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      let streamUrl = null;
      if (activePlaylistType === 'm3u') {
        streamUrl = ch.url;
      } else if (activeTab === 'live') {
        const baseUrl = getAccountBaseUrl(activeAccount);
        streamUrl = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.ts`;
      } else if (activeTab === 'vod') {
        const baseUrl = getAccountBaseUrl(activeAccount);
        const ext = ch.containerExtension || 'mp4';
        streamUrl = `${baseUrl}/movie/${activeAccount.username}/${activeAccount.password}/${ch.streamId}.${ext}`;
      }
      if (streamUrl) {
        window.electronAPI.openInMpv(streamUrl, ch.name);
      }
    });
    li.appendChild(mpvBtn);
```

- [ ] **Step 2: Run syntax check**

Run: `node -c renderer.js`
Expected output: No syntax errors.

- [ ] **Step 3: Commit**

```bash
git add renderer.js
git commit -m "feat(renderer): inject direct-play MPV buttons into channel list and EPG archive cards"
```
