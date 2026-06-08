# 📝 Single-Instance External Player & Playback Control Design Spec

This document details the specifications for ensuring that only one stream (either built-in HTML5 player or external player) plays at any given time, and that spawning a new external player terminates any previously running external player instance. The architecture is designed to be player-agnostic (e.g. allowing transition to VLC or other players in the future).

## 1. Overview
Currently, launching the external player (MPV) spawns a new process every time, allowing multiple external player windows to play simultaneously. Additionally, the internal player continues playing in the background when the context menu is used to launch the external player. This design resolves these resource conflicts by tracking and managing the active external player process and providing cross-process playback termination.

## 2. Architecture & Code Changes

### 2.1 Generic Process Tracking (`main.js`)
A generic state variable will be introduced in `main.js` to track the running external player process:
```javascript
let activeExternalProcess = null;
```

A generic function `launchExternalPlayer(streamUrl)` will be added to handle:
1. Terminating any running external player process:
   ```javascript
   if (activeExternalProcess) {
     activeExternalProcess.kill('SIGKILL');
     activeExternalProcess = null;
   }
   ```
2. Terminating the active internal FFmpeg transcode process (`activeFfmpegProcess`).
3. Notifying the renderer process to close the HTML5 player UI.
4. Spawning the external player process (currently configured for `mpv` but easily adaptable to `vlc` or other players).
5. Cleaning up the process reference upon exit.

### 2.2 IPC stop-playback Event (`preload.js` & `renderer.js`)
To close the player UI in the renderer when an external player is launched:
1. Expose `onStopPlayback(callback)` in `preload.js`:
   ```javascript
   onStopPlayback: (callback) => {
     ipcRenderer.on('stop-playback', () => callback());
   }
   ```
2. In `renderer.js`, listen to `'stop-playback'` and stop the internal player:
   ```javascript
   window.electronAPI.onStopPlayback(() => {
     destroyPlayer();
     videoContainer.style.display = 'none';
   });
   ```

### 2.3 IPC show-context-menu Update (`main.js`)
Update `'show-context-menu'` to call the generic `launchExternalPlayer` helper instead of raw spawning:
```javascript
      click: () => {
        launchExternalPlayer(url);
      }
```

### 2.4 Application Exit Cleanup (`main.js`)
Update the `'window-all-closed'` handler to terminate any running external player process:
```javascript
  if (activeExternalProcess) {
    activeExternalProcess.kill('SIGKILL');
  }
```

## 3. Test & Verification Plan
- **V1: Multiple External Launches:** Play a stream in the external player, then right-click and open another stream. Verify that the first player window closes and the new one opens.
- **V2: Internal-to-External Transition:** Start playing a stream in the app's player, then right-click and open in MPV. Verify that the internal player stops, the player UI in Electron closes (hides), and MPV opens.
- **V3: App Exit Cleanup:** Open a stream in MPV, then close the Electron application. Verify that the MPV window is terminated.
