# EPG Grid View Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a classic TV-guide grid view (channels × time) for the current live category, fed by a cached XMLTV dump, with smart-play that reuses existing internal/MPV routing.

**Architecture:** A single XMLTV dump is fetched through the main-process proxy during account sync, parsed by a dependency-free pure function (run in a Web Worker, with a main-thread fallback), and cached in IndexedDB. A "Guide" toggle hides the left channel pane and the player area and renders a full-width grid built from the cached programmes joined to live-stream rows via `epgChannelId`. Clicking a program classifies by time (live / catchup / future) and routes through the existing playback functions.

**Tech Stack:** Electron (Node 18+ global `fetch`, built-in `node --test`), vanilla JS renderer, IndexedDB (`db.js`), Chromium Web Worker, no new runtime dependencies.

**Spec:** `docs/superpowers/specs/2026-06-14-epg-grid-view-design.md`

---

## File Structure

- **`epg-parse.js`** (create) — pure, dual-environment module: `parseXmltv(xml)` + `xmltvTimeToEpoch(str)`. Regex-based (no `DOMParser`) so it runs in Node tests and the browser worker. Exports via `module.exports` when present; also defines globals for the renderer/worker.
- **`epg-worker.js`** (create) — Web Worker that `importScripts('epg-parse.js')` and parses off the UI thread.
- **`test/epg-parse.test.js`** (create) — Node built-in test-runner unit tests for the parser.
- **`db.js`** (modify) — bump to v3, add `epg_programmes` + `epg_meta` stores, persist `epgChannelId`, add EPG read/write methods.
- **`main.js`** (modify) — add `/xtream/xmltv` proxy route + handler.
- **`renderer.js`** (modify) — sync integration, EPG load/refresh, Guide toggle, grid render + interaction.
- **`index.html`** (modify) — Guide toggle button, `#epg-grid-container` markup, `<script src="epg-parse.js">`.
- **`style.css`** (modify) — grid styles + `guide-open` layout.
- **`package.json`** (modify) — `"test"` script + add new files to electron-builder `files`.

---

## Task 1: XMLTV time conversion (pure, tested)

**Files:**
- Create: `epg-parse.js`
- Test: `test/epg-parse.test.js`
- Modify: `package.json` (scripts.test)

- [ ] **Step 1: Add the test script to package.json**

In `package.json`, change the `scripts` block to:

```json
  "scripts": {
    "start": "electron .",
    "dist": "electron-builder --linux AppImage",
    "test": "node --test"
  },
```

- [ ] **Step 2: Write the failing test for `xmltvTimeToEpoch`**

Create `test/epg-parse.test.js`:

```js
const { test } = require('node:test');
const assert = require('node:assert');
const { xmltvTimeToEpoch } = require('../epg-parse.js');

test('xmltvTimeToEpoch: UTC offset', () => {
  // 2026-06-14 18:00:00 UTC
  assert.strictEqual(xmltvTimeToEpoch('20260614180000 +0000'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: positive offset converts to UTC', () => {
  // 20:00 at +0200 == 18:00 UTC
  assert.strictEqual(xmltvTimeToEpoch('20260614200000 +0200'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: negative offset converts to UTC', () => {
  // 13:00 at -0500 == 18:00 UTC
  assert.strictEqual(xmltvTimeToEpoch('20260614130000 -0500'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: missing offset assumes UTC', () => {
  assert.strictEqual(xmltvTimeToEpoch('20260614180000'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: garbage returns NaN', () => {
  assert.ok(Number.isNaN(xmltvTimeToEpoch('not-a-date')));
  assert.ok(Number.isNaN(xmltvTimeToEpoch('')));
  assert.ok(Number.isNaN(xmltvTimeToEpoch(undefined)));
});
```

- [ ] **Step 3: Run the test to verify it fails**

Run: `npm test`
Expected: FAIL — `Cannot find module '../epg-parse.js'`.

- [ ] **Step 4: Create `epg-parse.js` with `xmltvTimeToEpoch`**

Create `epg-parse.js`:

```js
/**
 * epg-parse.js — dependency-free XMLTV parser.
 * Runs in Node (tests) and in the browser worker/renderer.
 * Regex-based on purpose: DOMParser is unavailable in plain Node.
 */
(function (root) {
  'use strict';

  // "YYYYMMDDHHMMSS +ZZZZ" -> epoch seconds (UTC). Returns NaN if unparseable.
  function xmltvTimeToEpoch(str) {
    if (typeof str !== 'string') return NaN;
    const m = str.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/);
    if (!m) return NaN;
    const [, y, mo, d, h, mi, s, sign, oh, om] = m;
    const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    let offsetSec = 0;
    if (sign) {
      offsetSec = (sign === '-' ? -1 : 1) * (parseInt(oh, 10) * 3600 + parseInt(om, 10) * 60);
    }
    return Math.floor(utcMs / 1000) - offsetSec;
  }

  const api = { xmltvTimeToEpoch };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.parseXmltv = root.parseXmltv || null; // defined in Task 2
    root.xmltvTimeToEpoch = xmltvTimeToEpoch;
  }
})(typeof self !== 'undefined' ? self : this);
```

- [ ] **Step 5: Run the test to verify it passes**

Run: `npm test`
Expected: PASS — all 5 `xmltvTimeToEpoch` tests pass.

- [ ] **Step 6: Commit**

```bash
git add epg-parse.js test/epg-parse.test.js package.json
git commit -m "feat(epg): add dependency-free XMLTV time parser with tests"
```

---

## Task 2: XMLTV document parser (pure, tested)

**Files:**
- Modify: `epg-parse.js`
- Test: `test/epg-parse.test.js`

- [ ] **Step 1: Write the failing tests for `parseXmltv`**

Append to `test/epg-parse.test.js`:

```js
const { parseXmltv } = require('../epg-parse.js');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="bbc.one"><display-name>BBC One</display-name></channel>
  <programme start="20260614170000 +0000" stop="20260614180000 +0000" channel="bbc.one">
    <title lang="en">Late Show</title>
    <desc lang="en">A &amp; B</desc>
    <category lang="en">Talk</category>
  </programme>
  <programme start="20260614160000 +0000" stop="20260614170000 +0000" channel="bbc.one">
    <title>Early Show</title>
  </programme>
  <programme start="20260614180000 +0000" stop="20260614190000 +0000" channel="cnn.int">
    <title>World News</title>
    <desc>Headlines</desc>
  </programme>
</tv>`;

test('parseXmltv: groups by channel and sorts by start', () => {
  const map = parseXmltv(SAMPLE);
  assert.deepStrictEqual(Object.keys(map).sort(), ['bbc.one', 'cnn.int']);
  assert.strictEqual(map['bbc.one'].length, 2);
  // sorted ascending: Early (16:00) before Late (17:00)
  assert.strictEqual(map['bbc.one'][0].title, 'Early Show');
  assert.strictEqual(map['bbc.one'][1].title, 'Late Show');
});

test('parseXmltv: decodes entities and fields', () => {
  const p = parseXmltv(SAMPLE)['bbc.one'][1];
  assert.strictEqual(p.title, 'Late Show');
  assert.strictEqual(p.desc, 'A & B');
  assert.strictEqual(p.category, 'Talk');
  assert.strictEqual(p.start, Date.UTC(2026, 5, 14, 17, 0, 0) / 1000);
  assert.strictEqual(p.stop, Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('parseXmltv: missing desc/category default to empty string', () => {
  const p = parseXmltv(SAMPLE)['bbc.one'][0];
  assert.strictEqual(p.desc, '');
  assert.strictEqual(p.category, '');
});

test('parseXmltv: empty/garbage input returns {}', () => {
  assert.deepStrictEqual(parseXmltv(''), {});
  assert.deepStrictEqual(parseXmltv('not xml'), {});
  assert.deepStrictEqual(parseXmltv(null), {});
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npm test`
Expected: FAIL — `parseXmltv` is `undefined` / not a function.

- [ ] **Step 3: Implement `parseXmltv` in `epg-parse.js`**

In `epg-parse.js`, add these helpers above `const api = ...` and include `parseXmltv` in the exports:

```js
  function decodeEntities(str) {
    if (!str) return '';
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, '&')
      .trim();
  }

  function tagText(block, tag) {
    const m = block.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return m ? decodeEntities(m[1]) : '';
  }

  function attr(attrs, name) {
    const m = attrs.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
    return m ? m[1] : '';
  }

  function parseXmltv(xml) {
    const out = {};
    if (typeof xml !== 'string' || xml.indexOf('<programme') === -1) return out;
    const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1];
      const body = m[2];
      const channel = attr(attrs, 'channel');
      if (!channel) continue;
      const start = xmltvTimeToEpoch(attr(attrs, 'start'));
      const stop = xmltvTimeToEpoch(attr(attrs, 'stop'));
      if (Number.isNaN(start) || Number.isNaN(stop)) continue;
      (out[channel] || (out[channel] = [])).push({
        start,
        stop,
        title: tagText(body, 'title'),
        desc: tagText(body, 'desc'),
        category: tagText(body, 'category')
      });
    }
    Object.keys(out).forEach((k) => out[k].sort((a, b) => a.start - b.start));
    return out;
  }
```

Update the exports object and the browser global assignment:

```js
  const api = { xmltvTimeToEpoch, parseXmltv };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.parseXmltv = parseXmltv;
    root.xmltvTimeToEpoch = xmltvTimeToEpoch;
  }
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npm test`
Expected: PASS — all parser tests pass.

- [ ] **Step 5: Commit**

```bash
git add epg-parse.js test/epg-parse.test.js
git commit -m "feat(epg): parse XMLTV programmes grouped per channel"
```

---

## Task 3: Web worker for off-thread parsing

**Files:**
- Create: `epg-worker.js`

- [ ] **Step 1: Create the worker**

Create `epg-worker.js`:

```js
/* EPG XMLTV parse worker. Keeps multi-MB parsing off the UI thread. */
importScripts('epg-parse.js');

self.onmessage = function (e) {
  try {
    const channelMap = parseXmltv(e.data && e.data.xml);
    self.postMessage({ channelMap });
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
```

- [ ] **Step 2: Syntax check**

Run: `node -c epg-worker.js`
Expected: no output, exit 0. (Note: `importScripts`/`self` are runtime-only; `node -c` only checks syntax.)

- [ ] **Step 3: Commit**

```bash
git add epg-worker.js
git commit -m "feat(epg): add web worker wrapper for XMLTV parsing"
```

---

## Task 4: Main-process XMLTV proxy route

**Files:**
- Modify: `main.js` (route table near line 485; new handler after `handleXtreamApiRequest` ~line 469)

- [ ] **Step 1: Add the route**

In `main.js`, in the `proxyServer` request handler, add a branch (after the `/xtream/api` branch, before the `else` 404):

```js
  } else if (reqUrl.pathname === '/xtream/xmltv') {
    handleXtreamXmltvRequest(req, res, reqUrl);
```

- [ ] **Step 2: Add the handler**

In `main.js`, immediately after the closing brace of `handleXtreamApiRequest` (around line 469), add:

```js
// Handle Xtream Codes XMLTV (full EPG dump) forwarding
function handleXtreamXmltvRequest(req, res, reqUrl) {
  const { host, username, password } = reqUrl.query;

  if (!host || !username || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required parameters' }));
  }

  const targetHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
  const query = new URLSearchParams({ username, password });
  const targetUrl = `${targetHost}/xmltv.php?${query.toString()}`;

  console.log(`Forwarding Xtream XMLTV request: ${targetUrl}`);

  fetch(targetUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response.text();
    })
    .then(body => {
      res.writeHead(200, {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    })
    .catch(err => {
      console.error('Xtream XMLTV Proxy Error:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch XMLTV from Xtream server', details: err.message }));
    });
}
```

- [ ] **Step 3: Syntax check**

Run: `node -c main.js`
Expected: no output, exit 0.

- [ ] **Step 4: Commit**

```bash
git add main.js
git commit -m "feat(epg): add /xtream/xmltv proxy route in main process"
```

---

## Task 5: IndexedDB v3 — EPG stores, epgChannelId, methods

**Files:**
- Modify: `db.js`

- [ ] **Step 1: Bump version and add stores**

In `db.js`, change `dbVersion: 2,` to `dbVersion: 3,`.

In `open()` `request.onupgradeneeded`, add at the end of the handler (after the `series` store block, before the closing `};`):

```js
        // 4. EPG stores (added in v3)
        if (!db.objectStoreNames.contains('epg_programmes')) {
          const epgStore = db.createObjectStore('epg_programmes', { keyPath: 'compoundKey' });
          epgStore.createIndex('accountId', 'accountId', { unique: false });
        }
        if (!db.objectStoreNames.contains('epg_meta')) {
          db.createObjectStore('epg_meta', { keyPath: 'accountId' });
        }
```

- [ ] **Step 2: Persist `epgChannelId` on live streams**

In `db.js` `saveStreams`, inside the `if (storeName === 'live_streams') {` block, add after `record.streamType = item.stream_type;`:

```js
          record.epgChannelId = item.epg_channel_id || null;
```

- [ ] **Step 3: Add EPG read/write methods**

In `db.js`, add these methods to the `IPTVDb` object (e.g. after `searchStreams`, before `clearAccountCache`):

```js
  saveEpg(accountId, channelMap) {
    return new Promise((resolve, reject) => {
      const channelIds = Object.keys(channelMap || {});
      const tx = this.db.transaction(['epg_programmes', 'epg_meta'], 'readwrite');
      const epgStore = tx.objectStore('epg_programmes');
      const metaStore = tx.objectStore('epg_meta');

      tx.oncomplete = () => resolve();
      tx.onerror = (e) => reject(e.target.error);

      let programmeCount = 0;
      channelIds.forEach(channelId => {
        const programmes = channelMap[channelId] || [];
        programmeCount += programmes.length;
        epgStore.put({
          compoundKey: `${accountId}_${channelId}`,
          accountId,
          epgChannelId: channelId,
          programmes
        });
      });

      metaStore.put({
        accountId,
        lastFetched: Date.now(),
        channelCount: channelIds.length,
        programmeCount
      });
    });
  },

  getEpgForChannels(accountId, epgChannelIds) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['epg_programmes'], 'readonly');
      const store = tx.objectStore('epg_programmes');
      const result = {};
      let pending = 0;
      let done = false;

      const finish = () => { if (done && pending === 0) resolve(result); };

      (epgChannelIds || []).forEach(id => {
        if (!id) return;
        pending++;
        const req = store.get(`${accountId}_${id}`);
        req.onsuccess = () => {
          if (req.result) result[id] = req.result.programmes || [];
          pending--;
          finish();
        };
        req.onerror = (e) => reject(e.target.error);
      });

      done = true;
      finish();
    });
  },

  getEpgMeta(accountId) {
    return new Promise((resolve, reject) => {
      const tx = this.db.transaction(['epg_meta'], 'readonly');
      const store = tx.objectStore('epg_meta');
      const req = store.get(accountId);
      req.onsuccess = () => resolve(req.result || null);
      req.onerror = (e) => reject(e.target.error);
    });
  },
```

- [ ] **Step 4: Include EPG stores in `clearAccountCache`**

In `db.js` `clearAccountCache`, change the `stores` array to include the EPG stores. Note `epg_meta` is keyed by `accountId` (not compound) and has no index, so handle it separately:

```js
  clearAccountCache(accountId) {
    const stores = ['live_categories', 'vod_categories', 'series_categories', 'live_streams', 'vod_streams', 'series', 'epg_programmes'];
    const promises = stores.map(storeName => {
      return new Promise((resolve, reject) => {
        const transaction = this.db.transaction([storeName], 'readwrite');
        const store = transaction.objectStore(storeName);
        const index = store.index('accountId');
        const request = index.openCursor(IDBKeyRange.only(accountId));

        request.onsuccess = (event) => {
          const cursor = event.target.result;
          if (cursor) {
            cursor.delete();
            cursor.continue();
          } else {
            resolve();
          }
        };
        request.onerror = (e) => reject(e.target.error);
      });
    });

    promises.push(new Promise((resolve, reject) => {
      const tx = this.db.transaction(['epg_meta'], 'readwrite');
      const req = tx.objectStore('epg_meta').delete(accountId);
      req.onsuccess = () => resolve();
      req.onerror = (e) => reject(e.target.error);
    }));

    return Promise.all(promises);
  }
```

- [ ] **Step 5: Syntax check**

Run: `node -c db.js`
Expected: no output, exit 0.

- [ ] **Step 6: Commit**

```bash
git add db.js
git commit -m "feat(epg): IndexedDB v3 stores + epgChannelId + EPG methods"
```

---

## Task 6: Renderer — fetch/parse/store EPG (sync + refresh helpers)

**Files:**
- Modify: `renderer.js` (sync block ~lines 1386-1397; helpers near the EPG section ~line 1721)
- Modify: `index.html` (add parser script tag)

- [ ] **Step 1: Load the parser script in the renderer (worker fallback)**

In `index.html`, find where `renderer.js` is loaded near the bottom and add the parser script BEFORE it. Search for `<script src="renderer.js"></script>` and replace with:

```html
  <script src="epg-parse.js"></script>
  <script src="renderer.js"></script>
```

(If `db.js` is loaded via its own `<script>` tag, place `epg-parse.js` next to it in the same order region.)

- [ ] **Step 2: Add EPG fetch/parse helper in `renderer.js`**

In `renderer.js`, in the `// --- EPG & Timeshift helpers ---` section (near line 1721), add:

```js
// Fetch the full XMLTV dump, parse it (worker w/ main-thread fallback), and cache it.
async function fetchAndStoreEpg(account) {
  const query = new URLSearchParams({
    host: account.host,
    username: account.username,
    password: account.password
  });
  const res = await fetch(`http://127.0.0.1:18080/xtream/xmltv?${query.toString()}`);
  if (!res.ok) throw new Error(`XMLTV HTTP ${res.status}`);
  const xml = await res.text();
  const channelMap = await parseXmltvAsync(xml);
  await IPTVDb.saveEpg(account.id, channelMap);
  return channelMap;
}

// Parse XMLTV off the UI thread when possible, else fall back to the global parseXmltv.
function parseXmltvAsync(xml) {
  return new Promise((resolve) => {
    if (typeof Worker === 'undefined') {
      resolve(typeof parseXmltv === 'function' ? parseXmltv(xml) : {});
      return;
    }
    let worker;
    try {
      worker = new Worker('epg-worker.js');
    } catch (e) {
      resolve(typeof parseXmltv === 'function' ? parseXmltv(xml) : {});
      return;
    }
    worker.onmessage = (ev) => {
      worker.terminate();
      if (ev.data && ev.data.error) {
        console.warn('[EPG] worker parse error, falling back:', ev.data.error);
        resolve(typeof parseXmltv === 'function' ? parseXmltv(xml) : {});
      } else {
        resolve((ev.data && ev.data.channelMap) || {});
      }
    };
    worker.onerror = () => {
      worker.terminate();
      resolve(typeof parseXmltv === 'function' ? parseXmltv(xml) : {});
    };
    worker.postMessage({ xml });
  });
}
```

- [ ] **Step 3: Call EPG prefetch during sync (non-fatal)**

In `renderer.js` `syncAllData`, after the `get_series` save block (after line 1397 `await IPTVDb.saveStreams('series', account.id, series);`), add:

```js
    // 5. Prefetch EPG (XMLTV). Non-fatal: sync succeeds even if guide is unavailable.
    loaderText.textContent = "Syncing TV Guide...";
    try {
      await fetchAndStoreEpg(account);
    } catch (epgErr) {
      console.warn('[EPG] XMLTV prefetch failed (continuing sync):', epgErr.message);
    }
```

- [ ] **Step 4: Syntax check**

Run: `node -c renderer.js`
Expected: no output, exit 0.

- [ ] **Step 5: Manual smoke test (sync writes EPG)**

Run: `npm start`. Add/sync an Xtream account. In DevTools console, run:
```js
await IPTVDb.getEpgMeta(activeAccount.id)
```
Expected: object with `channelCount > 0` and `programmeCount > 0` (for providers that expose `xmltv.php`). If the provider lacks XMLTV, expect `null` and a console warning — sync still completes.

- [ ] **Step 6: Commit**

```bash
git add renderer.js index.html
git commit -m "feat(epg): prefetch and cache XMLTV during account sync"
```

---

## Task 7: Grid markup, Guide toggle, and styles

**Files:**
- Modify: `index.html` (Guide button in top-bar-right ~line 64; grid container inside `.main-content`)
- Modify: `style.css`

- [ ] **Step 1: Add the Guide toggle button**

In `index.html`, in the `.top-bar-right` div (near line 64), add before the `#btn-sync-xtream` button:

```html
          <button id="btn-toggle-guide" class="btn-sm btn-sm-secondary" style="display: none; align-items: center; gap: 6px;">📅 TV Guide</button>
```

- [ ] **Step 2: Add the grid container**

In `index.html`, inside `<main class="main-content">`, after the closing `</div>` of `.player-frame` (and before `</main>`), add:

```html
      <!-- EPG Grid (TV Guide) view, hidden by default -->
      <div class="epg-grid-container" id="epg-grid-container" style="display: none;">
        <div class="epg-grid-toolbar">
          <h3>TV Guide</h3>
          <span class="epg-grid-updated" id="epg-grid-updated"></span>
          <div class="epg-grid-toolbar-actions">
            <button id="btn-epg-refresh" class="btn-sm btn-sm-primary">🔄 Refresh</button>
            <button id="btn-epg-close" class="btn-sm btn-sm-secondary">✕ Close</button>
          </div>
        </div>
        <div class="epg-grid-scroll" id="epg-grid-scroll">
          <!-- timeline header + rows injected by renderer -->
        </div>
      </div>
```

- [ ] **Step 3: Add styles**

In `style.css`, append:

```css
/* ===== EPG Grid (TV Guide) ===== */
.app-container.guide-open .sidebar { display: none; }
.app-container.guide-open .player-frame { display: none; }

.epg-grid-container {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
  background: rgba(7, 9, 14, 0.6);
  border-radius: 12px;
  overflow: hidden;
}
.epg-grid-toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 10px 14px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
}
.epg-grid-toolbar h3 { font-size: 16px; color: var(--accent-cyan); }
.epg-grid-updated { font-size: 12px; color: var(--text-muted); }
.epg-grid-toolbar-actions { margin-left: auto; display: flex; gap: 8px; }

.epg-grid-scroll { flex: 1; overflow: auto; position: relative; }

.epg-grid-timeline {
  position: sticky;
  top: 0;
  z-index: 3;
  display: flex;
  height: 28px;
  background: rgba(7, 9, 14, 0.95);
  border-bottom: 1px solid rgba(255, 255, 255, 0.1);
}
.epg-grid-timeline .epg-corner {
  position: sticky;
  left: 0;
  z-index: 4;
  background: rgba(7, 9, 14, 0.95);
  flex: 0 0 var(--epg-chan-w, 200px);
  border-right: 1px solid rgba(255, 255, 255, 0.1);
}
.epg-tick {
  flex: 0 0 auto;
  font-size: 11px;
  color: var(--text-muted);
  border-left: 1px solid rgba(255, 255, 255, 0.06);
  padding-left: 4px;
  box-sizing: border-box;
}

.epg-grid-row {
  display: flex;
  height: 56px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.epg-grid-channel {
  position: sticky;
  left: 0;
  z-index: 2;
  flex: 0 0 var(--epg-chan-w, 200px);
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 10px;
  background: rgba(13, 17, 26, 0.95);
  border-right: 1px solid rgba(255, 255, 255, 0.1);
  cursor: pointer;
  overflow: hidden;
}
.epg-grid-channel img { width: 32px; height: 32px; object-fit: contain; }
.epg-grid-channel span { font-size: 13px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }

.epg-grid-track { position: relative; flex: 0 0 auto; }
.epg-prog {
  position: absolute;
  top: 4px;
  bottom: 4px;
  box-sizing: border-box;
  padding: 4px 6px;
  background: rgba(255, 255, 255, 0.05);
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 6px;
  font-size: 12px;
  overflow: hidden;
  cursor: pointer;
}
.epg-prog .epg-prog-title { white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.epg-prog .epg-prog-time { font-size: 10px; color: var(--text-muted); }
.epg-prog.current { border-color: var(--accent-cyan); box-shadow: 0 0 8px rgba(0, 242, 254, 0.35); }
.epg-prog.archive { border-color: rgba(0, 242, 254, 0.4); background: rgba(0, 242, 254, 0.08); }
.epg-prog.future { opacity: 0.75; }

.epg-now-line {
  position: absolute;
  top: 28px;
  bottom: 0;
  width: 2px;
  background: #ff453a;
  z-index: 1;
  pointer-events: none;
}
.epg-grid-empty { padding: 24px; color: var(--text-muted); }
```

- [ ] **Step 4: Manual check (markup renders, toggle hidden styling)**

Run: `npm start`. Confirm the app still launches and the grid container is not visible. (Wiring comes in Task 8.)

- [ ] **Step 5: Commit**

```bash
git add index.html style.css
git commit -m "feat(epg): grid markup, Guide toggle button, and styles"
```

---

## Task 8: Renderer — render grid + smart-click interaction

**Files:**
- Modify: `renderer.js` (element refs near top ~lines 6-40; new functions in EPG section; show Guide button where sync button is revealed)

- [ ] **Step 1: Add element references**

In `renderer.js`, near the other `document.getElementById` refs (around lines 6-40), add:

```js
const btnToggleGuide = document.getElementById('btn-toggle-guide');
const btnEpgRefresh = document.getElementById('btn-epg-refresh');
const btnEpgClose = document.getElementById('btn-epg-close');
const epgGridContainer = document.getElementById('epg-grid-container');
const epgGridScroll = document.getElementById('epg-grid-scroll');
const epgGridUpdated = document.getElementById('epg-grid-updated');
```

- [ ] **Step 2: Reveal the Guide button for Xtream accounts**

In `renderer.js`, find where `#btn-sync-xtream` is shown for Xtream mode (in `setActiveXtreamAccount` — search for `btn-sync-xtream` / sync button `style.display`). Right after the sync button is set visible, add:

```js
  if (btnToggleGuide) btnToggleGuide.style.display = 'flex';
```

And where M3U/preset mode hides Xtream-only controls (search for where the sync button is hidden, e.g. in `loadPresetChannels` / M3U load path), add:

```js
  if (btnToggleGuide) btnToggleGuide.style.display = 'none';
```

(If a single helper toggles Xtream-only UI, place both lines alongside the sync-button toggle there.)

- [ ] **Step 3: Add grid open/close + render functions**

In `renderer.js`, in the EPG helpers section, add:

```js
const EPG_PX_PER_MIN = 5;
const EPG_CHAN_WIDTH = 200;

function openEpgGrid() {
  if (activePlaylistType !== 'xtream' || !activeAccount) return;
  appContainer.classList.add('guide-open');
  if (epgGridContainer) epgGridContainer.style.display = 'flex';
  renderEpgGrid();
}

function closeEpgGrid() {
  appContainer.classList.remove('guide-open');
  if (epgGridContainer) epgGridContainer.style.display = 'none';
}

function epgFormatClock(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

async function renderEpgGrid() {
  if (!epgGridScroll) return;
  epgGridScroll.innerHTML = '<div class="epg-grid-empty">Lade Programmübersicht...</div>';

  // Channels of the current live category (reuse the sidebar's category filter).
  const categoryId = (activeTab === 'live') ? (categoryFilter.value || 'all') : 'all';
  const channels = (await IPTVDb.getStreamsByCategory('live_streams', activeAccount.id, categoryId)) || [];

  const meta = await IPTVDb.getEpgMeta(activeAccount.id);
  if (epgGridUpdated) {
    epgGridUpdated.textContent = meta && meta.lastFetched
      ? `Stand: ${new Date(meta.lastFetched).toLocaleString('de-DE')}`
      : 'Keine Guide-Daten';
  }

  if (!channels.length) {
    epgGridScroll.innerHTML = '<div class="epg-grid-empty">Keine Kanäle in dieser Kategorie.</div>';
    return;
  }

  const epgIds = channels.map(c => c.epgChannelId).filter(Boolean);
  const epgMap = await IPTVDb.getEpgForChannels(activeAccount.id, epgIds);

  const now = Math.floor(Date.now() / 1000);
  const maxCatchupDays = channels.reduce((m, c) => Math.max(m, Number(c.catchupDays) || 0), 0);
  const windowStart = now - maxCatchupDays * 86400;

  // Window end = latest programme stop across channels, fallback now + 3h.
  let windowEnd = now + 3 * 3600;
  channels.forEach(c => {
    const list = epgMap[c.epgChannelId] || [];
    if (list.length) windowEnd = Math.max(windowEnd, list[list.length - 1].stop);
  });

  const totalMin = Math.max(1, (windowEnd - windowStart) / 60);
  const trackWidth = Math.round(totalMin * EPG_PX_PER_MIN);

  epgGridScroll.innerHTML = '';
  epgGridScroll.style.setProperty('--epg-chan-w', EPG_CHAN_WIDTH + 'px');

  // Timeline header (hourly ticks aligned to the hour).
  const timeline = document.createElement('div');
  timeline.className = 'epg-grid-timeline';
  const corner = document.createElement('div');
  corner.className = 'epg-corner';
  timeline.appendChild(corner);

  const firstHour = Math.ceil(windowStart / 3600) * 3600;
  for (let t = firstHour; t < windowEnd; t += 3600) {
    const tick = document.createElement('div');
    tick.className = 'epg-tick';
    tick.style.width = (60 * EPG_PX_PER_MIN) + 'px';
    tick.style.marginLeft = (t === firstHour ? Math.round((firstHour - windowStart) / 60 * EPG_PX_PER_MIN) : 0) + 'px';
    tick.textContent = epgFormatClock(t);
    timeline.appendChild(tick);
  }
  epgGridScroll.appendChild(timeline);

  // Now-line.
  const nowLine = document.createElement('div');
  nowLine.className = 'epg-now-line';
  nowLine.style.left = (EPG_CHAN_WIDTH + Math.round((now - windowStart) / 60 * EPG_PX_PER_MIN)) + 'px';
  epgGridScroll.appendChild(nowLine);

  channels.forEach(channel => {
    const row = document.createElement('div');
    row.className = 'epg-grid-row';

    const chanCell = document.createElement('div');
    chanCell.className = 'epg-grid-channel';
    const img = document.createElement('img');
    img.src = channel.logo || 'assets/placeholder.png';
    img.onerror = () => { img.src = 'assets/placeholder.png'; };
    const nameSpan = document.createElement('span');
    nameSpan.textContent = channel.name || 'Channel';
    chanCell.appendChild(img);
    chanCell.appendChild(nameSpan);
    chanCell.addEventListener('click', () => playEpgLive(channel));
    row.appendChild(chanCell);

    const track = document.createElement('div');
    track.className = 'epg-grid-track';
    track.style.width = trackWidth + 'px';

    const programmes = epgMap[channel.epgChannelId] || [];
    if (!programmes.length) {
      const ph = document.createElement('div');
      ph.className = 'epg-prog';
      ph.style.left = '4px';
      ph.style.width = '180px';
      ph.style.opacity = '0.5';
      ph.textContent = 'Keine Programmdaten';
      track.appendChild(ph);
    }

    programmes.forEach(p => {
      if (p.stop <= windowStart || p.start >= windowEnd) return;
      const left = Math.round((p.start - windowStart) / 60 * EPG_PX_PER_MIN);
      const width = Math.max(2, Math.round((p.stop - p.start) / 60 * EPG_PX_PER_MIN) - 2);
      const block = document.createElement('div');
      block.className = 'epg-prog';
      block.style.left = left + 'px';
      block.style.width = width + 'px';

      const isLive = p.start <= now && p.stop > now;
      const isPast = p.stop <= now;
      const isFuture = p.start > now;
      const hasCatchup = channel.catchup === 1 && isPast && p.start >= (now - (Number(channel.catchupDays) || 0) * 86400);

      if (isLive) block.classList.add('current');
      else if (hasCatchup) block.classList.add('archive');
      else if (isFuture) block.classList.add('future');

      const title = document.createElement('div');
      title.className = 'epg-prog-title';
      title.textContent = p.title || '—';
      const time = document.createElement('div');
      time.className = 'epg-prog-time';
      time.textContent = `${epgFormatClock(p.start)}–${epgFormatClock(p.stop)}`;
      block.appendChild(title);
      block.appendChild(time);

      block.addEventListener('click', (e) => {
        e.stopPropagation();
        handleEpgProgramClick(channel, p, { isLive, hasCatchup, isFuture });
      });
      block.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        epgContextMenu(channel, p, { isLive, hasCatchup });
      });

      track.appendChild(block);
    });

    row.appendChild(track);
    epgGridScroll.appendChild(row);
  });

  // Scroll so the now-line is roughly centered.
  epgGridScroll.scrollLeft = Math.max(0, (now - windowStart) / 60 * EPG_PX_PER_MIN - 300);
}
```

- [ ] **Step 4: Add smart-click + helpers (reuse existing routing)**

In `renderer.js`, add:

```js
// Adapt an XMLTV programme to the base64 shape playTimeshift/showContextMenu expect.
function epgToListing(p) {
  return {
    start_timestamp: p.start,
    stop_timestamp: p.stop,
    title: btoa(unescape(encodeURIComponent(p.title || '')))
  };
}

function playEpgLive(channel) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${channel.streamId}.ts`;
  currentLiveChannelUrl = url;
  currentLiveChannelName = channel.name;
  currentLiveChannelGroup = channel.group || 'Live Channel';
  currentLiveChannelLogo = channel.logo;
  isTimeshiftActive = false;
  localStorage.setItem('lastSelectedId_live', channel.streamId);
  closeEpgGrid();
  playChannel(channel.name, 'Live Channel', channel.logo, url);
  loadEpgSidebar(channel.streamId, channel.catchup === 1);
}

function handleEpgProgramClick(channel, p, flags) {
  currentLiveChannelName = channel.name;
  currentLiveChannelLogo = channel.logo;
  if (flags.isLive) {
    playEpgLive(channel);
  } else if (flags.hasCatchup) {
    closeEpgGrid();
    loadEpgSidebar(channel.streamId, channel.catchup === 1);
    playTimeshift(epgToListing(p), channel.streamId);
  } else {
    showEpgDetails(channel, p);
  }
}

function epgContextMenu(channel, p, flags) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  if (flags.isLive) {
    const url = `${baseUrl}/live/${activeAccount.username}/${activeAccount.password}/${channel.streamId}.ts`;
    window.electronAPI.showContextMenu(channel.name, url);
  } else if (flags.hasCatchup) {
    const durationMins = Math.floor((p.stop - p.start) / 60) || 60;
    const startFormatted = formatTimeshiftDate(p.start);
    const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${channel.streamId}.ts`;
    window.electronAPI.showContextMenu(`${channel.name} (Archiv: ${p.title})`, url);
  }
}

function showEpgDetails(channel, p) {
  const when = `${epgFormatClock(p.start)}–${epgFormatClock(p.stop)}`;
  alert(`${channel.name}\n${p.title}\n${when}\n\n${p.desc || ''}`.trim());
}
```

(`showEpgDetails` uses a simple `alert` popover for future programs — consistent with the existing `alert` usage in `syncAllData`. A styled popover can replace it later without changing callers.)

- [ ] **Step 5: Wire toggle/refresh/close + Esc**

In `renderer.js`, where other DOM listeners are registered (near the `categoryFilter` / control listeners), add:

```js
if (btnToggleGuide) btnToggleGuide.addEventListener('click', () => {
  if (appContainer.classList.contains('guide-open')) closeEpgGrid();
  else openEpgGrid();
});
if (btnEpgClose) btnEpgClose.addEventListener('click', closeEpgGrid);
if (btnEpgRefresh) btnEpgRefresh.addEventListener('click', async () => {
  btnEpgRefresh.disabled = true;
  const prev = btnEpgRefresh.textContent;
  btnEpgRefresh.textContent = '⏳ ...';
  try {
    await fetchAndStoreEpg(activeAccount);
    await renderEpgGrid();
  } catch (e) {
    console.warn('[EPG] refresh failed:', e.message);
  } finally {
    btnEpgRefresh.disabled = false;
    btnEpgRefresh.textContent = prev;
  }
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && appContainer.classList.contains('guide-open')) closeEpgGrid();
});
```

- [ ] **Step 6: Syntax check**

Run: `node -c renderer.js`
Expected: no output, exit 0.

- [ ] **Step 7: Manual verification**

Run: `npm start`. With a synced Xtream account:
- Click **📅 TV Guide** → left pane + player hide, grid fills width; "Stand: …" shows.
- Verify pinned channel column + time header on scroll; now-line at the right position; current program highlighted.
- Click a **live** program → grid closes, channel plays live; sidebar EPG loads.
- Click a **past + catchup** program → timeshift plays.
- Click a **future** program → details popover; no playback.
- Toggle **MPV Mode ON** and repeat live/catchup clicks → playback opens in MPV.
- Click **🔄 Refresh** → "Stand: …" timestamp updates.
- Press **Esc** → grid closes.
- Switch to a preset/M3U playlist → **TV Guide** button is hidden.

- [ ] **Step 8: Commit**

```bash
git add renderer.js
git commit -m "feat(epg): render TV guide grid with smart-click playback"
```

---

## Task 9: Packaging + final verification

**Files:**
- Modify: `package.json` (electron-builder `files`)

- [ ] **Step 1: Add new files to the build**

In `package.json` `build.files`, add the three new files so they ship in the AppImage:

```json
    "files": [
      "main.js",
      "preload.js",
      "renderer.js",
      "index.html",
      "stream_info.html",
      "style.css",
      "assets/**/*",
      "db.js",
      "epg-parse.js",
      "epg-worker.js",
      "package.json"
    ],
```

- [ ] **Step 2: Run unit tests**

Run: `npm test`
Expected: PASS — all parser tests green.

- [ ] **Step 3: Syntax-check all touched JS**

Run: `node -c main.js && node -c renderer.js && node -c db.js && node -c epg-parse.js && node -c epg-worker.js`
Expected: no output, exit 0.

- [ ] **Step 4: Code-health check (per CLAUDE.md)**

Run: `fallow health --file-scores`
Expected: no new dead-code/hotspot regressions for the new files. Address any flagged issues.

- [ ] **Step 5: Commit**

```bash
git add package.json
git commit -m "build(epg): include EPG parser and worker in AppImage"
```

---

## Self-Review Notes

- **Spec coverage:**
  - Coexist with sidebar → grid is a separate toggle; sidebar untouched (Tasks 7-8).
  - Current live category scope → `getStreamsByCategory` keyed off `categoryFilter.value` (Task 8).
  - XMLTV dump prefetch on sync + cache → Tasks 4-6.
  - Past+future window, past = catchup_days → `windowStart`/`windowEnd` (Task 8).
  - Smart click + MPV routing → reuses `playChannel`/`playTimeshift`/`showContextMenu` (Task 8).
  - Replace central area + hide left pane → `guide-open` class (Tasks 7-8).
  - Manual refresh, no TTL → refresh button only (Task 8); sync prefetch (Task 6).
  - XML parse in worker, dependency-free, node-testable → Tasks 1-3.
  - Error handling: non-fatal sync, empty states, worker fallback → Tasks 6, 8.
  - Xtream-only → Guide button hidden for M3U (Task 8 Step 2).
  - Testing: parser unit tests + manual matrix → Tasks 1-2, 8.
- **Type/name consistency:** `parseXmltv`/`xmltvTimeToEpoch`, `saveEpg`/`getEpgForChannels`/`getEpgMeta`, `epgChannelId`, `fetchAndStoreEpg`/`parseXmltvAsync`, `openEpgGrid`/`closeEpgGrid`/`renderEpgGrid`, `EPG_PX_PER_MIN`/`EPG_CHAN_WIDTH` are used consistently across tasks.
- **Open implementation tunables (from spec):** `EPG_PX_PER_MIN`, `EPG_CHAN_WIDTH`, and initial scroll offset are set to sensible defaults in Task 8; tune during manual testing.
```
