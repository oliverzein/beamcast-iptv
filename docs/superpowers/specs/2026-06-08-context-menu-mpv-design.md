# 📝 Direct MPV Playback via Context Menu Design Spec

This document details the specifications for adding a right-click context menu to stream items (live channels, movies, and series episodes), allowing users to launch them directly in the external MPV player.

## 1. Overview
Currently, playing a stream in the external MPV player requires the user to first click and attempt to load the stream in the app's player, then click the "🎬 MPV" button in the player controls. For streams that fail to load or decode in the app's built-in player (due to strict MSE/Chromium decoder rules), the player controls are obscured by the error overlay. 

Adding a right-click context menu directly to playable items in the sidebar list and episodes grid provides a fast and reliable way to open any stream directly in the external MPV player.

## 2. User Interface Changes
- Right-clicking any playable item in the sidebar channel list (Live Channels, VOD Movies) or any episode card in the TV Series episodes grid will trigger a native OS context menu.
- The context menu will contain a single action: **Open in MPV** (or "In MPV öffnen" depending on locale, we will use "Open in MPV").

## 3. Architecture & Code Changes

### 3.1 safe IPC Gateway (`preload.js`)
Expose a new method `showContextMenu(name, url)` in `preload.js` to send the context menu request to the main process:
```javascript
showContextMenu: (name, url) => {
  ipcRenderer.send('show-context-menu', { name, url });
}
```

### 3.2 Main Process IPC Listener (`main.js`)
Add a new IPC listener for `'show-context-menu'` in `main.js`:
- Construct a native Electron menu using `Menu.buildFromTemplate`.
- Trigger the native context menu popup at the cursor position using `menu.popup()`.
- When the menu item is clicked, spawn the external `mpv` process using `spawn('mpv', [url])` (similar to the existing `'open-in-mpv'` IPC handler).

### 3.3 Renderer Process Right-Click Handlers (`renderer.js`)
Add `contextmenu` event listeners to:
1. **Sidebar list items (`renderChannelList`)**:
   - Only trigger if the stream is playable (all M3U items, or Xtream Codes items under `live` and `vod` tabs).
   - Construct the appropriate playback URL (using active account host and credentials for Xtream Codes).
   - Call `window.electronAPI.showContextMenu(ch.name, streamUrl)`.
2. **Episode grid cards (`renderEpisodesGrid`)**:
   - Construct the series episode URL using active account host and credentials.
   - Call `window.electronAPI.showContextMenu(episodeName, streamUrl)`.

## 4. Test & Verification Plan
- **V1: Sidebar Right-Click:** Right-click a live channel or VOD movie in the sidebar. Verify the native context menu with "Open in MPV" appears at the cursor.
- **V2: Launch MPV from Sidebar:** Click "Open in MPV" on a live channel. Verify that MPV launches and starts playing the stream.
- **V3: Episode Card Right-Click:** Navigate to a series, right-click an episode card. Verify that "Open in MPV" appears and launches MPV playing that specific episode.
- **V4: Main Player Intact:** Verify that regular left-clicks on items still play them inside the app's built-in player as before.
