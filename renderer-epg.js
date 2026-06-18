function buildTimeshiftUrl(listing, streamId) {
  const baseUrl = getAccountBaseUrl(activeAccount);
  const durationMins = Math.floor((Number(listing.stop_timestamp || listing.end_timestamp) - Number(listing.start_timestamp)) / 60) || 60;
  const startFormatted = formatTimeshiftDate(listing.start_timestamp);
  return `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
}

// --- EPG & Timeshift helpers ---

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

  // Prefetch EPG history for timeshift-enabled channels in parallel.
  try {
    const catchupStreams = await IPTVDb.getCatchupStreams(account.id);
    console.log(`[EPG Sync] Found ${catchupStreams.length} timeshift-enabled channels to fetch history for.`);

    const loaderText = document.getElementById('loader-text');
    const syncStep = document.getElementById('sync-step');

    const fetcher = (stream) => fetchXtreamApi(account, 'get_simple_data_table', { stream_id: stream.streamId });
    const onProgress = (current, total, stream) => {
      const text = `Syncing TV Guide history (${current}/${total}): ${stream.name}...`;
      if (loaderText) loaderText.textContent = text;
      if (syncStep) syncStep.textContent = text;
    };

    const stats = await prefetchEpgHistory(catchupStreams, {
      fetcher,
      onProgress,
      concurrency: 4,
      perFetchTimeoutMs: 15000
    });

    // Persist fetched history into IDB using the results already in hand.
    let merged = 0;
    for (const { stream, listings, error } of stats.results) {
      if (error) continue;
      if (!stream || !stream.epgChannelId) continue;
      if (listings && listings.epg_listings && listings.epg_listings.length > 0) {
        const xmltvProgs = listings.epg_listings.map(mapEpgListingToXmltvProg);
        await IPTVDb.mergeChannelEpg(account.id, stream.epgChannelId, xmltvProgs);
        merged += xmltvProgs.length;
      }
    }
    console.log(`[EPG Sync] Timeshift prefetch done. fetched=${stats.succeeded}/${stats.total} failed=${stats.failed} skipped=${stats.skipped} merged=${merged}`);
  } catch (err) {
    console.warn('[EPG Sync] Error identifying/fetching timeshift channels:', err);
  }

  return channelMap;
}

// Parse XMLTV off the UI thread when possible, else fall back to the global parseXmltv.
function parseXmltvAsync(xml) {
  return new Promise((resolve) => {
    const fallback = (why) => {
      console.warn('[EPG] parsing on main thread (fallback). reason:', why);
      const map = (typeof parseXmltv === 'function') ? parseXmltv(xml) : {};
      console.log('[EPG] main-thread parse produced', Object.keys(map || {}).length, 'channels');
      resolve(map);
    };

    if (typeof Worker === 'undefined') {
      fallback('Worker unavailable');
      return;
    }
    let worker;
    try {
      worker = new Worker('epg-worker.js');
    } catch (e) {
      fallback('Worker constructor threw: ' + (e && e.message));
      return;
    }

    let settled = false;
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); try { worker.terminate(); } catch (_) {} fn(); };

    // Watchdog: if the worker neither responds nor errors, don't hang the whole sync.
    const timer = setTimeout(() => {
      finish(() => fallback('worker timeout (no response in 30s)'));
    }, 30000);

    console.log('[EPG] worker created, posting', xml.length, 'chars for off-thread parse');
    worker.onmessage = (ev) => {
      if (ev.data && ev.data.error) {
        finish(() => fallback('worker reported error: ' + ev.data.error));
      } else {
        const map = (ev.data && ev.data.channelMap) || {};
        console.log('[EPG] worker returned', Object.keys(map).length, 'channels');
        finish(() => resolve(map));
      }
    };
    worker.onerror = (e) => {
      console.warn('[EPG] worker.onerror:', e && e.message, '@', e && e.filename, 'line', e && e.lineno);
      finish(() => fallback('worker.onerror'));
    };
    worker.postMessage({ xml });
  });
}

const EPG_PX_PER_MIN = 5;
const EPG_CHAN_WIDTH = 200;
let epgNowLineTimer = null;
let epgWindowStart = 0;

function openEpgGrid() {
  if (activePlaylistType !== 'xtream' || !activeAccount) return;
  appContainer.classList.add('guide-open');
  if (epgGridContainer) epgGridContainer.style.display = 'flex';
  localStorage.setItem('epgView', 'grid');
  populateEpgGridCategory().finally(() => renderEpgGrid());
}

async function populateEpgGridCategory() {
  if (!epgGridCategory || !activeAccount) return;
  try {
    const cats = (await IPTVDb.getCategories('live_categories', activeAccount.id)) || [];
    const prev = epgGridCategory.value;
    epgGridCategory.innerHTML = '<option value="all">Alle Kategorien</option>';
    cats.sort((a, b) => (a.categoryName || '').localeCompare(b.categoryName || '')).forEach(c => {
      const opt = document.createElement('option');
      opt.value = c.categoryId;
      opt.textContent = c.categoryName;
      epgGridCategory.appendChild(opt);
    });
    // Restore previous selection if still valid
    const lastCat = prev || localStorage.getItem('epgGridCategory') || 'all';
    if (Array.from(epgGridCategory.options).some(o => o.value === lastCat)) {
      epgGridCategory.value = lastCat;
    }
  } catch (e) {
    console.warn('[EPG] populateEpgGridCategory error:', e);
  }
}

function closeEpgGrid() {
  appContainer.classList.remove('guide-open');
  if (epgGridContainer) epgGridContainer.style.display = 'none';
  localStorage.setItem('epgView', 'none');
  if (epgNowLineTimer) { clearInterval(epgNowLineTimer); epgNowLineTimer = null; }
}

// Middle-button drag-to-scroll for EPG grid (pan in all directions).
if (epgGridScroll) {
  let isDragging = false, startX, startY, scrollL, scrollT;
  // Suppress the synthetic click that fires on mouseup after a middle-button drag,
  // otherwise the programme under the cursor would start playing after panning.
  let suppressNextClick = false;
  epgGridScroll.addEventListener('mousedown', (e) => {
    // Middle button only. Let other buttons pass through to programme/channel handlers.
    if (e.button !== 1) return;
    isDragging = true;
    startX = e.clientX; startY = e.clientY;
    scrollL = epgGridScroll.scrollLeft; scrollT = epgGridScroll.scrollTop;
    epgGridScroll.style.cursor = 'grabbing';
    e.preventDefault();
  });
  // Suppress click if drag ended on a programme block.
  epgGridScroll.addEventListener('click', (e) => {
    if (suppressNextClick && e.button === 0) {
      suppressNextClick = false;
      e.stopPropagation();
      e.preventDefault();
    }
  }, true);
  window.addEventListener('mousemove', (e) => {
    if (!isDragging) return;
    epgGridScroll.scrollLeft = scrollL - (e.clientX - startX);
    epgGridScroll.scrollTop = scrollT - (e.clientY - startY);
  });
  window.addEventListener('mouseup', (e) => {
    if (!isDragging) return;
    if (e.button !== 1) return;
    isDragging = false;
    epgGridScroll.style.cursor = '';
    // Mark the next click as suppressed so a programme under the cursor doesn't start.
    suppressNextClick = true;
    setTimeout(() => { suppressNextClick = false; }, 0);
  });
}

function epgFormatClock(epochSec) {
  return new Date(epochSec * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
}

// Build the timeline header row (hourly ticks) and sticky date label.
// Returns the timeline div and date label div (both already created, not yet appended).
// Also returns updateDateLabel so the caller can call it once and bind to scroll.
function buildEpgTimeline(windowStart, windowEnd) {
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

  const dateLabel = document.createElement('div');
  dateLabel.className = 'epg-date-label';

  const updateDateLabel = () => {
    const scrollSec = windowStart + (epgGridScroll.scrollLeft / EPG_PX_PER_MIN) * 60;
    const d = new Date(scrollSec * 1000);
    dateLabel.textContent = d.toLocaleDateString('de-DE', { weekday: 'long', day: '2-digit', month: '2-digit', year: 'numeric' });
  };

  return { timeline, dateLabel, updateDateLabel };
}

// Build one channel row (sticky channel cell + programme track). Returns the row div.
function buildEpgChannelRow(channel, epgMap, windowStart, windowEnd, trackWidth, now) {
  const row = document.createElement('div');
  row.className = 'epg-grid-row';
  row.dataset.streamId = channel.streamId;

  const chanCell = document.createElement('div');
  chanCell.className = 'epg-grid-channel';
  const img = document.createElement('img');
  img.src = channel.logo || 'assets/placeholder.png';
  img.onerror = () => { img.src = 'assets/placeholder.png'; };
  const nameSpan = document.createElement('span');
  nameSpan.textContent = channel.name || 'Channel';
  chanCell.appendChild(img);
  chanCell.appendChild(nameSpan);
  if (channel.catchup === 1) {
    const badge = document.createElement('span');
    badge.className = 'epg-grid-catchup';
    badge.textContent = '🕒';
    badge.title = 'Timeshift / Catch-up verfügbar';
    chanCell.appendChild(badge);
  }
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
    if (p.stop <= now && channel.catchup !== 1) return; // Skip historic data for non-timeshift channels
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
  return row;
}

async function renderEpgGrid() {
  if (!epgGridScroll) return;
  epgGridScroll.innerHTML = '<div class="epg-grid-empty">Lade Programmübersicht...</div>';

  // Channels of the selected grid category.
  const categoryId = (epgGridCategory && epgGridCategory.value && epgGridCategory.value !== 'all')
    ? epgGridCategory.value : null;

  if (!categoryId) {
    epgGridScroll.innerHTML = '<div class="epg-grid-empty">Bitte eine Kategorie auswählen.</div>';
    return;
  }

  const channels = (await IPTVDb.getStreamsByCategory('live_streams', activeAccount.id, categoryId)) || [];

  if (!channels.length) {
    epgGridScroll.innerHTML = '<div class="epg-grid-empty">Keine Kanäle in dieser Kategorie.</div>';
    return;
  }

  const epgIds = channels.map(c => c.epgChannelId).filter(Boolean);
  const epgMap = await IPTVDb.getEpgForChannels(activeAccount.id, epgIds);

  const now = Math.floor(Date.now() / 1000);

  // Window start = earliest programme start across all channels (not catchupDays).
  let windowStart = now;
  let windowEnd = now + 3 * 3600;
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
  epgWindowStart = windowStart;

  const totalMin = Math.max(1, (windowEnd - windowStart) / 60);
  const trackWidth = Math.round(totalMin * EPG_PX_PER_MIN);

  epgGridScroll.innerHTML = '';
  epgGridScroll.style.setProperty('--epg-chan-w', EPG_CHAN_WIDTH + 'px');

  const { timeline, dateLabel, updateDateLabel } = buildEpgTimeline(windowStart, windowEnd);
  epgGridScroll.appendChild(timeline);
  epgGridScroll.appendChild(dateLabel);
  epgGridScroll.addEventListener('scroll', updateDateLabel);
  updateDateLabel();

  // Now-line + current-programme highlight (updates every 30s).
  const nowLine = document.createElement('div');
  nowLine.className = 'epg-now-line';
  const updateNowMarker = () => {
    const n = Math.floor(Date.now() / 1000);
    nowLine.style.left = (EPG_CHAN_WIDTH + Math.round((n - windowStart) / 60 * EPG_PX_PER_MIN)) + 'px';
    // Update programme block highlights.
    epgGridScroll.querySelectorAll('.epg-prog[data-start]').forEach(el => {
      const s = Number(el.dataset.start), e = Number(el.dataset.stop);
      el.classList.toggle('current', s <= n && e > n);
    });
  };
  updateNowMarker();
  epgGridScroll.appendChild(nowLine);
  if (epgNowLineTimer) clearInterval(epgNowLineTimer);
  epgNowLineTimer = setInterval(updateNowMarker, 30000);

  channels.forEach(channel => {
    epgGridScroll.appendChild(buildEpgChannelRow(channel, epgMap, windowStart, windowEnd, trackWidth, now));
  });

  // Set now-line height to span full scrollable content.
  nowLine.style.height = epgGridScroll.scrollHeight + 'px';

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
  resetToLive();

  localStorage.setItem('lastSelectedId_live', channel.streamId);
  playChannel(channel.name, 'Live Channel', channel.logo, url);
}

function handleEpgProgramClick(channel, p, flags) {
  currentLiveChannelName = channel.name;
  currentLiveChannelLogo = channel.logo;
  if (flags.isLive) {
    playEpgLive(channel);
  } else if (flags.hasCatchup) {
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

function safeBase64Decode(str) {
  if (!str) return "";
  try {
    return decodeURIComponent(escape(atob(str)));
  } catch (e) {
    return str;
  }
}

function mapEpgListingToXmltvProg(listing) {
  return {
    start: Number(listing.start_timestamp),
    stop: Number(listing.stop_timestamp || listing.end_timestamp),
    title: safeBase64Decode(listing.title),
    desc: safeBase64Decode(listing.description),
    category: ''
  };
}

function formatTimeshiftDate(timestamp) {
  const date = new Date(Number(timestamp) * 1000);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hour = String(date.getHours()).padStart(2, '0');
  const minute = String(date.getMinutes()).padStart(2, '0');
  return `${year}-${month}-${day}:${hour}-${minute}`;
}

// fallow-ignore-next-line complexity
async function loadEpgSidebar(streamId, hasCatchup) {
  if (!liveEpgContainer || !epgList) return;
  
  if (activePlaylistType !== 'xtream') {
    setEpgContainerDisplay('none');
    return;
  }

  currentLiveChannelId = streamId;
  setEpgContainerDisplay('flex');
  epgList.innerHTML = '<div class="empty-list-placeholder">Lade Programmübersicht...</div>';
  
  try {
    const res = await fetchXtreamApi(activeAccount, 'get_simple_data_table', { stream_id: streamId });
    epgList.innerHTML = '';
    
    if (res && res.epg_listings && res.epg_listings.length > 0) {
      currentEpgListings = res.epg_listings;

      // Merge newly fetched EPG listings back to IndexedDB for the EPG Grid
      IPTVDb.getLiveStream(activeAccount.id, streamId).then(
        // fallow-ignore-next-line complexity
        stream => {
        if (stream && stream.epgChannelId) {
          const xmltvProgs = res.epg_listings.map(mapEpgListingToXmltvProg);
          IPTVDb.mergeChannelEpg(activeAccount.id, stream.epgChannelId, xmltvProgs)
            .catch(err => console.warn('[EPG] mergeChannelEpg failed:', err));
        }
      }).catch(err => console.warn('[EPG] getLiveStream failed in loadEpgSidebar:', err));

      let scrollToElement = null;
      res.epg_listings.forEach(listing => {
        const item = document.createElement('li');
        item.className = 'epg-item';
        
        const title = safeBase64Decode(listing.title);
        const desc = safeBase64Decode(listing.description);
        
        const startTimestamp = Number(listing.start_timestamp);
        const endTimestamp = Number(listing.stop_timestamp || listing.end_timestamp);
        
        const dateObj = new Date(startTimestamp * 1000);
        const dateStr = dateObj.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit' });
        const startTimeStr = dateObj.toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
        const endTimeStr = new Date(endTimestamp * 1000).toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit', hour12: false });
        
        const timeSpan = document.createElement('div');
        timeSpan.className = 'epg-time';
        timeSpan.textContent = `${dateStr} | ${startTimeStr} - ${endTimeStr}`;
        item.appendChild(timeSpan);
        
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
          toggleBtn.style.marginLeft = '8px';
          titleRow.appendChild(toggleBtn);

          descSpan = document.createElement('div');
          descSpan.className = 'epg-desc';
          descSpan.textContent = desc;
          descSpan.style.display = 'none';

          toggleBtn.addEventListener('click', (e) => {
            e.stopPropagation();
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
        
        const now = Math.floor(Date.now() / 1000);
        const hasArchive = hasCatchup && (endTimestamp < now);
        const isCurrentTimeshift = isTimeshiftActive && timeshiftProgramInfo && 
          Number(listing.start_timestamp) === Number(timeshiftProgramInfo.start_timestamp);
        const isLiveProgram = (startTimestamp <= now && endTimestamp >= now);

        if (isCurrentTimeshift) {
          item.classList.add('playing');
          scrollToElement = item;
        } else if (isLiveProgram) {
          item.classList.add('current-program');
          const badge = document.createElement('span');
          badge.className = 'epg-badge current';
          badge.textContent = 'Live';
          item.appendChild(badge);
          
          if (!scrollToElement) {
            scrollToElement = item;
          }
        } else if (hasArchive) {
          item.classList.add('has-catchup');
          const badge = document.createElement('span');
          badge.className = 'epg-badge archive';
          badge.textContent = 'Archiv';
          item.appendChild(badge);

          const mpvBtn = document.createElement('button');
          mpvBtn.className = 'mpv-direct-btn';
          mpvBtn.innerHTML = '🎬 MPV';
          mpvBtn.title = 'In MPV abspielen';
          mpvBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            const url = buildTimeshiftUrl(listing, streamId);
            const title = safeBase64Decode(listing.title);
            window.electronAPI.openInMpv(url, `${currentLiveChannelName} (Archiv: ${title})`);
          });
          item.appendChild(mpvBtn);
          
          item.addEventListener('click', () => {
            const activeItems = epgList.querySelectorAll('.epg-item.playing');
            activeItems.forEach(el => el.classList.remove('playing'));
            item.classList.add('playing');
            
            playTimeshift(listing, streamId);
          });

          item.addEventListener('contextmenu', (e) => {
            e.preventDefault();
            const url = buildTimeshiftUrl(listing, streamId);
            const title = safeBase64Decode(listing.title);
            window.electronAPI.showContextMenu(`${currentLiveChannelName} (Archiv: ${title})`, url);
          });
        }
        
        epgList.appendChild(item);
      });

      if (scrollToElement) {
        setTimeout(() => {
          scrollToElement.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }, 150);
      }
    } else {
      epgList.innerHTML = '<div class="empty-list-placeholder">Keine Programmdaten verfügbar.</div>';
    }
  } catch (e) {
    console.error("EPG fetch failed:", e);
    epgList.innerHTML = '<div class="empty-list-placeholder">Fehler beim Laden des EPGs.</div>';
  }
}

function playTimeshift(epgListing, streamId) {
  isTimeshiftActive = true;
  timeshiftProgramInfo = epgListing;
  
  const baseUrl = getAccountBaseUrl(activeAccount);
  const durationMins = Math.floor((Number(epgListing.stop_timestamp || epgListing.end_timestamp) - Number(epgListing.start_timestamp)) / 60) || 60;
  const startFormatted = formatTimeshiftDate(epgListing.start_timestamp);
  
  const url = `${baseUrl}/timeshift/${activeAccount.username}/${activeAccount.password}/${durationMins}/${startFormatted}/${streamId}.ts`;
  
  const title = safeBase64Decode(epgListing.title);
  
  if (ctrlBackToLive) {
    ctrlBackToLive.style.display = 'inline-flex';
  }
  
  const streamInfo = document.getElementById('stream-info');
  if (streamInfo) {
    streamInfo.textContent = 'ARCHIV';
    streamInfo.style.background = 'var(--accent-cyan)';
    streamInfo.style.boxShadow = '0 0 8px rgba(0, 242, 254, 0.4)';
  }
  
  playChannel(`${currentLiveChannelName} (Archiv: ${title})`, 'Timeshift TV', currentLiveChannelLogo, url);
}
