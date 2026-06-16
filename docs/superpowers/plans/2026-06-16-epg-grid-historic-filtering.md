# EPG Grid Historic Data Filtering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hide historic EPG programs from the EPG Grid view for channels without timeshift, and adjust the grid start time to avoid blank space.

**Architecture:** Skip historic programs (`p.stop <= now`) in `buildEpgChannelRow` if `channel.catchup !== 1`, and filter them out in `renderEpgGrid` during timeline window calculation.

**Tech Stack:** JavaScript (ES6+), Electron Renderer Process, IndexedDB.

---

### Task 1: Update renderer-epg.js for Historic Filtering

**Files:**
- Modify: `renderer-epg.js:223-350`

- [ ] **Step 1: Skip rendering historic programs for non-timeshift channels in buildEpgChannelRow**

In `buildEpgChannelRow`, check if the program is in the past (`p.stop <= now`) and the channel is not timeshift-enabled (`channel.catchup !== 1`). If so, skip it.

```javascript
// Build one channel row (sticky channel cell + programme track). Returns the row div.
function buildEpgChannelRow(channel, epgMap, windowStart, windowEnd, trackWidth, now) {
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
```

- [ ] **Step 2: Ignore historic programs of non-timeshift channels when calculating grid window start in renderEpgGrid**

Update the window bounds calculation in `renderEpgGrid` to filter out programs where `p.stop <= now` for channels where `c.catchup !== 1`.

```javascript
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
```

- [ ] **Step 3: Run syntax validation**

Run: `node -c renderer-epg.js`
Expected output: No syntax error reported.

- [ ] **Step 4: Run static code health check**

Run: `npx fallow`
Expected output: Codebase health is clean without errors.

- [ ] **Step 5: Commit the changes**

```bash
git add renderer-epg.js
git commit -m "feat: hide historic EPG programs from grid for non-timeshift channels"
```
