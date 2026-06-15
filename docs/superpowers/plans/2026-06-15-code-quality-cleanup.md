# Code Quality Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminate the 4 remaining code quality hotspots identified by fallow: split `buildFfmpegArgs`, extract `idbQueryByAccountId` helper in db.js, extract `proxyFetch` helper in main.js, and split `renderEpgGrid`.

**Architecture:** All changes are mechanical refactors — extract helpers, replace inline duplicates with calls. Zero logic changes. Each task is fully self-contained in a single file.

**Tech Stack:** Vanilla JS, Node.js (main.js — CommonJS), Browser globals (db.js, renderer-epg.js)

---

## File Map

| File | Action | What changes |
|------|--------|-------------|
| `main.js` | Modify | `buildFfmpegArgs` (120L, CRAP 420) split into 4 helpers; `proxyFetch` extracted to eliminate dup:a1408a6d |
| `db.js` | Modify | `idbQueryByAccountId` helper extracted; `getCategories`, `getStreamsByCategory`, `searchStreams` simplified |
| `renderer-epg.js` | Modify | `renderEpgGrid` (185L, CRAP 210) split into `buildEpgTimeline`, `buildEpgRow`, `startEpgNowTimer` |

---

## Task 1: Extract `proxyFetch` helper in `main.js`

**Files:**
- Modify: `main.js`

The fetch-and-proxy pattern appears twice — in `handleXtreamApiRequest` (~L448) and `handleXtreamXmltvRequest` (~L482). Both are structurally identical: fetch a URL, on success write `200` + body, on error write 5xx + JSON error.

- [ ] **Step 1: Add `proxyFetch` helper** immediately before `handleXtreamApiRequest` in `main.js`:

```js
// Proxy a fetch to targetUrl and write the response to res.
// successHeaders: object of headers to send on 200.
// errCode: HTTP status code on failure (default 500).
function proxyFetch(targetUrl, res, successHeaders, errCode = 500) {
  fetch(targetUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response.text();
    })
    .then(body => {
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', ...successHeaders });
      res.end(body);
    })
    .catch(err => {
      console.error(`[proxyFetch] ${targetUrl}: ${err.message}`);
      res.writeHead(errCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy fetch failed', details: err.message }));
    });
}
```

- [ ] **Step 2: Replace the fetch block in `handleXtreamApiRequest`.**

  Find this block (approximately lines 451–465):
  ```js
  fetch(targetUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response.text();
    })
    .then(body => {
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    })
    .catch(err => {
      console.error('Xtream API Proxy Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch from Xtream server', details: err.message }));
    });
  ```
  Replace with:
  ```js
  proxyFetch(targetUrl, res, { 'Content-Type': 'application/json' }, 500);
  ```

- [ ] **Step 3: Replace the fetch block in `handleXtreamXmltvRequest`.**

  Find this block (approximately lines 490–502):
  ```js
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
  ```
  Replace with:
  ```js
  proxyFetch(targetUrl, res, { 'Content-Type': 'application/xml' }, 502);
  ```

- [ ] **Step 4: Syntax-check and verify:**
  ```bash
  node -c main.js
  ```
  Expected: `main.js OK`

  Also verify both handler functions still end correctly after the replacement (no dangling braces):
  ```bash
  node -e "require('./main.js')" 2>&1 | head -5
  ```

---

## Task 2: Split `buildFfmpegArgs` in `main.js`

**Files:**
- Modify: `main.js`

`buildFfmpegArgs` (CRAP 420, 120L, cyclomatic 20) handles 5 distinct concerns in one function. Split into 4 focused helpers + thin orchestrator.

- [ ] **Step 1: Add 4 helper functions** directly before `buildFfmpegArgs` in `main.js`:

```js
// Push network reconnect flags appropriate for live vs archive streams.
function buildReconnectArgs(ffmpegArgs, isTimeshift) {
  if (isTimeshift) {
    ffmpegArgs.push('-reconnect', '1', '-reconnect_delay_max', '2');
  } else {
    ffmpegArgs.push(
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }
}

// Push probe/analyze size limits appropriate for live/timeshift vs VOD.
function buildProbeArgs(ffmpegArgs, isLive, isTimeshift) {
  if (isLive || isTimeshift) {
    ffmpegArgs.push('-probesize', '1000000', '-analyzeduration', '1000000');
    if (isTimeshift) {
      ffmpegArgs.push('-correct_ts_overflow', '1', '-readrate_initial_burst', '10', '-readrate', '1.5');
    }
  } else {
    ffmpegArgs.push('-probesize', '15000000', '-analyzeduration', '5000000');
  }
}

// Determine whether video transcoding is needed and push video codec args.
// Returns true if transcoding, false if copy.
function buildVideoArgs(ffmpegArgs, codec, isTimeshift, clientSupportsHEVC) {
  const unsupportedCodecs = ['hevc', 'h265', 'mpeg2video', 'vc1', 'mpeg4', 'msmpeg4v3', 'wmv3'];
  let needTranscoding = unsupportedCodecs.includes(codec.toLowerCase());

  if (codec === 'unknown' && !isTimeshift) {
    // handled by caller for MKV VOD — keep existing behavior
  }
  if (isTimeshift) {
    console.log('[Proxy] Timeshift stream detected: forcing H.264 transcode to fix timeline discontinuities.');
    needTranscoding = true;
  }
  if (needTranscoding && (codec.toLowerCase() === 'hevc' || codec.toLowerCase() === 'h265') && clientSupportsHEVC) {
    console.log('[Proxy] Client supports HEVC natively, bypassing transcoding and using copy mode.');
    needTranscoding = false;
  }

  if (needTranscoding) {
    console.log(`Transcoding video from ${codec} to h264`);
    ffmpegArgs.push('-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '26', '-tune', 'zerolatency', '-pix_fmt', 'yuv420p');
  } else {
    console.log(`Copying video stream (codec: ${codec})`);
    ffmpegArgs.push('-c:v', 'copy');
  }
  return needTranscoding;
}

// Push audio codec args.
function buildAudioArgs(ffmpegArgs, isLive, isTimeshift) {
  ffmpegArgs.push('-c:a', 'aac', '-b:a', '192k', '-ac', '2');
  if (isLive || isTimeshift) {
    ffmpegArgs.push('-af', 'aresample=async=1');
  }
}
```

- [ ] **Step 2: Replace the body of `buildFfmpegArgs`** with the orchestrator that calls the 4 helpers.

  The new `buildFfmpegArgs` body (keep the function signature unchanged: `function buildFfmpegArgs(targetStreamUrl, isLive, codec, start, clientSupportsHEVC)`):

```js
function buildFfmpegArgs(targetStreamUrl, isLive, codec, start, clientSupportsHEVC) {
  const ffmpegArgs = ['-loglevel', 'warning'];
  const isTimeshift = targetStreamUrl.toLowerCase().includes('/timeshift/');

  buildReconnectArgs(ffmpegArgs, isTimeshift);
  buildProbeArgs(ffmpegArgs, isLive, isTimeshift);

  // Always generate PTS and discard corrupt packets to handle stream discontinuities/sync issues
  if (isTimeshift) {
    ffmpegArgs.push('-fflags', '+genpts+igndts+discardcorrupt');
  } else {
    ffmpegArgs.push('-fflags', '+genpts+discardcorrupt');
  }

  if (start) {
    ffmpegArgs.push('-ss', start.toString());
  }
  ffmpegArgs.push(
    '-i', targetStreamUrl,
    '-map', '0:v?',
    '-map', '0:a?',
    '-sn',
    '-dn'
  );

  if (isLive || isTimeshift) {
    ffmpegArgs.push('-avoid_negative_ts', 'make_zero');
  }

  // If codec detection failed but it's an MKV file on VOD, default to H.264 transcode for safety
  if (codec === 'unknown' && !isLive && targetStreamUrl.toLowerCase().split('?')[0].endsWith('.mkv')) {
    console.warn(`[Proxy] Codec detection failed on VOD MKV stream, defaulting to H.264 transcode for safety.`);
    codec = 'mpeg4'; // trigger needTranscoding path in buildVideoArgs
  }

  const needTranscoding = buildVideoArgs(ffmpegArgs, codec, isTimeshift, clientSupportsHEVC);
  buildAudioArgs(ffmpegArgs, isLive, isTimeshift);

  ffmpegArgs.push('-f', 'mpegts', 'pipe:1');

  return { ffmpegArgs, needTranscoding };
}
```

- [ ] **Step 3: Syntax-check:**
  ```bash
  node -c main.js
  ```
  Expected: `main.js OK`

- [ ] **Step 4: Verify require still works:**
  ```bash
  node -e "require('./main.js')" 2>&1 | head -5
  ```
  Expected: no syntax/require errors (startup log lines are fine).

---

## Task 3: Extract `idbQueryByAccountId` helper in `db.js`

**Files:**
- Modify: `db.js`

`getCategories`, `getStreamsByCategory`, and `searchStreams` all open the same IDB transaction and call `index.getAll(IDBKeyRange.only(accountId))`. Extract the boilerplate into one shared helper.

- [ ] **Step 1: Add `idbQueryByAccountId` helper** inside the `IPTVDb` object, immediately before `getCategories`. The helper runs the IDB query and resolves with the raw results array:

```js
  // Internal helper: open a readonly IDB transaction on storeName, query by accountId,
  // and resolve with the full results array (before any filtering).
  _idbQueryByAccountId(storeName, accountId) {
    return new Promise((resolve, reject) => {
      const transaction = this.db.transaction([storeName], 'readonly');
      const store = transaction.objectStore(storeName);
      const index = store.index('accountId');
      const request = index.getAll(IDBKeyRange.only(accountId));
      request.onsuccess = () => resolve(request.result);
      request.onerror = (e) => reject(e.target.error);
    });
  },
```

- [ ] **Step 2: Simplify `getCategories`** to use the helper:

  Replace the body of `getCategories(storeName, accountId)` with:
  ```js
  getCategories(storeName, accountId) {
    console.log(`[DB getCategories] Querying ${storeName} for accountId:`, accountId);
    return this._idbQueryByAccountId(storeName, accountId).then(result => {
      console.log(`[DB getCategories] Query success for ${storeName}. Found:`, result.length);
      return result;
    });
  },
  ```

- [ ] **Step 3: Simplify `getStreamsByCategory`** to use the helper:

  Replace the body of `getStreamsByCategory(storeName, accountId, categoryId)` with:
  ```js
  getStreamsByCategory(storeName, accountId, categoryId) {
    return this._idbQueryByAccountId(storeName, accountId).then(items => {
      if (categoryId === 'all') return items;
      return items.filter(item => String(item.categoryId) === String(categoryId));
    });
  },
  ```

- [ ] **Step 4: Simplify `searchStreams`** to use the helper:

  Replace the body of `searchStreams(storeName, accountId, query)` with:
  ```js
  searchStreams(storeName, accountId, query) {
    return this._idbQueryByAccountId(storeName, accountId).then(items => {
      if (!query) return items;
      const lowerQuery = query.toLowerCase();
      return items.filter(item => item.name && item.name.toLowerCase().includes(lowerQuery));
    });
  },
  ```

- [ ] **Step 5: Syntax-check:**
  ```bash
  node -c db.js
  ```
  Expected: `db.js OK`

---

## Task 4: Split `renderEpgGrid` in `renderer-epg.js`

**Files:**
- Modify: `renderer-epg.js`

`renderEpgGrid` (185L, CRAP 210, cyc 14) mixes 3 concerns: building the timeline header, building each channel row with its programme blocks, and setting up the now-line timer. Extract into 3 helpers.

- [ ] **Step 1: Read `renderer-epg.js` lines 152–337** to understand the full `renderEpgGrid` body before editing.

- [ ] **Step 2: Add `buildEpgTimeline(windowStart, windowEnd, trackWidth)` helper** directly before `renderEpgGrid`. This function builds and returns the timeline header div + the date label div:

```js
// Build the timeline header row (hourly ticks) and sticky date label.
// Returns { timeline, dateLabel, updateDateLabel }.
function buildEpgTimeline(windowStart, windowEnd, trackWidth) {
  const timeline = document.createElement('div');
  timeline.className = 'epg-timeline';
  timeline.style.width = trackWidth + 'px';

  const corner = document.createElement('div');
  corner.className = 'epg-corner';
  timeline.appendChild(corner);

  const firstHour = Math.ceil(windowStart / 3600) * 3600;
  for (let t = firstHour; t < windowEnd; t += 3600) {
    const tick = document.createElement('div');
    tick.className = 'epg-hour-tick';
    tick.style.left = Math.round((t - windowStart) / 60 * EPG_PX_PER_MIN) + 'px';
    tick.textContent = epgFormatClock(t);
    timeline.appendChild(tick);
  }

  const dateLabel = document.createElement('div');
  dateLabel.className = 'epg-date-label';

  const updateDateLabel = () => {
    const scrollSec = windowStart + (epgGridScroll.scrollLeft / EPG_PX_PER_MIN) * 60;
    const d = new Date(scrollSec * 1000);
    dateLabel.textContent = d.toLocaleDateString('de-DE', { weekday: 'short', day: '2-digit', month: '2-digit' });
  };

  return { timeline, dateLabel, updateDateLabel };
}
```

  **Note:** Read the actual `renderEpgGrid` body to verify the exact class names and structure match. Adjust the helper code above if the actual code uses different class names or structure. Do NOT guess — read the file.

- [ ] **Step 3: Add `buildEpgChannelRow(channel, epgMap, windowStart, windowEnd, trackWidth, now)` helper** directly before `renderEpgGrid`. This function builds and returns a single channel row div (channel cell + programme track):

```js
// Build one channel row (sticky channel cell + programme track).
function buildEpgChannelRow(channel, epgMap, windowStart, windowEnd, trackWidth, now) {
  const row = document.createElement('div');
  row.className = 'epg-row';
  row.dataset.channelId = channel.epgChannelId;

  const chanCell = document.createElement('div');
  chanCell.className = 'epg-grid-channel';

  const img = document.createElement('img');
  img.src = channel.logo || '';
  img.onerror = () => { img.style.display = 'none'; };
  chanCell.appendChild(img);

  const nameSpan = document.createElement('span');
  nameSpan.textContent = channel.name;
  chanCell.appendChild(nameSpan);

  if (channel.catchup) {
    const badge = document.createElement('span');
    badge.className = 'epg-catchup-badge';
    badge.textContent = 'C';
    chanCell.appendChild(badge);
  }

  row.appendChild(chanCell);

  const track = document.createElement('div');
  track.className = 'epg-track';
  track.style.width = trackWidth + 'px';

  const programmes = epgMap[channel.epgChannelId] || [];
  if (programmes.length === 0) {
    const ph = document.createElement('div');
    ph.className = 'epg-prog epg-prog-empty';
    ph.style.width = trackWidth + 'px';
    ph.textContent = 'Keine Programmdaten';
    track.appendChild(ph);
  } else {
    programmes.forEach(p => {
      const s = Number(p.start), e = Number(p.stop);
      if (e <= windowStart || s >= windowEnd) return;
      const left = Math.round(Math.max(0, (s - windowStart) / 60 * EPG_PX_PER_MIN));
      const width = Math.round(Math.max(20, Math.min(e, windowEnd) - Math.max(s, windowStart)) / 60 * EPG_PX_PER_MIN);
      const prog = document.createElement('div');
      prog.className = 'epg-prog';
      prog.style.left = left + 'px';
      prog.style.width = width + 'px';
      prog.dataset.start = s;
      prog.dataset.stop = e;
      prog.textContent = p.title || '';
      if (s <= now && e > now) prog.classList.add('epg-prog-now');
      prog.addEventListener('click', () => {
        const isLive = s <= now && e > now;
        const hasCatchup = channel.catchup && e < now;
        handleEpgProgramClick(channel, p, { isLive, hasCatchup });
      });
      prog.addEventListener('contextmenu', (ev) => {
        ev.preventDefault();
        const isLive = s <= now && e > now;
        const hasCatchup = channel.catchup && e < now;
        epgContextMenu(channel, p, { isLive, hasCatchup });
      });
      track.appendChild(prog);
    });
  }

  row.appendChild(track);
  return row;
}
```

  **Note:** Read the actual `renderEpgGrid` body for exact class names, dataset attributes, and logic before writing this helper. Adjust to match exactly. Do NOT guess.

- [ ] **Step 4: Replace `renderEpgGrid` body** with the orchestrator that calls the two helpers:

```js
async function renderEpgGrid() {
  if (!epgGridScroll) return;
  epgGridScroll.innerHTML = '<div class="epg-grid-empty">Lade Programmübersicht...</div>';

  const categoryId = (epgGridCategory && epgGridCategory.value && epgGridCategory.value !== 'all')
    ? epgGridCategory.value : null;

  if (!categoryId) {
    epgGridScroll.innerHTML = '<div class="epg-grid-empty">Bitte eine Kategorie auswählen.</div>';
    return;
  }

  const channels = (await IPTVDb.getStreamsByCategory('live_streams', activeAccount.id, categoryId)) || [];
  const meta = await IPTVDb.getEpgMeta(activeAccount.id);

  if (channels.length === 0 || !meta) {
    epgGridScroll.innerHTML = '<div class="epg-grid-empty">Keine Kanäle in dieser Kategorie.</div>';
    return;
  }

  const epgIds = channels.map(c => c.epgChannelId).filter(Boolean);
  const epgMap = await IPTVDb.getEpgForChannels(activeAccount.id, epgIds);

  const now = Math.floor(Date.now() / 1000);

  let windowStart = now;
  let windowEnd = now + 3 * 3600;
  channels.forEach(c => {
    const list = epgMap[c.epgChannelId] || [];
    list.forEach(p => {
      if (Number(p.start) < windowStart) windowStart = Number(p.start);
      if (Number(p.stop) > windowEnd) windowEnd = Number(p.stop);
    });
  });
  epgWindowStart = windowStart;

  const totalMin = Math.max(1, (windowEnd - windowStart) / 60);
  const trackWidth = Math.round(totalMin * EPG_PX_PER_MIN);

  epgGridScroll.innerHTML = '';

  const { timeline, dateLabel, updateDateLabel } = buildEpgTimeline(windowStart, windowEnd, trackWidth);
  epgGridScroll.appendChild(timeline);
  epgGridScroll.appendChild(dateLabel);
  updateDateLabel();
  epgGridScroll.addEventListener('scroll', updateDateLabel);

  const nowLine = document.createElement('div');
  nowLine.className = 'epg-now-line';
  epgGridScroll.appendChild(nowLine);

  const updateNowMarker = () => {
    const n = Math.floor(Date.now() / 1000);
    nowLine.style.left = (EPG_CHAN_WIDTH + Math.round((n - windowStart) / 60 * EPG_PX_PER_MIN)) + 'px';
    epgGridScroll.querySelectorAll('.epg-prog').forEach(el => {
      const s = Number(el.dataset.start), e = Number(el.dataset.stop);
      el.classList.toggle('epg-prog-now', s <= n && e > n);
    });
  };
  updateNowMarker();

  if (epgNowLineTimer) clearInterval(epgNowLineTimer);
  epgNowLineTimer = setInterval(updateNowMarker, 30000);

  channels.forEach(channel => {
    const row = buildEpgChannelRow(channel, epgMap, windowStart, windowEnd, trackWidth, now);
    epgGridScroll.appendChild(row);
  });

  nowLine.style.height = epgGridScroll.scrollHeight + 'px';
  epgGridScroll.scrollLeft = Math.max(0, (now - windowStart) / 60 * EPG_PX_PER_MIN - 300);

  if (epgGridUpdated) {
    const ts = meta.updatedAt ? new Date(meta.updatedAt).toLocaleString('de-DE') : '–';
    epgGridUpdated.textContent = `Stand: ${ts}`;
  }
}
```

  **Note:** Again — read the actual `renderEpgGrid` body first and reconcile with the orchestrator above. The orchestrator must be a faithful rewrite, not a guess. If the actual code has logic not captured above, preserve it.

- [ ] **Step 5: Syntax-check:**
  ```bash
  node -c renderer-epg.js
  ```
  Expected: `renderer-epg.js OK`

---

## Task 5: Verify all files and commit

- [ ] **Step 1: Syntax-check all modified files:**
  ```bash
  node -c main.js && node -c db.js && node -c renderer-epg.js && echo "ALL OK"
  ```
  Expected: `ALL OK`

- [ ] **Step 2: Run fallow health to confirm CRAP improvement:**
  ```bash
  FALLOW_AGENT_SOURCE=windsurf fallow health --file-scores --format json --quiet 2>/dev/null | python3 -c "
  import json,sys
  d=json.load(sys.stdin)
  for f in d['file_scores']:
      print(f\"{f['path']:<30} CRAP-violations={f['crap_above_threshold']}\")
  print('Total CRAP violations:', d['summary']['functions_above_threshold'])
  " || true
  ```

- [ ] **Step 3: Run fallow dupes to confirm clone groups eliminated:**
  ```bash
  FALLOW_AGENT_SOURCE=windsurf fallow dupes --format json --quiet 2>/dev/null | python3 -c "
  import json,sys
  d=json.load(sys.stdin)
  print(f\"{len(d['clone_groups'])} clone groups remaining\")
  " || true
  ```

- [ ] **Step 4: Commit:**
  ```bash
  git add main.js db.js renderer-epg.js
  git commit -m "$(cat <<'EOF'
  refactor: extract helpers to reduce CRAP scores and duplication

  main.js:
  - Extract proxyFetch() helper (eliminates dup:a1408a6d)
  - Split buildFfmpegArgs into buildReconnectArgs, buildProbeArgs,
    buildVideoArgs, buildAudioArgs (CRAP 420 → distributed)

  db.js:
  - Extract _idbQueryByAccountId() helper
  - Simplify getCategories, getStreamsByCategory, searchStreams
    (eliminates dup:e4e947a2 + dup:63b45b7c)

  renderer-epg.js:
  - Split renderEpgGrid (185L) into buildEpgTimeline,
    buildEpgChannelRow helpers (CRAP 210 → distributed)

  Generated with Devin (https://cli.devin.ai/docs)

  Co-Authored-By: Devin <158243242+devin-ai-integration[bot]@users.noreply.github.com>
  EOF
  )"
  ```
