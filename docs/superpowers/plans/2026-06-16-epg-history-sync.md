# EPG History Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fetch and cache historical EPG program listings for all timeshift/catch-up enabled channels during EPG synchronization.

**Architecture:** Retrieve live streams from IndexedDB, identify timeshift-enabled channels (where `catchup === 1`), sequentially query `get_simple_data_table` for each channel, decode program metadata, and merge historical entries back to IndexedDB.

**Tech Stack:** JavaScript (ES6+), Electron Renderer Process, IndexedDB (via `IPTVDb`), Xtream Codes API.

---

### Task 1: Update fetchAndStoreEpg in renderer-epg.js

**Files:**
- Modify: `renderer-epg.js:11-33`

- [ ] **Step 1: Implement timeshift EPG prefetching in fetchAndStoreEpg**

Replace `fetchAndStoreEpg` in `renderer-epg.js` with the updated implementation that queries and merges historical EPG data for timeshift-enabled channels sequentially.

```javascript
// Fetch the full XMLTV dump, parse it (worker w/ main-thread fallback), and cache it.
async function fetchAndStoreEpg(account) {
  const query = new URLSearchParams({
    host: account.host,
    username: account.username,
    password: account.password,
    prev_days: 7
  });
  const url = `http://127.0.0.1:18080/xtream/xmltv?${query.toString()}`;
  console.log('[EPG] fetching XMLTV via proxy:', url);
  const res = await fetch(url);
  console.log('[EPG] proxy response status:', res.status, res.ok);
  if (!res.ok) throw new Error(`XMLTV HTTP ${res.status}`);
  const xml = await res.text();
  console.log('[EPG] XMLTV downloaded, length:', xml.length, 'chars; first 120:', xml.slice(0, 120));
  const channelMap = await parseXmltvAsync(xml);
  const channelCount = Object.keys(channelMap || {}).length;
  const programmeCount = Object.values(channelMap || {}).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
  console.log('[EPG] parsed channelMap:', channelCount, 'channels,', programmeCount, 'programmes');
  console.log('[EPG] saving to IndexedDB (saveEpg)...');
  await IPTVDb.saveEpg(account.id, channelMap);
  console.log('[EPG] saveEpg complete for account', account.id);

  // Prefetch EPG history for timeshift-enabled channels sequentially
  try {
    const liveStreams = await IPTVDb.getStreamsByCategory('live_streams', account.id, 'all');
    const catchupStreams = (liveStreams || []).filter(s => s.catchup === 1);
    console.log(`[EPG Sync] Found ${catchupStreams.length} timeshift-enabled channels to fetch history for.`);

    const loaderText = document.getElementById('loader-text');
    const syncStep = document.getElementById('sync-step');

    let idx = 0;
    for (const stream of catchupStreams) {
      idx++;
      if (!stream || !stream.streamId || !stream.epgChannelId) continue;

      const progressText = `Syncing TV Guide history (${idx}/${catchupStreams.length}): ${stream.name}...`;
      if (loaderText) loaderText.textContent = progressText;
      if (syncStep) syncStep.textContent = progressText;

      try {
        console.log(`[EPG Sync] Fetching history for channel: ${stream.name} (ID: ${stream.streamId})`);
        const simpleEpg = await fetchXtreamApi(account, 'get_simple_data_table', { stream_id: stream.streamId });
        
        if (simpleEpg && simpleEpg.epg_listings && simpleEpg.epg_listings.length > 0) {
          const xmltvProgs = simpleEpg.epg_listings.map(listing => ({
            start: Number(listing.start_timestamp),
            stop: Number(listing.stop_timestamp || listing.end_timestamp),
            title: safeBase64Decode(listing.title),
            desc: safeBase64Decode(listing.description),
            category: ''
          }));
          await IPTVDb.mergeChannelEpg(account.id, stream.epgChannelId, xmltvProgs);
          console.log(`[EPG Sync] Merged ${xmltvProgs.length} history programs for channel: ${stream.name}`);
        }
      } catch (err) {
        console.warn(`[EPG Sync] Failed history fetch for channel ${stream.name} (ID: ${stream.streamId}):`, err.message);
      }
    }
    console.log('[EPG Sync] Sequential timeshift history prefetch completed successfully.');
  } catch (err) {
    console.warn('[EPG Sync] Error identifying/fetching timeshift channels:', err);
  }

  return channelMap;
}
```

- [ ] **Step 2: Run syntax validation**

Run: `node -c renderer-epg.js`
Expected output: No syntax error reported.

- [ ] **Step 3: Run static code health check**

Run: `npx fallow`
Expected output: Codebase health is clean without errors.

- [ ] **Step 4: Commit the changes**

```bash
git add renderer-epg.js
git commit -m "feat: fetch EPG history for timeshift channels during EPG sync"
```
