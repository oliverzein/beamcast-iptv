/**
 * Renderer Download Controller & UI Layer.
 *
 * Pure testable controller (`createDownloadController`) + path preview helpers,
 * plus Electron renderer DOM wiring guarded behind `typeof document !== 'undefined'`.
 *
 * Dual export: CommonJS (`module.exports`) for Node tests, `window.DownloadUI` for renderer.
 */

const DL_ACTIVE_STATUSES = new Set(['queued', 'downloading', 'queued_transcode', 'transcoding']);
const DL_CLEARABLE_STATUSES = new Set(['completed', 'cancelled']);
const DL_PRESET_LABELS = {
  hevc: 'HEVC',
  h264: 'H.264',
  remux: 'Remux',
  original: 'Original',
};
const DL_ILLEGAL_CHARS_RE = /[\\/:*?"<>|\x00-\x1f\x7f]/g;

function dlCreateEmptySummary() {
  return {
    downloading: 0,
    transcoding: 0,
    queued: 0,
    queuedTranscode: 0,
    completed: 0,
    error: 0,
    activeTotal: 0,
  };
}

function dlNormalizeSnapshot(raw) {
  const jobs = Array.isArray(raw?.jobs) ? raw.jobs : [];
  const summary = { ...dlCreateEmptySummary(), ...(raw?.summary || {}) };
  if (!raw?.summary) {
    for (const j of jobs) {
      if (j.status === 'downloading') summary.downloading += 1;
      else if (j.status === 'transcoding') summary.transcoding += 1;
      else if (j.status === 'queued') summary.queued += 1;
      else if (j.status === 'queued_transcode') summary.queuedTranscode += 1;
      else if (j.status === 'completed') summary.completed += 1;
      else if (j.status === 'error') summary.error += 1;
    }
    summary.activeTotal =
      summary.downloading + summary.transcoding + summary.queued + summary.queuedTranscode;
  }
  return { jobs, summary };
}

function dlSanitizeSegment(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(DL_ILLEGAL_CHARS_RE, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function dlSanitizeName(str) {
  return dlSanitizeSegment(str) || 'video';
}

function dlSanitizeExt(sourceExt, preset) {
  if (preset !== 'original') return 'mp4';
  const cleaned = String(sourceExt || '')
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || 'mkv';
}

function dlPadTwo(value, fallback = 1) {
  const num = Number.parseInt(value, 10);
  const safe = Number.isFinite(num) && num >= 0 ? num : fallback;
  return String(safe).padStart(2, '0');
}

function dlStartsWithToken(text, prefix) {
  if (!text || !prefix) return false;
  const lowerText = text.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerText.startsWith(lowerPrefix)) return false;
  if (lowerText.length === lowerPrefix.length) return true;
  return !/[\p{L}\p{N}]/u.test(lowerText.charAt(lowerPrefix.length));
}

function dlIsRedundantEpTitle({ rawEpisodeTitle, cleanEpisodeTitle, seriesName, cleanSeries, epCode }) {
  if (!cleanEpisodeTitle) return true;
  if (/^episode\s+\d+$/i.test(cleanEpisodeTitle)) return true;
  if (dlStartsWithToken(cleanEpisodeTitle, cleanSeries)) return true;
  const rawSeries = dlSanitizeSegment(seriesName);
  if (rawSeries && dlStartsWithToken(String(rawEpisodeTitle || '').trim(), rawSeries)) return true;
  return dlStartsWithToken(cleanEpisodeTitle, epCode);
}

function dlJoinPreviewPath(parts, sep) {
  return parts
    .filter(Boolean)
    .map((p, idx) => (idx === 0 ? String(p).replace(/[\\/]+$/, '') : String(p).replace(/^[\\/]+|[\\/]+$/g, '')))
    .join(sep);
}

function dlFormatEpisodePreviewPath({ first, rootDir, sep, structure, ext }) {
  const cleanSeries = dlSanitizeName(first.seriesName || first.title);
  const paddedSeason = dlPadTwo(first.seasonNum, 1);
  const paddedEpisode = dlPadTwo(first.episodeNum, 1);
  const epCode = `S${paddedSeason}E${paddedEpisode}`;
  const cleanEpTitle = dlSanitizeSegment(first.episodeTitle);
  const redundant = dlIsRedundantEpTitle({
    rawEpisodeTitle: first.episodeTitle,
    cleanEpisodeTitle: cleanEpTitle,
    seriesName: first.seriesName,
    cleanSeries,
    epCode,
  });
  const stem = redundant ? `${cleanSeries} - ${epCode}` : `${cleanSeries} - ${epCode} - ${cleanEpTitle}`;
  const fileName = `${stem}.${ext}`;
  return structure === 'flat'
    ? dlJoinPreviewPath([rootDir, fileName], sep)
    : dlJoinPreviewPath([rootDir, 'Series', cleanSeries, `Season ${paddedSeason}`, fileName], sep);
}

function buildPathPreview({ items, baseDir, structure = 'structured', preset = 'hevc' }) {
  const list = Array.isArray(items) ? items : [];
  const first = list[0] || {};
  const rootDir = String(baseDir || '').trim() || '~/Downloads/BeamcastIPTV';
  const sep = rootDir.includes('\\') && !rootDir.includes('/') ? '\\' : '/';
  const ext = dlSanitizeExt(first.sourceExt, preset);
  const isEpisode = first.mediaType === 'episode' || first.mediaType === 'series';

  let targetPath;
  if (!isEpisode) {
    const fileName = `${dlSanitizeName(first.title)}.${ext}`;
    targetPath = structure === 'flat'
      ? dlJoinPreviewPath([rootDir, fileName], sep)
      : dlJoinPreviewPath([rootDir, 'Movies', fileName], sep);
  } else {
    targetPath = dlFormatEpisodePreviewPath({ first, rootDir, sep, structure, ext });
  }

  return list.length > 1 ? `${targetPath} (+${list.length - 1} weitere)` : targetPath;
}

function dlFormatBytes(bytes) {
  const val = Number(bytes);
  if (!Number.isFinite(val) || val <= 0) return '0 MB';
  const gb = 1024 * 1024 * 1024;
  const mb = 1024 * 1024;
  if (val >= gb) return `${(val / gb).toFixed(2)} GB`;
  if (val >= mb) return `${Math.round(val / mb)} MB`;
  return `${Math.max(1, Math.round(val / 1024))} KB`;
}

function dlFormatSpeedBps(bps) {
  const val = Number(bps);
  if (!Number.isFinite(val) || val <= 0) return '';
  const mb = 1024 * 1024;
  if (val >= mb) return `${(val / mb).toFixed(1)} MB/s`;
  return `${Math.max(1, Math.round(val / 1024))} KB/s`;
}

function dlFormatEta(etaSec) {
  const sec = Math.round(Number(etaSec));
  if (!Number.isFinite(sec) || sec <= 0) return '';
  if (sec < 60) return `~${sec}s`;
  const mins = Math.floor(sec / 60);
  const remSec = sec % 60;
  if (mins < 60) return remSec > 0 ? `~${mins}m ${remSec}s` : `~${mins}m`;
  const hrs = Math.floor(mins / 60);
  const remMin = mins % 60;
  return remMin > 0 ? `~${hrs}h ${remMin}m` : `~${hrs}h`;
}

function dlIsValidBaseDir(dir) {
  if (dir === undefined || dir === null) return true;
  if (typeof dir !== 'string') return false;
  const trimmed = dir.trim();
  if (!trimmed) return true;
  if (trimmed.includes('\0')) return false;
  return /^(?:\/|\\\\[^\\/]|[a-zA-Z]:[\\/])/.test(trimmed);
}

function dlMergeOptions(defaults, overrides = {}) {
  const rawBaseDir = overrides.baseDir !== undefined ? overrides.baseDir : defaults.baseDir;
  if (!dlIsValidBaseDir(rawBaseDir)) {
    throw new Error('Download-Ordner muss ein absoluter Pfad sein');
  }
  return {
    ...defaults,
    ...overrides,
    baseDir: typeof rawBaseDir === 'string' ? rawBaseDir.trim() : '',
  };
}

function dlReadDefaultOptions(AppSettings) {
  return {
    baseDir: AppSettings?.get?.('downloadDir', '') || '',
    structure: AppSettings?.get?.('downloadFolderStructure', 'structured') || 'structured',
    preset: AppSettings?.get?.('downloadDefaultPreset', 'hevc') || 'hevc',
    resolution: AppSettings?.get?.('downloadDefaultResolution', '1080p') || '1080p',
    hwAccel: AppSettings?.get?.('downloadHwAccel', 'auto') || 'auto',
    duplicateAction: AppSettings?.get?.('downloadDuplicateAction', 'ask') || 'ask',
  };
}

function dlShouldOpenOptionsDialog(AppSettings, items, { source = 'button', forceDialog = false } = {}) {
  if (forceDialog || source === 'context-options') return true;
  if (source === 'context-default') return false;
  if (source === 'batch' || source === 'season' || source === 'multiselect' || items.length > 1) {
    return true;
  }
  const clickAction = AppSettings?.get?.('downloadClickAction', 'dialog') || 'dialog';
  return clickAction !== 'instant';
}

async function dlPersistRememberedDefaults(AppSettings, options) {
  if (!AppSettings?.set || !options) return;
  if (options.preset) {
    await AppSettings.set('downloadDefaultPreset', options.preset);
  }
  if ((options.preset === 'hevc' || options.preset === 'h264') && options.resolution) {
    await AppSettings.set('downloadDefaultResolution', options.resolution);
  }
}

function dlPickPreferredJob(jobs, itemKey) {
  if (!itemKey || !Array.isArray(jobs)) return null;
  let latestCompleted = null;
  let latestAny = null;

  for (let i = jobs.length - 1; i >= 0; i -= 1) {
    const job = jobs[i];
    if (!job || job.itemKey !== itemKey) continue;
    if (DL_ACTIVE_STATUSES.has(job.status)) return job;
    if (!latestCompleted && job.status === 'completed') latestCompleted = job;
    if (!latestAny) latestAny = job;
  }

  return latestCompleted || latestAny;
}

function createDownloadController({
  AppSettings,
  electronAPI,
  openOptionsModal,
  openConflictModal,
  onBatchEnqueued,
  onSnapshot,
} = {}) {
  let snapshot = dlNormalizeSnapshot(null);

  async function resolveDuplicateStrategy(items, effectiveOptions) {
    if (effectiveOptions.duplicateAction !== 'ask') return effectiveOptions.duplicateAction;
    if (!electronAPI?.checkDownloadConflicts) return 'skip';

    const checkResult = await electronAPI.checkDownloadConflicts(items, effectiveOptions);
    const conflicts = Array.isArray(checkResult?.conflicts) ? checkResult.conflicts : [];
    if (conflicts.length === 0) return 'ask';
    if (typeof openConflictModal !== 'function') return 'cancel';

    const choice = await openConflictModal({ items, conflicts, options: effectiveOptions });
    return ['skip', 'rename', 'overwrite'].includes(choice) ? choice : 'cancel';
  }

  async function runEnqueueWithConflictCheck(items, options = {}) {
    const effectiveOptions = dlMergeOptions(dlReadDefaultOptions(AppSettings), options);

    const strategy = await resolveDuplicateStrategy(items, effectiveOptions);
    if (strategy === 'cancel') return { cancelled: true, added: 0, jobs: [] };
    effectiveOptions.duplicateAction = strategy;

    const result = await electronAPI.enqueueDownloads(items, effectiveOptions);
    if (result && result.added > 0 && typeof onBatchEnqueued === 'function') {
      onBatchEnqueued(result);
    }
    return result;
  }

  async function triggerDownload(items, opts = {}) {
    if (!Array.isArray(items) || items.length === 0) {
      return { cancelled: true, added: 0, jobs: [] };
    }

    const defaultOptions = dlReadDefaultOptions(AppSettings);
    if (!dlShouldOpenOptionsDialog(AppSettings, items, opts)) {
      return runEnqueueWithConflictCheck(items, defaultOptions);
    }

    if (typeof openOptionsModal !== 'function') {
      return { cancelled: true, added: 0, jobs: [] };
    }

    const modalResult = await openOptionsModal({ items, defaultOptions, source: opts.source || 'button' });
    if (!modalResult || !modalResult.options) {
      return { cancelled: true, added: 0, jobs: [] };
    }

    const mergedOptions = dlMergeOptions(defaultOptions, modalResult.options);
    if (modalResult.rememberDefaults) {
      await dlPersistRememberedDefaults(AppSettings, modalResult.options);
    }

    return runEnqueueWithConflictCheck(items, mergedOptions);
  }

  function updateSnapshot(nextSnapshot) {
    snapshot = dlNormalizeSnapshot(nextSnapshot);
    if (typeof onSnapshot === 'function') onSnapshot(snapshot);
    return snapshot;
  }

  return {
    triggerDownload,
    runEnqueueWithConflictCheck,
    updateSnapshot,
    getJobForItemKey: (itemKey) => dlPickPreferredJob(snapshot.jobs, itemKey),
    getSnapshot: () => snapshot,
  };
}

// --- Browser DOM & IPC Layer ---

function dlEl(id) {
  return document.getElementById(id);
}

function dlCreateEl(tag, className, textContent) {
  const el = document.createElement(tag);
  if (className) el.className = className;
  if (textContent !== undefined && textContent !== null) {
    el.textContent = String(textContent);
  }
  return el;
}

function dlFormatHwLabel(hwAccel) {
  if (!hwAccel || hwAccel === 'auto') return 'VAAPI Auto / CPU';
  if (hwAccel === 'cpu') return 'Nur CPU';
  return String(hwAccel);
}

function dlFormatDisplayPath(fullPath, baseDir) {
  if (!fullPath) return '';
  if (baseDir && fullPath.startsWith(baseDir)) {
    const rel = fullPath.slice(baseDir.length).replace(/^[\\/]+/, '');
    if (rel) return rel;
  }
  const parts = fullPath.split(/[\\/]+/).filter(Boolean);
  return parts.length > 3 ? parts.slice(-3).join('/') : fullPath;
}

function dlFormatSizeComparison(job) {
  const finalBytes = Number(job.finalSizeBytes);
  const origBytes = Number(job.originalSizeBytes);
  if (!Number.isFinite(finalBytes) || finalBytes <= 0) return '';
  if (job.preset !== 'original' && Number.isFinite(origBytes) && origBytes > 0) {
    const pct = Math.round(((finalBytes - origBytes) / origBytes) * 100);
    const signed = pct > 0 ? `+${pct}%` : `${pct}%`;
    return `${dlFormatBytes(finalBytes)} (Original ${dlFormatBytes(origBytes)} · ${signed})`;
  }
  return dlFormatBytes(finalBytes);
}

function dlDescribeTarget(items) {
  const list = Array.isArray(items) ? items : [];
  const first = list[0] || {};
  const firstExt = dlSanitizeExt(first.sourceExt, 'original');

  if (list.length === 1) {
    const isEp = first.mediaType === 'episode' || first.mediaType === 'series';
    const title = first.title || (isEp
      ? `${first.seriesName || 'Serie'} - S${dlPadTwo(first.seasonNum)}E${dlPadTwo(first.episodeNum)}`
      : 'Download');
    return { title, sub: `Quelle: Xtream ${isEp ? 'Series' : 'Movie'} · .${firstExt}`, pill: isEp ? '1 Episode' : '1 Datei' };
  }

  const allEpisodes = list.every((i) => i.mediaType === 'episode' || i.mediaType === 'series');
  if (allEpisodes) {
    const seriesNames = new Set(list.map((i) => i.seriesName).filter(Boolean));
    const seasonNums = new Set(list.map((i) => i.seasonNum).filter((n) => n !== undefined && n !== null));
    let title = 'Serien-Batch';
    if (seriesNames.size === 1) {
      const name = Array.from(seriesNames)[0];
      title = seasonNums.size === 1 ? `${name} · Season ${dlPadTwo(Array.from(seasonNums)[0])}` : name;
    }
    return { title, sub: `Quelle: Xtream Series · ${list.length} Episoden`, pill: `${list.length} Episoden` };
  }

  return { title: 'Batch-Download', sub: `Quelle: Xtream VOD · ${list.length} Dateien`, pill: `${list.length} Dateien` };
}

function dlIsXtreamActive() {
  if (typeof activePlaylistType !== 'undefined') return activePlaylistType === 'xtream';
  const tabs = dlEl('sidebar-tabs');
  return Boolean(tabs && tabs.style.display !== 'none');
}

function dlFormatConflictReason(conflict) {
  if (conflict.reason === 'inflight') return 'Bereits aktiv in Warteschlange';
  if (conflict.reason === 'batch') return 'Doppelter Zielpfad in diesem Batch';
  const sizeStr = conflict.existingSizeBytes > 0 ? ` · ${dlFormatBytes(conflict.existingSizeBytes)}` : '';
  return `Bereits auf Festplatte${sizeStr}`;
}

function dlBuildStatusBarText(job, kind) {
  if (kind === 'download') {
    const pct = Math.round(job.progress || 0);
    const speed = dlFormatSpeedBps(job.speedBps);
    const eta = dlFormatEta(job.etaSec);
    const parts = [];
    if (job.totalBytes > 0) parts.push(`${pct}%`);
    else if (job.bytesWritten > 0) parts.push(dlFormatBytes(job.bytesWritten));
    if (speed) parts.push(speed);
    if (eta) parts.push(eta);
    return `⬇ Lädt: ${job.title}${parts.length ? ` (${parts.join(' · ')})` : ''}`;
  }
  const pct = Math.round(job.progress || 0);
  const enc = job.encoderUsed ? job.encoderUsed.toUpperCase() : (DL_PRESET_LABELS[job.preset] || job.preset);
  const parts = [`${pct}%`, enc];
  if (job.transcodeSpeed) parts.push(`${Number(job.transcodeSpeed).toFixed(1)}x`);
  const eta = dlFormatEta(job.etaSec);
  if (eta) parts.push(eta);
  return `⚙ Transkodiert: ${job.title} (${parts.join(' · ')})`;
}

function dlRenderTopBarButton(snapshot) {
  const btn = dlEl('btn-downloads');
  const badge = dlEl('downloads-badge-count');
  if (!btn) return;

  btn.style.display = (dlIsXtreamActive() || snapshot.jobs.length > 0) ? 'inline-flex' : 'none';
  if (badge) {
    const activeCount = snapshot.summary.activeTotal || 0;
    badge.textContent = String(activeCount);
    badge.style.display = activeCount > 0 ? 'inline-block' : 'none';
  }
}

function dlRenderStatusBar(snapshot, isDismissed) {
  const bar = dlEl('download-status-bar');
  const infoEl = dlEl('dsb-info-text');
  const fillEl = dlEl('dsb-progress-fill');
  const queueBtn = dlEl('btn-dsb-queue');
  if (!bar || !infoEl || !fillEl) return;

  const dlJob = snapshot.jobs.find((j) => j.status === 'downloading');
  const tcJob = snapshot.jobs.find((j) => j.status === 'transcoding');
  const qTcJob = snapshot.jobs.find((j) => j.status === 'queued_transcode');

  if (isDismissed || (!dlJob && !tcJob && !qTcJob)) {
    bar.style.display = 'none';
    return;
  }

  bar.style.display = 'block';
  infoEl.innerHTML = '';

  if (dlJob) {
    const dlTag = dlCreateEl('span', 'dsb-tag dl');
    dlTag.appendChild(dlCreateEl('span', 'pulse-dot cyan'));
    dlTag.appendChild(document.createTextNode(` ${dlBuildStatusBarText(dlJob, 'download')}`));
    infoEl.appendChild(dlTag);
  }
  if (dlJob && (tcJob || qTcJob)) {
    infoEl.appendChild(dlCreateEl('span', 'dsb-divider', '|'));
  }
  if (tcJob || qTcJob) {
    const tcTag = dlCreateEl('span', 'dsb-tag tc');
    if (!dlJob) {
      tcTag.appendChild(dlCreateEl('span', 'pulse-dot cyan'));
      tcTag.appendChild(document.createTextNode(' '));
    }
    const text = tcJob ? dlBuildStatusBarText(tcJob, 'transcode') : `⏳ Bereite Transcode vor: ${qTcJob.title}`;
    tcTag.appendChild(document.createTextNode(text));
    infoEl.appendChild(tcTag);
  }

  if (queueBtn) queueBtn.textContent = `Queue (${snapshot.summary.activeTotal || 0})`;

  if (dlJob) {
    const unknownTotal = !dlJob.totalBytes || dlJob.totalBytes <= 0;
    fillEl.className = unknownTotal ? 'progress-fill-cyan progress-fill-indeterminate' : 'progress-fill-cyan';
    fillEl.style.width = unknownTotal ? '35%' : `${Math.min(100, Math.max(0, dlJob.progress || 0))}%`;
  } else {
    fillEl.className = 'progress-fill-purple';
    fillEl.style.width = tcJob ? `${Math.min(100, Math.max(0, tcJob.progress || 0))}%` : '0%';
  }
}

function dlBuildBadgeInfo(job) {
  const preset = DL_PRESET_LABELS[job.preset] || job.preset || '';
  if (job.status === 'transcoding') {
    const enc = job.encoderUsed ? job.encoderUsed.toUpperCase() : preset;
    const res = job.resolution && job.resolution !== 'original' ? ` · ${job.resolution}` : '';
    return { cls: 'state-badge transcode', text: `⚙ Transkodiert (${enc}${res})` };
  }
  if (job.status === 'queued_transcode') return { cls: 'state-badge transcode', text: '⏳ Bereit für Transcode' };
  if (job.status === 'downloading') return { cls: 'state-badge download', text: '⬇ Lädt' };
  if (job.status === 'queued') return { cls: 'state-badge queued', text: '⏳ Warteschlange' };
  if (job.status === 'completed') return { cls: 'state-badge done', text: '✓ Fertig' };
  if (job.status === 'cancelled') return { cls: 'state-badge queued', text: '✕ Abgebrochen' };
  return { cls: 'state-badge error', text: '⚠ Fehler' };
}

function dlCreateActionBtn(label, className, title, onClick) {
  const btn = dlCreateEl('button', className || 'btn-sm btn-sm-secondary', label);
  btn.type = 'button';
  if (title) btn.title = title;
  btn.addEventListener('click', onClick);
  return btn;
}

function dlBuildQueueActions(job) {
  const wrap = dlCreateEl('div', 'queue-actions');
  if (job.status === 'downloading' || job.status === 'transcoding' || job.status === 'queued_transcode') {
    wrap.appendChild(dlCreateActionBtn('Abbrechen', 'btn-sm btn-sm-secondary', null, () => {
      window.electronAPI?.cancelDownload?.(job.id);
    }));
    return wrap;
  }
  if (job.status === 'queued') {
    wrap.appendChild(dlCreateActionBtn('Entfernen', 'btn-sm btn-sm-secondary', null, () => {
      window.electronAPI?.removeDownload?.(job.id);
    }));
    return wrap;
  }
  if (job.status === 'completed') {
    wrap.appendChild(dlCreateActionBtn('📁 Ordner', 'btn-sm btn-sm-secondary', 'Im Ordner anzeigen', () => {
      window.electronAPI?.openDownloadFolder?.(job.finalPath);
    }));
    wrap.appendChild(dlCreateActionBtn('🎬 MPV', 'btn-sm btn-sm-cyan', 'In MPV abspielen', async () => {
      const res = await window.electronAPI?.openDownloadedInMpv?.(job.finalPath);
      if (res && res.ok === false) alert(res.error || 'MPV konnte Datei nicht öffnen.');
    }));
    wrap.appendChild(dlCreateActionBtn('✕', 'btn-sm btn-sm-secondary', 'Aus Liste entfernen', () => {
      window.electronAPI?.removeDownload?.(job.id);
    }));
    return wrap;
  }

  wrap.appendChild(dlCreateActionBtn('↻ Retry', 'btn-sm btn-sm-secondary', 'Erneut versuchen', () => {
    window.electronAPI?.retryDownload?.(job.id);
  }));
  wrap.appendChild(dlCreateActionBtn('✕', 'btn-sm btn-sm-secondary', 'Entfernen', () => {
    window.electronAPI?.removeDownload?.(job.id);
  }));
  return wrap;
}

function dlBuildDownloadingMeta(job, presetText) {
  const parts = [];
  if (job.totalBytes > 0) {
    parts.push(`${Math.round(job.progress || 0)}%`, `${dlFormatBytes(job.bytesWritten)} / ${dlFormatBytes(job.totalBytes)}`);
  } else if (job.bytesWritten > 0) {
    parts.push(`${dlFormatBytes(job.bytesWritten)} geladen`);
  } else {
    parts.push('Verbinde...');
  }
  const speed = dlFormatSpeedBps(job.speedBps);
  const eta = dlFormatEta(job.etaSec);
  if (speed) parts.push(speed);
  if (eta) parts.push(eta);
  return {
    left: parts.join(' · '),
    right: job.preset === 'original' ? 'Original (1:1)' : `Danach: ${presetText}`,
  };
}

function dlBuildQueueMeta(job, effectiveBaseDir) {
  const meta = dlCreateEl('div', 'queue-meta');
  const presetLabel = DL_PRESET_LABELS[job.preset] || job.preset;
  const presetText = `${presetLabel}${job.preset === 'hevc' || job.preset === 'h264' ? ` · ${job.resolution}` : ''}`;

  if (job.status === 'transcoding') {
    const parts = [`${Math.round(job.progress || 0)}%`];
    if (job.transcodeSpeed) parts.push(`${Number(job.transcodeSpeed).toFixed(1)}x`);
    const eta = dlFormatEta(job.etaSec);
    if (eta) parts.push(eta);
    meta.appendChild(dlCreateEl('span', null, parts.join(' · ')));
    meta.appendChild(dlCreateEl('span', null, job.statusNote || 'Lokal (.part → .mp4)'));
  } else if (job.status === 'downloading') {
    const info = dlBuildDownloadingMeta(job, presetText);
    meta.appendChild(dlCreateEl('span', null, info.left));
    meta.appendChild(dlCreateEl('span', null, info.right));
  } else if (job.status === 'queued_transcode') {
    meta.appendChild(dlCreateEl('span', null, `Geladen: ${dlFormatBytes(job.originalSizeBytes || job.bytesWritten)}`));
    meta.appendChild(dlCreateEl('span', null, `Wartet auf Transcode (${presetText})`));
  } else if (job.status === 'queued') {
    meta.appendChild(dlCreateEl('span', null, `Preset: ${presetText}`));
    meta.appendChild(dlCreateEl('span', null, 'Wartet auf freien Download-Slot'));
  } else if (job.status === 'completed') {
    const sizeText = dlFormatSizeComparison(job) || 'Abgeschlossen';
    meta.appendChild(dlCreateEl('span', null, job.statusNote ? `${sizeText} · ${job.statusNote}` : sizeText));
    meta.appendChild(dlCreateEl('span', null, dlFormatDisplayPath(job.finalPath, effectiveBaseDir)));
  } else if (job.status === 'cancelled') {
    meta.appendChild(dlCreateEl('span', null, 'Vom Benutzer abgebrochen'));
    meta.appendChild(dlCreateEl('span', null, '.part bereinigt'));
  } else {
    meta.appendChild(dlCreateEl('span', 'queue-error-text', job.error || 'Unbekannter Fehler'));
    meta.appendChild(dlCreateEl('span', null, job.errorStage === 'transcode'
      ? 'Download behalten · Retry startet Transcode'
      : '.part bereinigt'));
  }
  return meta;
}

function dlBuildQueueRow(job, effectiveBaseDir) {
  const row = dlCreateEl('div', 'queue-item');
  const top = dlCreateEl('div', 'queue-item-top');
  const titleWrap = dlCreateEl('div', 'queue-title');
  const badge = dlBuildBadgeInfo(job);

  titleWrap.appendChild(dlCreateEl('span', null, job.title || 'Download'));
  titleWrap.appendChild(dlCreateEl('span', badge.cls, badge.text));
  top.appendChild(titleWrap);
  top.appendChild(dlBuildQueueActions(job));
  row.appendChild(top);

  if (job.status === 'downloading' || job.status === 'transcoding') {
    const track = dlCreateEl('div', 'progress-track');
    const isDl = job.status === 'downloading';
    const unknownTotal = isDl && (!job.totalBytes || job.totalBytes <= 0);
    const fillCls = isDl
      ? (unknownTotal ? 'progress-fill-cyan progress-fill-indeterminate' : 'progress-fill-cyan')
      : 'progress-fill-purple';
    const fill = dlCreateEl('div', fillCls);
    fill.style.width = unknownTotal ? '35%' : `${Math.min(100, Math.max(0, job.progress || 0))}%`;
    track.appendChild(fill);
    row.appendChild(track);
  }

  row.appendChild(dlBuildQueueMeta(job, effectiveBaseDir));
  return row;
}

function dlFilterJobs(jobs, activeFilter) {
  if (activeFilter === 'active') return jobs.filter((j) => DL_ACTIVE_STATUSES.has(j.status));
  if (activeFilter === 'done') return jobs.filter((j) => j.status === 'completed');
  return jobs;
}

function dlRenderManagerModal(snapshot, activeFilter, effectiveBaseDir) {
  const { jobs, summary } = snapshot;
  const activeCount = summary.activeTotal || 0;
  const doneCount = summary.completed || 0;
  const waitingCount = (summary.queued || 0) + (summary.queuedTranscode || 0);

  if (dlEl('dl-count-all')) dlEl('dl-count-all').textContent = String(jobs.length);
  if (dlEl('dl-count-active')) dlEl('dl-count-active').textContent = String(activeCount);
  if (dlEl('dl-count-done')) dlEl('dl-count-done').textContent = String(doneCount);

  const summaryEl = dlEl('downloads-summary-text');
  if (summaryEl) {
    if (jobs.length === 0) {
      summaryEl.textContent = 'Keine Downloads in der Warteschlange';
    } else {
      const parts = [
        `${summary.downloading || 0} Download aktiv`,
        `${summary.transcoding || 0} Transcoding aktiv`,
        `${waitingCount} wartend`,
        `${doneCount} fertig`,
      ];
      if (summary.error > 0) parts.push(`${summary.error} Fehler`);
      summaryEl.textContent = parts.join(' · ');
    }
  }

  const clearBtn = dlEl('btn-downloads-clear-completed');
  if (clearBtn) clearBtn.disabled = !jobs.some((j) => DL_CLEARABLE_STATUSES.has(j.status));
  const cancelAllBtn = dlEl('btn-downloads-cancel-all');
  if (cancelAllBtn) cancelAllBtn.disabled = activeCount === 0;

  const modal = dlEl('downloads-modal');
  const listEl = dlEl('downloads-queue-list');
  if (!modal || modal.style.display !== 'flex' || !listEl) return;

  const filtered = dlFilterJobs(jobs, activeFilter);
  listEl.innerHTML = '';
  if (filtered.length === 0) {
    listEl.appendChild(dlCreateEl('div', 'empty-list-placeholder', 'Keine Einträge in dieser Ansicht.'));
    return;
  }
  for (const job of filtered) {
    listEl.appendChild(dlBuildQueueRow(job, effectiveBaseDir));
  }
}

const dlUiState = {
  initialized: false,
  cachedDefaultDir: '',
  isStatusBarDismissed: false,
  activeFilter: 'all',
  pendingOptionsResolve: null,
  pendingConflictResolve: null,
  optionsState: null,
  controller: null,
};

function dlGetEffectiveBaseDir(overrideDir) {
  const custom = String(overrideDir || '').trim();
  if (custom) return custom;
  const saved = String(window.AppSettings?.get?.('downloadDir', '') || '').trim();
  return saved || dlUiState.cachedDefaultDir || '';
}

async function dlRefreshDefaultDir() {
  if (dlUiState.cachedDefaultDir || !window.electronAPI?.getDefaultDownloadDir) {
    return dlUiState.cachedDefaultDir;
  }
  try {
    const dir = await window.electronAPI.getDefaultDownloadDir();
    if (typeof dir === 'string' && dir.trim()) dlUiState.cachedDefaultDir = dir.trim();
  } catch (err) {
    console.warn('[Downloads] getDefaultDownloadDir failed:', err && err.message);
  }
  return dlUiState.cachedDefaultDir;
}

function dlUpdateOptionsPathPreview() {
  if (!dlUiState.optionsState) return;
  const previewEl = dlEl('dl-opt-path-preview');
  if (!previewEl) return;
  const preview = buildPathPreview({
    items: dlUiState.optionsState.items,
    baseDir: dlGetEffectiveBaseDir(dlUiState.optionsState.baseDirOverride),
    structure: dlUiState.optionsState.structure,
    preset: dlUiState.optionsState.preset,
  });
  previewEl.textContent = preview;
  previewEl.title = preview;
}

function dlSyncOptionsControls() {
  const st = dlUiState.optionsState;
  if (!st) return;
  const allowScale = st.preset === 'hevc' || st.preset === 'h264';

  document.querySelectorAll('#dl-opt-preset-grid .preset-card').forEach((card) => {
    card.classList.toggle('active', card.dataset.preset === st.preset);
  });

  const seg = dlEl('dl-opt-res-segmented');
  if (seg) {
    seg.classList.toggle('disabled', !allowScale);
    seg.querySelectorAll('.seg-btn').forEach((btn) => {
      btn.disabled = !allowScale;
      btn.classList.toggle('active', btn.dataset.res === st.resolution);
    });
  }

  const hwLabel = dlEl('dl-opt-hw-label');
  if (hwLabel) hwLabel.textContent = dlFormatHwLabel(st.hwAccel);
  dlUpdateOptionsPathPreview();
}

function dlSetOptionsDirError(message) {
  const previewEl = dlEl('dl-opt-path-preview');
  const group = previewEl?.closest?.('.path-preview-row')?.parentElement;
  if (!group) return;
  let errEl = group.querySelector('.form-error');
  if (!message) {
    if (errEl) errEl.textContent = '';
    return;
  }
  if (!errEl) {
    errEl = dlCreateEl('small', 'form-error');
    group.appendChild(errEl);
  }
  errEl.textContent = message;
}

function dlCloseOptionsModal(result = null) {
  dlSetOptionsDirError('');
  const modal = dlEl('download-options-modal');
  if (modal) modal.style.display = 'none';
  const resolve = dlUiState.pendingOptionsResolve;
  dlUiState.pendingOptionsResolve = null;
  dlUiState.optionsState = null;
  if (resolve) resolve(result);
}

async function dlOpenOptionsModal({ items, defaultOptions }) {
  if (dlUiState.pendingOptionsResolve) dlCloseOptionsModal(null);
  await dlRefreshDefaultDir();

  const target = dlDescribeTarget(items);
  if (dlEl('dl-opt-target-title')) dlEl('dl-opt-target-title').textContent = target.title;
  if (dlEl('dl-opt-target-sub')) dlEl('dl-opt-target-sub').textContent = target.sub;
  if (dlEl('dl-opt-target-pill')) dlEl('dl-opt-target-pill').textContent = target.pill;
  if (dlEl('dl-opt-remember')) dlEl('dl-opt-remember').checked = false;

  dlUiState.optionsState = {
    items,
    baseDirOverride: defaultOptions.baseDir || '',
    structure: defaultOptions.structure || 'structured',
    preset: defaultOptions.preset || 'hevc',
    resolution: defaultOptions.resolution || '1080p',
    hwAccel: defaultOptions.hwAccel || 'auto',
    duplicateAction: defaultOptions.duplicateAction || 'ask',
  };

  dlSetOptionsDirError(
    dlIsValidBaseDir(dlUiState.optionsState.baseDirOverride) ? '' : 'Download-Ordner muss ein absoluter Pfad sein'
  );
  dlSyncOptionsControls();
  const modal = dlEl('download-options-modal');
  if (modal) modal.style.display = 'flex';
  return new Promise((resolve) => { dlUiState.pendingOptionsResolve = resolve; });
}

function dlCloseConflictModal(choice = 'cancel') {
  const modal = dlEl('download-conflict-modal');
  if (modal) modal.style.display = 'none';
  const resolve = dlUiState.pendingConflictResolve;
  dlUiState.pendingConflictResolve = null;
  if (resolve) resolve(choice);
}

function dlOpenConflictModal({ conflicts }) {
  if (dlUiState.pendingConflictResolve) dlCloseConflictModal('cancel');

  const summaryEl = dlEl('dl-conflict-summary');
  if (summaryEl) {
    summaryEl.textContent = conflicts.length === 1
      ? '1 Zieldatei existiert bereits bzw. ist belegt:'
      : `${conflicts.length} Zieldateien existieren bereits bzw. sind belegt:`;
  }

  const listEl = dlEl('dl-conflict-list');
  if (listEl) {
    listEl.innerHTML = '';
    for (const c of conflicts) {
      const li = dlCreateEl('li', 'conflict-item');
      li.appendChild(dlCreateEl('div', 'conflict-item-title', c.title || 'Datei'));
      li.appendChild(dlCreateEl('div', 'conflict-item-path', c.existingPath || ''));
      li.appendChild(dlCreateEl('div', 'conflict-item-meta', dlFormatConflictReason(c)));
      listEl.appendChild(li);
    }
  }

  const modal = dlEl('download-conflict-modal');
  if (modal) modal.style.display = 'flex';
  return new Promise((resolve) => { dlUiState.pendingConflictResolve = resolve; });
}

function dlCloseManagerModal() {
  const modal = dlEl('downloads-modal');
  if (modal) modal.style.display = 'none';
}

async function dlOpenManagerModal() {
  await dlRefreshDefaultDir();
  if (window.electronAPI?.getDownloadState && dlUiState.controller) {
    try {
      dlUiState.controller.updateSnapshot(await window.electronAPI.getDownloadState());
    } catch (err) {
      console.warn('[Downloads] getDownloadState failed:', err && err.message);
    }
  }
  const modal = dlEl('downloads-modal');
  if (modal) modal.style.display = 'flex';
  if (dlUiState.controller) {
    dlRenderManagerModal(dlUiState.controller.getSnapshot(), dlUiState.activeFilter, dlGetEffectiveBaseDir(''));
  }
}

function dlWireOptionsModalEvents() {
  dlEl('btn-close-download-options')?.addEventListener('click', () => dlCloseOptionsModal(null));
  dlEl('btn-dl-opt-cancel')?.addEventListener('click', () => dlCloseOptionsModal(null));
  dlEl('download-options-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) dlCloseOptionsModal(null);
  });

  document.querySelectorAll('#dl-opt-preset-grid .preset-card').forEach((card) => {
    card.addEventListener('click', () => {
      if (!dlUiState.optionsState || !card.dataset.preset) return;
      dlUiState.optionsState.preset = card.dataset.preset;
      dlSyncOptionsControls();
    });
  });

  document.querySelectorAll('#dl-opt-res-segmented .seg-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      if (!dlUiState.optionsState || btn.disabled || !btn.dataset.res) return;
      dlUiState.optionsState.resolution = btn.dataset.res;
      dlSyncOptionsControls();
    });
  });

  dlEl('btn-dl-opt-folder')?.addEventListener('click', async () => {
    if (!dlUiState.optionsState || !window.electronAPI?.selectDownloadDir) return;
    try {
      const selected = await window.electronAPI.selectDownloadDir(
        dlGetEffectiveBaseDir(dlUiState.optionsState.baseDirOverride)
      );
      if (typeof selected === 'string' && selected.trim()) {
        const trimmed = selected.trim();
        if (!dlIsValidBaseDir(trimmed)) {
          dlSetOptionsDirError('Download-Ordner muss ein absoluter Pfad sein');
          return;
        }
        dlSetOptionsDirError('');
        dlUiState.optionsState.baseDirOverride = trimmed;
        dlUpdateOptionsPathPreview();
      }
    } catch (err) {
      console.warn('[Downloads] selectDownloadDir failed:', err && err.message);
    }
  });

  dlEl('btn-dl-opt-start')?.addEventListener('click', () => {
    const st = dlUiState.optionsState;
    if (!st) return;
    const effectiveDir = dlGetEffectiveBaseDir(st.baseDirOverride);
    if (!dlIsValidBaseDir(st.baseDirOverride) || !dlIsValidBaseDir(effectiveDir)) {
      dlSetOptionsDirError('Download-Ordner muss ein absoluter Pfad sein');
      return;
    }
    dlSetOptionsDirError('');
    dlCloseOptionsModal({
      options: {
        baseDir: st.baseDirOverride,
        structure: st.structure,
        preset: st.preset,
        resolution: st.resolution,
        hwAccel: st.hwAccel,
        duplicateAction: st.duplicateAction,
      },
      rememberDefaults: Boolean(dlEl('dl-opt-remember')?.checked),
    });
  });
}

function dlWireConflictAndManagerEvents() {
  dlEl('btn-close-download-conflict')?.addEventListener('click', () => dlCloseConflictModal('cancel'));
  dlEl('btn-conflict-cancel')?.addEventListener('click', () => dlCloseConflictModal('cancel'));
  dlEl('btn-conflict-skip')?.addEventListener('click', () => dlCloseConflictModal('skip'));
  dlEl('btn-conflict-rename')?.addEventListener('click', () => dlCloseConflictModal('rename'));
  dlEl('btn-conflict-overwrite')?.addEventListener('click', () => dlCloseConflictModal('overwrite'));
  dlEl('download-conflict-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) dlCloseConflictModal('cancel');
  });

  dlEl('btn-close-downloads-modal')?.addEventListener('click', dlCloseManagerModal);
  dlEl('downloads-modal')?.addEventListener('click', (e) => {
    if (e.target === e.currentTarget) dlCloseManagerModal();
  });

  document.querySelectorAll('#downloads-filter-pills .filter-pill').forEach((pill) => {
    pill.addEventListener('click', () => {
      dlUiState.activeFilter = pill.dataset.filter || 'all';
      document.querySelectorAll('#downloads-filter-pills .filter-pill').forEach((p) => {
        p.classList.toggle('active', p === pill);
      });
      if (dlUiState.controller) {
        dlRenderManagerModal(dlUiState.controller.getSnapshot(), dlUiState.activeFilter, dlGetEffectiveBaseDir(''));
      }
    });
  });

  dlEl('btn-downloads-open-folder')?.addEventListener('click', () => {
    window.electronAPI?.openDownloadFolder?.(dlGetEffectiveBaseDir(''));
  });
  dlEl('btn-downloads-clear-completed')?.addEventListener('click', () => {
    window.electronAPI?.clearCompletedDownloads?.();
  });
  dlEl('btn-downloads-cancel-all')?.addEventListener('click', () => {
    window.electronAPI?.cancelAllDownloads?.();
  });
}

function dlWireBarAndEscapeEvents() {
  dlEl('btn-downloads')?.addEventListener('click', dlOpenManagerModal);
  dlEl('btn-dsb-queue')?.addEventListener('click', dlOpenManagerModal);
  dlEl('btn-dsb-dismiss')?.addEventListener('click', () => {
    dlUiState.isStatusBarDismissed = true;
    const bar = dlEl('download-status-bar');
    if (bar) bar.style.display = 'none';
  });

  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (dlEl('download-conflict-modal')?.style.display === 'flex') {
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      dlCloseConflictModal('cancel');
      return;
    }
    if (dlEl('download-options-modal')?.style.display === 'flex') {
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      dlCloseOptionsModal(null);
      return;
    }
    if (dlEl('downloads-modal')?.style.display === 'flex') {
      e.stopPropagation();
      e.stopImmediatePropagation?.();
      dlCloseManagerModal();
    }
  }, true);
}

function dlObservePlaylistVisibility(controller) {
  const sidebarTabsEl = dlEl('sidebar-tabs');
  if (!sidebarTabsEl || typeof MutationObserver === 'undefined') return;
  const observer = new MutationObserver(() => dlRenderTopBarButton(controller.getSnapshot()));
  observer.observe(sidebarTabsEl, { attributes: true, attributeFilter: ['style'] });
}

function dlCreateBrowserRuntime() {
  const controller = createDownloadController({
    AppSettings: window.AppSettings,
    electronAPI: window.electronAPI,
    openOptionsModal: dlOpenOptionsModal,
    openConflictModal: dlOpenConflictModal,
    onBatchEnqueued: () => {
      dlUiState.isStatusBarDismissed = false;
      dlRenderStatusBar(controller.getSnapshot(), false);
    },
    onSnapshot: (snapshot) => {
      dlRenderTopBarButton(snapshot);
      dlRenderStatusBar(snapshot, dlUiState.isStatusBarDismissed);
      dlRenderManagerModal(snapshot, dlUiState.activeFilter, dlGetEffectiveBaseDir(''));
      if (typeof window.refreshEpisodeDownloadBadges === 'function') {
        window.refreshEpisodeDownloadBadges();
      }
    },
  });
  dlUiState.controller = controller;

  async function init() {
    if (dlUiState.initialized) return;
    dlUiState.initialized = true;

    dlWireOptionsModalEvents();
    dlWireConflictAndManagerEvents();
    dlWireBarAndEscapeEvents();
    dlObservePlaylistVisibility(controller);

    window.electronAPI?.onDownloadStateUpdate?.((snapshot) => controller.updateSnapshot(snapshot));
    window.electronAPI?.onContextMenuDownload?.((data) => {
      if (!data || !data.item) return;
      const isOptions = data.mode === 'options';
      controller.triggerDownload([data.item], {
        source: isOptions ? 'context-options' : 'context-default',
        forceDialog: isOptions,
      }).catch((err) => {
        console.warn('[Downloads] context-menu triggerDownload failed:', err && err.message);
        if (typeof alert === 'function') {
          alert((err && err.message) || 'Download konnte nicht gestartet werden.');
        }
      });
    });

    dlRenderTopBarButton(controller.getSnapshot());
    await dlRefreshDefaultDir();
    if (window.electronAPI?.getDownloadState) {
      try {
        controller.updateSnapshot(await window.electronAPI.getDownloadState());
      } catch (err) {
        console.warn('[Downloads] initial getDownloadState failed:', err && err.message);
      }
    }
  }

  return {
    init,
    triggerDownload: (items, opts) =>
      controller.triggerDownload(items, opts).catch((err) => {
        console.warn('[Downloads] triggerDownload failed:', err && err.message);
        if (typeof alert === 'function') {
          alert((err && err.message) || 'Download konnte nicht gestartet werden.');
        }
        return { cancelled: true, added: 0, jobs: [] };
      }),
    openManagerModal: dlOpenManagerModal,
    getJobForItemKey: (itemKey) => controller.getJobForItemKey(itemKey),
    refreshVisibility: () => dlRenderTopBarButton(controller.getSnapshot()),
  };
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    createDownloadController,
    buildPathPreview,
  };
}

if (typeof document !== 'undefined' && typeof window !== 'undefined') {
  window.DownloadUI = dlCreateBrowserRuntime();
}
