# State Restoration & Autoplay Removal Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement robust view state restoration for LiveTV, Movies, and Series without autoplaying streams on startup.

**Tech Stack:** Vanilla JS, HTML/CSS, Electron, LocalStorage

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `style.css` | Modify | Add `.episode-card.active` and `.epg-grid-row.active .epg-grid-channel` styles. |
| `renderer.js` | Modify | Update tab buttons click handler to visually hide/restore EPG Grid without modifying the saved preference. |
| `renderer-xtream.js` | Modify | Remove `restoreLastStream()` calls in `restoreLastState()`. Save/load selected episode IDs and highlight episode cards in `renderEpisodesGrid()`. |
| `renderer-epg.js` | Modify | Add `data-stream-id` to EPG grid rows in `buildEpgChannelRow()`, and vertically center/highlight the active channel row in `renderEpgGrid()`. |

---

## Task 1: Add active state CSS styling

**Files:**
- Modify: [style.css](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/style.css)

- [ ] **Step 1: Add `.episode-card.active` style** near the `.episode-card` classes (~line 1050):
  ```css
  .episode-card.active {
    background: rgba(0, 242, 254, 0.1) !important;
    border-color: var(--accent-cyan) !important;
    box-shadow: 0 0 10px rgba(0, 242, 254, 0.25) !important;
  }
  ```

- [ ] **Step 2: Add `.epg-grid-row.active .epg-grid-channel` style** near `.epg-grid-channel` (~line 1475):
  ```css
  .epg-grid-row.active .epg-grid-channel {
    border-left: 3px solid var(--accent-cyan) !important;
    background: rgba(22, 28, 45, 0.95) !important;
    box-shadow: inset 0 0 10px rgba(0, 242, 254, 0.15) !important;
  }
  ```

---

## Task 2: Remove autoplay on startup

**Files:**
- Modify: [renderer-xtream.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer-xtream.js)

- [ ] **Step 1: Comment out or remove `restoreLastStream()`** inside `restoreLastState()` for Xtream Codes (~line 760):
  ```js
  // 2. Restore active stream if saved
  // restoreLastStream();
  ```

- [ ] **Step 2: Comment out or remove `restoreLastStream('M3U')`** inside `restoreLastState()` for M3U playlists (~line 781):
  ```js
  // restoreLastStream('M3U');
  ```

---

## Task 3: Tab Switching logic to show/hide EPG Grid

**Files:**
- Modify: [renderer.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer.js)

- [ ] **Step 1: Update the tab click event handler** (~line 118) to visually hide the EPG grid when switching tabs, and restore it based on the saved preference when returning to Live TV:
  ```js
  // Xtream Codes Sidebar Tabs
  tabButtons.forEach(btn => {
    btn.addEventListener('click', (e) => {
      tabButtons.forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
      activeTab = btn.getAttribute('data-tab');
      localStorage.setItem('lastTab', activeTab);
      
      // Visually hide/restore EPG Grid depending on active tab
      if (activeTab !== 'live') {
        appContainer.classList.remove('guide-open');
        if (epgGridContainer) epgGridContainer.style.display = 'none';
      } else {
        const epgView = localStorage.getItem('epgView');
        if (epgView === 'grid') {
          appContainer.classList.add('guide-open');
          if (epgGridContainer) epgGridContainer.style.display = 'flex';
          populateEpgGridCategory().finally(() => renderEpgGrid());
        }
      }
      
      loadXtreamSidebar();
    });
  });
  ```

---

## Task 4: EPG Grid Row Identifier & Highlight/Scroll

**Files:**
- Modify: [renderer-epg.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer-epg.js)

- [ ] **Step 1: Attach `streamId` as dataset property to rows** in `buildEpgChannelRow()` (~line 224):
  ```js
  const row = document.createElement('div');
  row.className = 'epg-grid-row';
  row.dataset.streamId = channel.streamId;
  ```

- [ ] **Step 2: Centering and highlighting selected row** in `renderEpgGrid()` (~line 388):
  Add the vertical scrolling and highlighting block at the very end of `renderEpgGrid()`:
  ```js
    // Scroll so the now-line is roughly centered.
    epgGridScroll.scrollLeft = Math.max(0, (now - windowStart) / 60 * EPG_PX_PER_MIN - 300);

    // Vertically scroll and highlight target channel row
    const lastId = localStorage.getItem('lastSelectedId_live');
    if (lastId) {
      const targetRow = epgGridScroll.querySelector(`[data-stream-id="${lastId}"]`);
      if (targetRow) {
        targetRow.classList.add('active');
        setTimeout(() => {
          epgGridScroll.scrollTop = targetRow.offsetTop - (epgGridScroll.clientHeight / 2);
        }, 200);
      }
    }
  }
  ```

---

## Task 5: Series and Episodes Highlight & Restore

**Files:**
- Modify: [renderer-xtream.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer-xtream.js)

- [ ] **Step 1: Attach `seriesId` to `activeSeriesData`** in `loadSeriesEpisodes()` (~line 622):
  ```js
      const seriesInfo = await fetchXtreamApi(activeAccount, 'get_series_info', { series_id: seriesItem.seriesId });
      activeSeriesData = seriesInfo;
      activeSeriesData.seriesId = seriesItem.seriesId;
  ```

- [ ] **Step 2: Save active episode ID on click and contextmenu, and restore selection** in `renderEpisodesGrid()` (~line 681):
  Replace the rendering loop with the highlighted selection and click tracking logic:
  ```js
    // Sort episodes by episode number
    list.sort((a,b) => Number(a.episode_num) - Number(b.episode_num)).forEach(ep => {
      const card = document.createElement('div');
      card.className = 'episode-card';
      
      const num = document.createElement('span');
      num.className = 'ep-num';
      num.textContent = `Episode ${ep.episode_num}`;

      const title = document.createElement('span');
      title.className = 'ep-title';
      title.textContent = ep.title || `Episode ${ep.episode_num}`;

      card.appendChild(num);
      card.appendChild(title);

      card.addEventListener('click', () => {
        const ext = ep.container_extension || 'mp4';
        const baseUrl = getAccountBaseUrl(activeAccount);
        const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
        
        if (activeSeriesData && activeSeriesData.seriesId) {
          localStorage.setItem(`lastSelectedEpisodeId_${activeSeriesData.seriesId}`, ep.id);
        }
        card.parentElement.querySelectorAll('.episode-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');

        playChannel(`${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`, ep.title, seriesCover.src, url);
      });

      card.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        const ext = ep.container_extension || 'mp4';
        const baseUrl = getAccountBaseUrl(activeAccount);
        const url = `${baseUrl}/series/${activeAccount.username}/${activeAccount.password}/${ep.id}.${ext}`;
        const name = `${seriesTitle.textContent} - S${seasonNum}E${ep.episode_num}`;
        
        if (activeSeriesData && activeSeriesData.seriesId) {
          localStorage.setItem(`lastSelectedEpisodeId_${activeSeriesData.seriesId}`, ep.id);
        }
        card.parentElement.querySelectorAll('.episode-card').forEach(c => c.classList.remove('active'));
        card.classList.add('active');

        window.electronAPI.showContextMenu(name, url);
      });

      // Highlight saved episode card
      if (activeSeriesData && activeSeriesData.seriesId) {
        const savedEpId = localStorage.getItem(`lastSelectedEpisodeId_${activeSeriesData.seriesId}`);
        if (savedEpId && String(ep.id) === String(savedEpId)) {
          card.classList.add('active');
          setTimeout(() => {
            card.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
          }, 100);
        }
      }

      episodesGrid.appendChild(card);
    });
  ```
