# 📝 Category Tab State Restoration Design Spec

This document details the specifications for remembering and restoring the last selected category, last selected stream/series, and last selected season when switching between the Live, Movie, and Series tabs in the IPTV Player.

## 1. Overview
Currently, the category filter dropdown is shared globally (`lastSelectedCategory`), and switching tabs does not highlight or select the last played or viewed stream in that specific tab. This design introduces tab-specific state storage using `localStorage` to remember the active category, selected item, and active season per tab, improving navigation when toggling between Live, Movie, and Series.

## 2. State Mapping (LocalStorage)

| State Item | Storage Key | When Saved |
|------------|-------------|------------|
| Tab Category | `lastCategory_${activeTab}` | When the Category filter dropdown is changed |
| Selected Live Channel | `lastSelectedId_live` | When a live channel is played (left-click) or opened in MPV (right-click) |
| Selected Movie | `lastSelectedId_vod` | When a movie is played (left-click) or opened in MPV (right-click) |
| Selected Series | `lastSelectedId_series` | When a series is clicked in the sidebar |
| Selected Season | `lastSeason_${seriesId}` | When the season dropdown is changed on a series details view |

## 3. Code Modifications (`renderer.js`)

### 3.1 Category Filter Change Handler
Update the change event listener for `categoryFilter` to store the tab-specific category if `activePlaylistType` is `'xtream'`:
```javascript
  categoryFilter.addEventListener('change', () => {
    if (activePlaylistType === 'xtream') {
      localStorage.setItem(`lastCategory_${activeTab}`, categoryFilter.value);
    } else {
      localStorage.setItem('lastSelectedCategory', categoryFilter.value);
    }
    filterChannels();
  });
```

### 3.2 Loading Xtream Sidebar (`loadXtreamSidebar`)
Update `loadXtreamSidebar` to restore `lastCategory_${activeTab}` instead of the global `lastSelectedCategory`:
```javascript
  let lastSelectedCategory;
  if (activePlaylistType === 'xtream') {
    lastSelectedCategory = localStorage.getItem(`lastCategory_${activeTab}`) || 'all';
  } else {
    lastSelectedCategory = localStorage.getItem('lastSelectedCategory') || 'all';
  }
```

### 3.3 Tracking Selected Streams
1. **Live and VOD clicks (`handleXtreamClick` & contextmenu listener)**:
   Save `lastSelectedId_live` and `lastSelectedId_vod` when playing streams:
   ```javascript
   localStorage.setItem(`lastSelectedId_${activeTab}`, item.streamId);
   ```
2. **Series click (`loadSeriesEpisodes`)**:
   Save `lastSelectedId_series` in `loadSeriesEpisodes(seriesItem)`:
   ```javascript
   localStorage.setItem('lastSelectedId_series', seriesItem.seriesId);
   ```
3. **Season change (`loadSeriesEpisodes` inside seasonSelect change handler)**:
   Save `lastSeason_${seriesItem.seriesId}` when the season dropdown changes:
   ```javascript
   localStorage.setItem(`lastSeason_${seriesItem.seriesId}`, seasonVal);
   ```

### 3.4 Rendering & Auto-Selection (`renderChannelList`)
Update `renderChannelList` to highlight and scroll to the last selected item for the active tab (instead of matching against `activeChannelName` when in Xtream Codes mode). If `activeTab === 'series'`, also load the series episodes detail view automatically:
1. Retrieve `lastId = localStorage.getItem('lastSelectedId_' + activeTab)`.
2. Check each item in the list:
   - If `ch.streamId === lastId` (or `ch.seriesId === lastId`), add `active` class to the item `li` and scroll it into view.
   - For TV Series, if `isLastSelected` is true, check if `seriesTitle.textContent !== ch.name` (to prevent duplicate loads) and call `loadSeriesEpisodes(ch)` to populate the season/episodes grid.

### 3.5 Restoring Last Season (`loadSeriesEpisodes`)
In `loadSeriesEpisodes`, check if `lastSeason_${seriesItem.seriesId}` exists in `localStorage`. If it does, set the `seasonSelect.value` to it and render that season's episodes; otherwise, fallback to the first season.

## 4. Test & Verification Plan
- **V1: Category Dropdown Restore:** Set category to "News" in Live TV, switch to Movies, change category to "Action", switch back to Live TV. Verify that Live category remains "News" and Movies category remains "Action".
- **V2: Stream Highlight and Focus:** Play a live channel, switch to Movies and play a movie. Switch back to Live TV. Verify that the last played live channel is highlighted and scrolled into view in the sidebar, but *not* played.
- **V3: Series and Season Restore:** Click on a series in the sidebar, select "Season 2". Switch to Live TV, then switch back to Series. Verify that the last series is highlighted, the details page is open, and "Season 2" is selected in the season dropdown, with episodes loaded (but not playing).
