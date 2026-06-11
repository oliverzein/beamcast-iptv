# Player-Only View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a button next to the fullscreen button to toggle a view showing only the video player, hiding all other UI elements so that the player fills the window, and support exiting with the Escape key.

**Architecture:** We will use a CSS-class toggle on the `.app-container` element. CSS rules will handle hiding the sidebar and top-bar, removing player padding/borders/radius, and making the video container fill the window. An event listener in JavaScript will toggle the class on button click and remove it on Escape keypress.

**Tech Stack:** Electron, Vanilla JS, HTML5 Video, CSS Grid/Flexbox

---

### Task 1: Add the Toggle Button to the UI

**Files:**
- Modify: `index.html:93-97`

- [ ] **Step 1: Modify HTML to insert the button**
Add `<button id="ctrl-player-only" class="ctrl-btn" title="Toggle Player Only View">📺</button>` right after the fullscreen button.

Modify `index.html`:
```html
              <button id="ctrl-fullscreen" class="ctrl-btn">⛶</button>
              <button id="ctrl-player-only" class="ctrl-btn" title="Toggle Player Only View">📺</button>
```

- [ ] **Step 2: Commit (if auto_commit enabled)**
Check `.agent/config.yml` for `auto_commit` setting. If `auto_commit: false`, skip commit.

---

### Task 2: Add CSS Styles for Player-Only Mode

**Files:**
- Modify: `style.css:1065-1070`

- [ ] **Step 1: Add player-only classes**
Append the player-only rules at the end of `style.css`.

Add to `style.css`:
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

- [ ] **Step 2: Commit (if auto_commit enabled)**
Check `.agent/config.yml` for `auto_commit` setting. If `auto_commit: false`, skip commit.

---

### Task 3: Implement Toggle and Escape Logic in JavaScript

**Files:**
- Modify: `renderer.js:29-32`
- Modify: `renderer.js:705-710`
- Modify: `renderer.js:938-946`

- [ ] **Step 1: Initialize element references**
In `renderer.js`, define `ctrlPlayerOnly` and `appContainer`.

In `renderer.js` around line 29:
```javascript
const ctrlFullscreen = document.getElementById('ctrl-fullscreen');
const ctrlPlayerOnly = document.getElementById('ctrl-player-only');
const appContainer = document.querySelector('.app-container');
const ctrlMpv = document.getElementById('ctrl-mpv');
```

- [ ] **Step 2: Add the click event listener**
Add the listener to toggle the `player-only` class.

In `renderer.js` around line 705:
```javascript
  ctrlFullscreen.addEventListener('click', () => {
    if (!document.fullscreenElement) {
      videoPlayer.requestFullscreen().catch(err => {
        console.error(`Fullscreen error: ${err.message}`);
      });
    } else {
      document.exitFullscreen();
    }
  });

  ctrlPlayerOnly.addEventListener('click', () => {
    appContainer.classList.toggle('player-only');
  });
```

- [ ] **Step 3: Update keydown listener to exit on Escape**
Ensure Escape exits player-only mode if active.

In `renderer.js` around line 938:
```javascript
  // Close modals on Escape key press
  window.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (appContainer.classList.contains('player-only')) {
        appContainer.classList.remove('player-only');
        return;
      }
      m3uModal.style.display = 'none';
      accountsModal.style.display = 'none';
      if (typeof clearEditState === 'function') clearEditState();
    }
  });
```

- [ ] **Step 4: Commit (if auto_commit enabled)**
Check `.agent/config.yml` for `auto_commit` setting. If `auto_commit: false`, skip commit.

---

### Task 4: Verify the Implementation

**Files:**
- Test: manual verification

- [ ] **Step 1: Start the application**
Run command:
`npm start`

Expected: The app launches without errors.

- [ ] **Step 2: Verify the TV button placement**
Verify the button with icon `📺` is located directly to the right of the fullscreen `⛶` button.

- [ ] **Step 3: Verify toggle behavior**
Click the `📺` button.
Expected: Sidebar and top bar disappear. The player container fills the entire application window (leaving no borders or padding).
Click it again.
Expected: The app layout returns to normal.

- [ ] **Step 4: Verify controls on hover**
While in player-only mode, move the mouse over the video.
Expected: Controls show up at the bottom.
Move the mouse away.
Expected: Controls hide after a delay.

- [ ] **Step 5: Verify Escape key exit**
Activate player-only mode. Press `Escape`.
Expected: The app exits player-only mode.
