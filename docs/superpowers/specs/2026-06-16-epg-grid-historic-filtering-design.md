# EPG Grid Historic Data Filtering for Non-Timeshift Channels

## Objective
Filter out historical EPG program blocks (where the program stop time has passed) from the EPG Grid view for channels that do not have timeshift/catch-up enabled. This ensures that past programs are only displayed for channels where the user can actually watch them (via Timeshift/Archive playback).

## Design Details

### 1. Skip Historic Blocks during Grid Row Construction
In `buildEpgChannelRow` within `renderer-epg.js`, skip creating and rendering program elements that have already finished if the channel is not timeshift-enabled:
```javascript
programmes.forEach(p => {
  if (p.stop <= windowStart || p.start >= windowEnd) return;
  if (p.stop <= now && channel.catchup !== 1) return; // Skip historic data for non-timeshift channels
  ...
```

### 2. Adjust Grid Time Window Start
To avoid blank space in the past for non-timeshift channels, filter out their past programs when calculating the grid's timeline start:
```javascript
channels.forEach(c => {
  let list = epgMap[c.epgChannelId] || [];
  if (c.catchup !== 1) {
    list = list.filter(p => p.stop > now);
  }
  if (list.length) {
    windowStart = Math.min(windowStart, list[0].start);
    windowEnd = Math.max(windowEnd, list[list.length - 1].stop);
  }
});
```

## Implementation Files
* **[renderer-epg.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer-epg.js)**: Update `buildEpgChannelRow` and `renderEpgGrid`.
