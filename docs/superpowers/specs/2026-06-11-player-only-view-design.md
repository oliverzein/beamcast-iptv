# Design Spec: Player-Only View

## Goal
Add a dedicated "player-only" view/mode to the IPTV application. In this mode, all UI controls and sidebars are hidden, and the video player container expands to fill the entire application window. A toggle button will be placed next to the fullscreen button in the control row.

## Requirements
1. Add a toggle button with the label `📺` (television icon) directly to the right of the Fullscreen button (`⛶`).
2. Toggling the button will activate/deactivate the player-only mode.
3. In player-only mode:
   - Sidebar is hidden.
   - Top bar (active channel info, sync button, status indicator) is hidden.
   - Player frame padding is reduced to `0`.
   - Video container borders, border-radius, and box shadows are removed so it fills the screen completely.
4. Player controls (play, pause, volume, etc.) should still show up on mouse hover over the video container in player-only mode (just like in normal mode).
5. Pressing the `Escape` key while in player-only mode will exit the mode.

## Implementation Details

### HTML Changes (`index.html`)
Introduce the new button right after the fullscreen button:
```html
<button id="ctrl-fullscreen" class="ctrl-btn">⛶</button>
<button id="ctrl-player-only" class="ctrl-btn" title="Toggle Player Only View">📺</button>
```

### CSS Changes (`style.css`)
Define the layout transition classes under `.player-only` applied to `.app-container`:
```css
/* Player-only Mode */
.app-container.player-only {
  grid-template-columns: 1fr;
}

.app-container.player-only .sidebar {
  display: none;
}

.app-container.player-only .main-content {
  grid-template-rows: 1fr;
}

.app-container.player-only .top-bar {
  display: none;
}

.app-container.player-only .player-frame {
  padding: 0;
  background: #000;
}

.app-container.player-only .video-container {
  border: none;
  border-radius: 0;
  box-shadow: none;
}
```

### JS Changes (`renderer.js`)
- Retrieve the button element:
  ```javascript
  const ctrlPlayerOnly = document.getElementById('ctrl-player-only');
  const appContainer = document.querySelector('.app-container');
  ```
- Listen for click events on `ctrlPlayerOnly`:
  ```javascript
  ctrlPlayerOnly.addEventListener('click', () => {
    appContainer.classList.toggle('player-only');
  });
  ```
- Update the window keydown listener for the Escape key:
  ```javascript
  if (e.key === 'Escape') {
    if (appContainer.classList.contains('player-only')) {
      appContainer.classList.remove('player-only');
      // Do not close modals or clear state if we just exited player-only mode
      return;
    }
    // existing modal close logic...
  }
  ```
