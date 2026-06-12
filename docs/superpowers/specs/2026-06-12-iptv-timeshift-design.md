# Design Spec: IPTV Timeshift & EPG Integration

## Goal
Enable Timeshift (Catch-up / Archive) playback for LiveTV streams in the IPTV Player. Users can view a program guide (EPG) for the selected live channel on the right side of the video player, browse past shows, and play them from the archive using the Xtream Codes timeshift format.

## Requirements
1. **EPG Sidebar**: Add a right-hand sidebar next to the video player container to display the EPG program list.
2. **Xtream Codes EPG Fetching**: Retrieve EPG listings via Xtream API (`action=get_simple_data_table`) when playing a live channel.
3. **Base64 Decoding**: Decode base64-encoded `title` and `description` from the EPG response.
4. **Catchup Detection**: Detect if a live channel supports catchup (`catchup` flag is set or `catchup_days` > 0) in IndexedDB.
5. **Timeshift Playback**:
   - Construct Xtream Codes timeshift URL: `/timeshift/{user}/{pass}/{duration}/{start_time}/{stream_id}.ts`
   - Play the timeshift stream as VOD (set `isLive: false` to disable buffer latency chasing and enable standard seeks).
6. **Return to Live Control**: Provide a way to exit timeshift mode and return to the real-time live stream.

## Implementation Details

### Database Changes (`db.js`)
Update the `saveStreams` method in [db.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/db.js) to store catchup information from Xtream Codes live streams:
```javascript
if (storeName === 'live_streams') {
  record.streamId = streamId;
  record.streamType = item.stream_type;
  const isArchiveTrue = item.tv_archive && item.tv_archive !== 0 && item.tv_archive !== '0' && item.tv_archive !== false;
  const isCatchupTrue = item.catchup && item.catchup !== 0 && item.catchup !== '0' && item.catchup !== false;
  const hasCatchup = isArchiveTrue || isCatchupTrue;
  record.catchup = hasCatchup ? 1 : 0;
  record.catchupDays = parseInt(item.tv_archive_duration || item.catchup_days) || 0;
}
```

### Main Process Changes (`main.js`)
Update [isLiveUrl](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js#L96) to recognize timeshift URLs so that they are treated as VOD-like (returning `false`). To prevent lag:
1. Bypassed `ffprobe` in [getVideoMetadata](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js#L161) for `/timeshift/` URLs, immediately resolving with `{ codec: 'h264', duration: 0 }` (enables instant copy mode).
2. Set low `-probesize` and `-analyzeduration` (1MB/1s) in [buildFfmpegArgs](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/main.js#L209) for timeshift streams to prevent buffering lags.

```javascript
function isLiveUrl(streamUrl) {
  try {
    const parsed = url.parse(streamUrl);
    const pathname = (parsed.pathname || '').toLowerCase();
    
    if (pathname.includes('/timeshift/')) {
      return false; // Timeshift streams are VOD-like
    }
    
    // existing logic...
  } catch (e) {
    return true;
  }
}
```

### HTML Changes (`index.html`)
Add the EPG container element to the player frame right next to the `.video-container`:
```html
<div class="player-frame">
  <!-- Main video player container -->
  <div class="video-container" id="video-container">
    <video id="video-player" poster="assets/placeholder.png"></video>
    ...
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
  
  ...
</div>
```
Add a "Return to Live" badge/button in the control bar next to the stream info:
```html
<div class="stream-info" id="stream-info">LIVE</div>
<button id="ctrl-back-to-live" class="btn-sm btn-sm-primary" style="display: none; margin-left: 8px;">🔴 Back to Live</button>
```

### CSS Changes (`style.css`)
Add responsive grid/flex layout styles for `.player-frame` to accommodate the sidebar:
```css
.player-frame {
  padding: 32px;
  display: flex;
  align-items: stretch;
  justify-content: center;
  background: rgba(0, 0, 0, 0.2);
  height: 100%;
  box-sizing: border-box;
}

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
}

.epg-list {
  list-style: none;
  padding: 12px 16px;
  overflow-y: auto;
  flex: 1;
  display: flex;
  flex-direction: column;
  gap: 10px;
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
```

### Renderer Process Changes (`renderer.js`)
1. Introduce active state flags:
   ```javascript
   let isTimeshiftActive = false;
   let activeChannelHasCatchup = false;
   ```
2. When loading a live stream, query its catch-up capability. If supported, show the EPG sidebar and fetch programs:
   ```javascript
   // Decode base64 helper
   function safeBase64Decode(str) {
     try {
       return decodeURIComponent(escape(atob(str)));
     } catch (e) {
       return str;
     }
   }
   
   async function loadEpgSidebar(streamId) {
     const container = document.getElementById('live-epg-container');
     const list = document.getElementById('epg-list');
     list.innerHTML = '<div class="empty-list-placeholder">Loading EPG...</div>';
     container.style.display = 'flex';
     
     try {
       const res = await fetchXtreamApi(activeAccount, 'get_simple_data_table', { stream_id: streamId });
       list.innerHTML = '';
       
       if (res && res.epg_listings && res.epg_listings.length > 0) {
         res.epg_listings.forEach(listing => {
           const item = document.createElement('li');
           item.className = 'epg-item';
           
           const title = safeBase64Decode(listing.title);
           const desc = safeBase64Decode(listing.description);
           const startStr = listing.start;
           const stopStr = listing.end || listing.stop;
           
           const hasArchive = listing.has_archive === 1;
           if (hasArchive) {
             item.classList.add('has-catchup');
             const badge = document.createElement('span');
             badge.className = 'epg-badge archive';
             badge.textContent = 'Archive';
             item.appendChild(badge);
           }
           
           // Flex row for Title & Toggle Icon
           const titleRow = document.createElement('div');
           titleRow.className = 'epg-title-row';
           titleRow.style.display = 'flex';
           titleRow.style.alignItems = 'center';
           titleRow.style.justifyContent = 'space-between';
           titleRow.style.width = '100%';

           const titleSpan = document.createElement('div');
           titleSpan.className = 'epg-title';
           titleSpan.textContent = title;
           titleRow.appendChild(titleSpan);

           let descSpan = null;
           if (desc) {
             const toggleBtn = document.createElement('button');
             toggleBtn.className = 'epg-toggle-desc';
             toggleBtn.innerHTML = '▼';
             toggleBtn.style.background = 'none';
             toggleBtn.style.border = 'none';
             toggleBtn.style.color = 'var(--text-muted)';
             toggleBtn.style.cursor = 'pointer';
             toggleBtn.style.fontSize = '10px';
             toggleBtn.style.padding = '4px';
             titleRow.appendChild(toggleBtn);

             descSpan = document.createElement('div');
             descSpan.className = 'epg-desc';
             descSpan.textContent = desc;
             descSpan.style.display = 'none'; // hidden by default

             toggleBtn.addEventListener('click', (e) => {
               e.stopPropagation(); // Stop timeshift playback trigger
               if (descSpan.style.display === 'none') {
                 descSpan.style.display = 'block';
                 toggleBtn.innerHTML = '▲';
                 toggleBtn.style.color = 'var(--accent-cyan)';
               } else {
                 descSpan.style.display = 'none';
                 toggleBtn.innerHTML = '▼';
                 toggleBtn.style.color = 'var(--text-muted)';
               }
             });
           }
           item.appendChild(titleRow);
           if (descSpan) {
             item.appendChild(descSpan);
           }
           
           // Click event to start Timeshift Playback
           if (hasArchive) {
             item.addEventListener('click', () => {
               playTimeshift(listing, streamId);
             });
           }
           list.appendChild(item);
         });
       } else {
         list.innerHTML = '<div class="empty-list-placeholder">No EPG data available.</div>';
       }
     } catch (e) {
       console.error("EPG fetch failed:", e);
       list.innerHTML = '<div class="empty-list-placeholder">Failed to load EPG.</div>';
     }
   }
   ```
3. Implement `playTimeshift(epgListing, streamId)`:
   - Compute duration in minutes: `Math.floor((epgListing.end_timestamp - epgListing.start_timestamp) / 60)`
   - Format `start_timestamp` to local timezone format `YYYY-MM-DD:HH-MM` (no UTC shift).
   - Build URL: `${baseUrl}/timeshift/${username}/${password}/${duration}/${formattedStart}/${streamId}.ts`
   - Set `isTimeshiftActive = true` and call `playChannel(title, 'Timeshift TV', logo, url)`.
   - Show `ctrl-back-to-live` button and toggle Timeline/Seek controls using program duration as max value.
4. Implement return to live functionality:
   - "Back to Live" button resets `isTimeshiftActive = false` and reloads the stream using the standard live channel URL.
5. **Channel List Indicator**: 
   - Display a cyan clock icon (`🕒`) in the channel list item for live channels supporting timeshift (`ch.catchup === 1`) to visually alert the user that timeshift is available.
