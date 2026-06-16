# EPG History Sync for Timeshift Enabled Channels

## Objective
Enable automatic fetching of historical EPG program blocks for timeshift-enabled channels during the account synchronization and TV guide synchronization processes. This populates the EPG Grid timeline with timeshift (`archive`) blocks upfront, resolving the limitation where historical blocks only appeared after manually opening a channel's sidebar.

## User Decisions
* **Sequential Fetching:** EPG history for each timeshift channel is fetched sequentially (1-at-a-time) to minimize load on the IPTV provider's server.
* **Sync-Blocking:** The fetches are awaited as part of the main EPG sync task. This guarantees that timeshift program data is fully cached in IndexedDB once the sync modal/loader completes.

## Design Details

### 1. Identify Timeshift Enabled Channels
Query IndexedDB for all live stream records of the active account and filter for those supporting timeshift/catch-up:
```javascript
const liveStreams = await IPTVDb.getStreamsByCategory('live_streams', account.id, 'all');
const catchupStreams = liveStreams.filter(s => s.catchup === 1);
```

### 3. Fetch and Merge EPG Listings
For each timeshift-enabled channel, perform sequential Xtream API queries and merge the listings into IndexedDB:
1. Update UI progress (on both the initial setup overlay and the manual sync dialog):
   * `#loader-text`
   * `#sync-step`
2. Fetch simple EPG data:
   ```javascript
   const res = await fetchXtreamApi(account, 'get_simple_data_table', { stream_id: stream.streamId });
   ```
3. Decode and normalize program listings:
   * Base64 decode `title` and `description` using `safeBase64Decode`.
   * Extract `start_timestamp` and `stop_timestamp` (or `end_timestamp`).
4. Persist to database:
   ```javascript
   await IPTVDb.mergeChannelEpg(account.id, stream.epgChannelId, xmltvProgs);
   ```

### 4. Error Isolation
Wrap the individual channel EPG fetching logic in a `try-catch` block. A failure on a single channel's Xtream API query should log a warning but allow the sync process to continue with other channels.

## Implementation Files
* **[renderer-epg.js](file:///home/oliverzein/Dokumente/Daten/Development/Electron/IPTV/renderer-epg.js)**: Modify `fetchAndStoreEpg` to execute the sequential catch-up EPG prefetching logic.
