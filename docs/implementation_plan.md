# 🗺️ Implementation Plan: Electron IPTV Player with AC3 Transcoding Proxy

# Important: this is the initial implementation plan. It is outdated and does not cover modifications and added features. It only serves as a reference.

We will build a fully functioning Electron IPTV player inside `/home/oliverzein/Dokumente/Daten/Development/Electron/IPTV`. 
Because the system already has **FFmpeg** installed, we will use it directly.

## 🛠️ Components to Build

1. **`package.json`**: Project dependencies (`electron`, `express` or native `http`, `hls.js` or `video.js` in renderer).
2. **`main.js`**:
   - Launches Electron `BrowserWindow`.
   - Runs a local HTTP proxy server that receives a channel URL, spawns `ffmpeg` to copy the video stream (`-c:v copy`) and convert the audio stream (`-c:a aac`), and streams the result back.
3. **`preload.js`**: Secure context bridge for communicating between main process and renderer.
4. **`index.html`**: A premium, modern dark UI for our IPTV client (glassmorphic styling, side-by-side layout with Channel List and Player).
5. **`style.css`**: Design system with smooth animations, custom scrollbars, vibrant neon accents (green/blue/purple gradients), and hover state micro-animations.
6. **`renderer.js`**: 
   - Handles loading M3U/M3U8 playlists (supports loading via URL or uploading local file).
   - Displays channels grouped by category.
   - Powers search and filtering.
   - Binds HTML5/HLS.js player to the local transcoding proxy.

---

## 📅 Step-by-Step Execution Plan

### Step 1: Initialize Project & Install Dependencies
- Generate `package.json`.
- Install `electron` as a devDependency.
- Install `hls.js` or copy the dist file to play HLS streams natively on Chromium.

### Step 2: Implement Main Process (`main.js` & `preload.js`)
- Set up `BrowserWindow` with standard security policies (`contextIsolation`, `nodeIntegration: false`).
- Set up local HTTP server to act as a proxy.
- Implement streaming proxy with auto-cleanup of `ffmpeg` subprocesses on close/exit.

### Step 3: Create Core UI (`index.html` & `style.css`)
- Layout: Left sidebar (playlist loader + channels list + category selector), Right pane (video player with custom overlay controls).
- Style: Neon dark theme, backdrop-filter blur (glassmorphism), custom play/pause/volume controls.

### Step 4: Write Renderer Controller (`renderer.js`)
- Add an M3U parser in JS to read playlists.
- Load a sample demo playlist (using public IPTV list) so the app works out-of-the-box.
- Hook channel clicks to target proxy url.

---

## 🧪 Verification & Run Command

We will run the application in development mode:
```bash
npm start
```
