/**
 * 2-Stage VOD Download & Transcode Pipeline Orchestrator.
 *
 * Coordinates Stage 1 HTTP/HTTPS downloads (lib/downloader.js) and
 * Stage 2 local FFmpeg transcodes (lib/transcoder.js) with:
 * - Path sanitization & structured/flat output layout
 * - Disk, intra-batch, and in-flight duplicate conflict detection
 * - Max 1 download, max 1 transcode, and max 1 queued_transcode backpressure
 * - Pre-flight disk space checks (500 MB minimum via fs.promises.statfs)
 * - Stage-2 .raw.part retention for transcode-only retry and temp cleanup
 * - Credential-free throttled snapshots & lazy-loaded Electron IPC wiring
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { downloadFile: defaultDownloadFile, redactUrl: defaultRedactUrl } = require('./downloader');
const { transcodeFile: defaultTranscodeFile, listVaapiDevices: defaultListVaapiDevices } = require('./transcoder');

const MIN_FREE_BYTES = 500 * 1024 * 1024;
const DEFAULT_THROTTLE_MS = 300;
const ACTIVE_STATUSES = new Set(['queued', 'downloading', 'queued_transcode', 'transcoding']);
const CLEARABLE_STATUSES = new Set(['completed', 'cancelled']);
const ILLEGAL_FILENAME_CHARS_RE = /[\\/:*?"<>|\x00-\x1f\x7f]/g;
const URL_LIKE_TEXT_RE = /(:\/\/|\/(?:live|movie|series)\/|[?&](?:username|password|token)=)/i;

function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}

function getDefaultDownloadDir(app) {
  let downloadsDir = '';
  try {
    downloadsDir = app && typeof app.getPath === 'function' ? app.getPath('downloads') : '';
  } catch {
    downloadsDir = '';
  }
  const base = downloadsDir || path.join(os.homedir(), 'Downloads');
  return path.join(base, 'BeamcastIPTV');
}

function sanitizeSegment(str) {
  if (str === null || str === undefined) return '';
  return String(str)
    .replace(ILLEGAL_FILENAME_CHARS_RE, ' ')
    .replace(/\.{2,}/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/^[.\s]+|[.\s]+$/g, '');
}

function sanitizeName(str) {
  return sanitizeSegment(str) || 'video';
}

function sanitizeExt(sourceExt, preset) {
  if (preset !== 'original') return 'mp4';
  const cleaned = String(sourceExt || '')
    .replace(/^\.+/, '')
    .replace(/[^a-zA-Z0-9_-]/g, '');
  return cleaned || 'mkv';
}

function padTwoDigits(value, fallback = 1) {
  const num = Number.parseInt(value, 10);
  const safe = Number.isFinite(num) && num >= 0 ? num : fallback;
  return String(safe).padStart(2, '0');
}

function startsWithToken(text, prefix) {
  if (!text || !prefix) return false;
  const lowerText = text.toLowerCase();
  const lowerPrefix = prefix.toLowerCase();
  if (!lowerText.startsWith(lowerPrefix)) return false;
  if (lowerText.length === lowerPrefix.length) return true;
  const nextChar = lowerText.charAt(lowerPrefix.length);
  return !/[\p{L}\p{N}]/u.test(nextChar);
}

function isRedundantEpisodeTitle({ rawEpisodeTitle, cleanEpisodeTitle, seriesName, cleanSeries, epCode }) {
  if (!cleanEpisodeTitle) return true;
  if (/^episode\s+\d+$/i.test(cleanEpisodeTitle)) return true;
  if (startsWithToken(cleanEpisodeTitle, cleanSeries)) return true;
  const rawSeries = sanitizeSegment(seriesName);
  if (rawSeries && startsWithToken(String(rawEpisodeTitle || '').trim(), rawSeries)) return true;
  return startsWithToken(cleanEpisodeTitle, epCode);
}

function resolveTargetPath({
  baseDir,
  structure = 'structured',
  mediaType = 'movie',
  title,
  seriesName,
  seasonNum,
  episodeNum,
  episodeTitle,
  sourceExt,
  preset = 'hevc',
}) {
  const rootDir = baseDir || getDefaultDownloadDir(null);
  const ext = sanitizeExt(sourceExt, preset);
  const isEpisode = mediaType === 'episode' || mediaType === 'series';

  if (!isEpisode) {
    const fileName = `${sanitizeName(title)}.${ext}`;
    return structure === 'flat' ? path.join(rootDir, fileName) : path.join(rootDir, 'Movies', fileName);
  }

  const cleanSeries = sanitizeName(seriesName || title);
  const paddedSeason = padTwoDigits(seasonNum, 1);
  const paddedEpisode = padTwoDigits(episodeNum, 1);
  const epCode = `S${paddedSeason}E${paddedEpisode}`;
  const cleanEpTitle = sanitizeSegment(episodeTitle);
  const redundant = isRedundantEpisodeTitle({
    rawEpisodeTitle: episodeTitle,
    cleanEpisodeTitle: cleanEpTitle,
    seriesName,
    cleanSeries,
    epCode,
  });

  const stem = redundant ? `${cleanSeries} - ${epCode}` : `${cleanSeries} - ${epCode} - ${cleanEpTitle}`;
  const fileName = `${stem}.${ext}`;
  return structure === 'flat'
    ? path.join(rootDir, fileName)
    : path.join(rootDir, 'Series', cleanSeries, `Season ${paddedSeason}`, fileName);
}

function resolveDuplicatePath(targetPath, action = 'skip', existsFn = fs.existsSync) {
  if (action === 'overwrite') {
    return { action: 'overwrite', finalPath: targetPath };
  }
  if (action === 'rename') {
    if (!existsFn(targetPath)) {
      return { action: 'rename', finalPath: targetPath };
    }
    const dir = path.dirname(targetPath);
    const ext = path.extname(targetPath);
    const stem = path.basename(targetPath, ext);
    for (let i = 1; ; i += 1) {
      const candidate = path.join(dir, `${stem} (${i})${ext}`);
      if (!existsFn(candidate)) {
        return { action: 'rename', finalPath: candidate };
      }
    }
  }
  return { action: 'skip', finalPath: targetPath };
}

function sanitizeErrorMessage(err, rawUrl, redactUrlFn) {
  let msg = err && typeof err.message === 'string' ? err.message : String(err || 'Unbekannter Fehler');
  if (rawUrl && msg.includes(rawUrl)) {
    msg = msg.split(rawUrl).join(redactUrlFn(rawUrl));
  }
  if (URL_LIKE_TEXT_RE.test(msg)) {
    msg = msg.replace(/https?:\/\/[^\s"'<>]+/gi, (match) => redactUrlFn(match));
    if (URL_LIKE_TEXT_RE.test(msg)) {
      msg = redactUrlFn(msg);
    }
  }
  return msg;
}

async function safeUnlink(unlinkFn, filePath) {
  if (!filePath) return;
  try {
    await unlinkFn(filePath);
  } catch {
    // Ignore ENOENT or already-deleted temp files.
  }
}

async function safeStatSize(statFn, filePath) {
  if (!filePath) return null;
  try {
    const st = await statFn(filePath);
    return typeof st?.size === 'number' ? st.size : null;
  } catch {
    return null;
  }
}

async function checkDiskSpace({ statfsFn, targetDir, minFreeBytes, expectedBytes = 0, stage = 'download' }) {
  if (typeof statfsFn !== 'function') return null;
  let stats;
  try {
    stats = await statfsFn(targetDir);
  } catch {
    return null;
  }

  const freeBytes = Number(stats?.bavail) * Number(stats?.bsize);
  if (!Number.isFinite(freeBytes) || freeBytes < 0) return null;

  if (freeBytes < minFreeBytes) {
    throw new Error(
      stage === 'transcode'
        ? 'Nicht genügend Speicherplatz für Transcoding (< 500 MB frei).'
        : 'Nicht genügend Speicherplatz für Download (< 500 MB frei).'
    );
  }
  if (expectedBytes > 0 && expectedBytes > freeBytes) {
    throw new Error('Nicht genügend Speicherplatz für diesen Download verfügbar.');
  }
  return freeBytes;
}

function resolveFsDeps(deps, customFs) {
  const customPromises = customFs.promises || {};
  const fsOps = {};
  for (const name of ['stat', 'statfs', 'mkdir', 'rename', 'unlink']) {
    fsOps[name] = deps[name] || customPromises[name] || fs.promises[name];
  }
  fsOps.existsSync = deps.existsSync || customFs.existsSync || fs.existsSync;
  return fsOps;
}

function resolveManagerDeps(deps = {}) {
  const customFs = deps.fs || {};
  return {
    downloadFile: deps.downloadFile || defaultDownloadFile,
    transcodeFile: deps.transcodeFile || defaultTranscodeFile,
    listVaapiDevices: deps.listVaapiDevices || defaultListVaapiDevices,
    redactUrl: deps.redactUrl || defaultRedactUrl,
    ...resolveFsDeps(deps, customFs),
    onStateChange: typeof deps.onStateChange === 'function' ? deps.onStateChange : null,
    defaultBaseDir: deps.defaultBaseDir || getDefaultDownloadDir(null),
    throttleMs: typeof deps.throttleMs === 'number' ? deps.throttleMs : DEFAULT_THROTTLE_MS,
    minFreeBytes: typeof deps.minFreeBytes === 'number' ? deps.minFreeBytes : MIN_FREE_BYTES,
  };
}

function resolveBatchOptions(options = {}, defaultBaseDir) {
  return {
    baseDir: options.baseDir || options.downloadDir || defaultBaseDir,
    structure: options.structure || options.folderStructure || 'structured',
    preset: options.preset || 'hevc',
    resolution: options.resolution || '1080p',
    hwAccel: options.hwAccel || 'auto',
    duplicateAction: options.duplicateAction || 'ask',
  };
}

function deriveItemKey(item, index) {
  if (item?.itemKey) return String(item.itemKey);
  if (item?.mediaType === 'episode' || item?.mediaType === 'series') {
    return `episode:${item.seriesId || item.seriesName || 's'}:${item.seasonNum ?? 1}:${item.episodeNum ?? index}`;
  }
  return `movie:${item?.title || index}`;
}

function deriveDisplayTitle(item) {
  if (item?.title) return String(item.title);
  if (item?.mediaType === 'episode' || item?.mediaType === 'series') {
    const code = `S${padTwoDigits(item.seasonNum, 1)}E${padTwoDigits(item.episodeNum, 1)}`;
    const base = `${sanitizeName(item.seriesName)} - ${code}`;
    const cleanEp = sanitizeSegment(item.episodeTitle);
    return cleanEp ? `${base} - ${cleanEp}` : base;
  }
  return 'Video';
}

function serializeJob(job) {
  return {
    id: job.id,
    itemKey: job.itemKey,
    mediaType: job.mediaType,
    title: job.title,
    seriesId: job.seriesId,
    seriesName: job.seriesName,
    seasonNum: job.seasonNum,
    episodeNum: job.episodeNum,
    preset: job.preset,
    resolution: job.resolution,
    status: job.status,
    statusNote: job.statusNote,
    progress: job.progress,
    bytesWritten: job.bytesWritten,
    totalBytes: job.totalBytes,
    speedBps: job.speedBps,
    etaSec: job.etaSec,
    transcodeSpeed: job.transcodeSpeed,
    finalPath: job.finalPath,
    finalSizeBytes: job.finalSizeBytes,
    originalSizeBytes: job.originalSizeBytes,
    encoderUsed: job.encoderUsed,
    error: job.error,
    errorStage: job.errorStage,
    createdAt: job.createdAt,
  };
}

function summarizeJobs(jobs) {
  const summary = {
    downloading: 0,
    transcoding: 0,
    queued: 0,
    queuedTranscode: 0,
    completed: 0,
    error: 0,
    activeTotal: 0,
  };
  for (const job of jobs) {
    if (job.status === 'downloading') summary.downloading += 1;
    else if (job.status === 'transcoding') summary.transcoding += 1;
    else if (job.status === 'queued') summary.queued += 1;
    else if (job.status === 'queued_transcode') summary.queuedTranscode += 1;
    else if (job.status === 'completed') summary.completed += 1;
    else if (job.status === 'error') summary.error += 1;
  }
  summary.activeTotal = summary.downloading + summary.transcoding + summary.queued + summary.queuedTranscode;
  return summary;
}

function createJobRecord({ id, item, itemKey, finalPath, opts }) {
  return {
    id,
    itemKey,
    mediaType: item.mediaType || 'movie',
    title: deriveDisplayTitle(item),
    seriesId: item.seriesId ?? null,
    seriesName: item.seriesName ?? null,
    seasonNum: item.seasonNum ?? null,
    episodeNum: item.episodeNum ?? null,
    preset: opts.preset,
    resolution: opts.resolution,
    status: 'queued',
    statusNote: null,
    progress: 0,
    bytesWritten: 0,
    totalBytes: 0,
    speedBps: 0,
    etaSec: null,
    transcodeSpeed: null,
    finalPath,
    finalSizeBytes: null,
    originalSizeBytes: null,
    encoderUsed: null,
    error: null,
    errorStage: null,
    createdAt: Date.now(),
  };
}

function createJobMeta({ id, item, finalPath, hwAccel }) {
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, '');
  const targetDir = path.dirname(finalPath);
  return {
    url: item.url || '',
    hwAccel,
    rawPartPath: path.join(targetDir, `.${safeId}.raw.part`),
    transcodePartPath: path.join(targetDir, `.${safeId}.transcode.part.mp4`),
    expectedBytes: Number(item.totalBytes) > 0 ? Number(item.totalBytes) : 0,
    abortController: null,
    activePromise: null,
    cancelRequested: false,
    diskExceeded: false,
    diskErrorMsg: null,
  };
}

function collectInflightTargets(jobs) {
  const targets = new Set();
  for (const job of jobs) {
    if (isActiveStatus(job.status) && job.finalPath) {
      targets.add(path.resolve(job.finalPath));
    }
  }
  return targets;
}

function collectActiveItemKeys(jobs) {
  const keys = new Set();
  for (const job of jobs) {
    if (isActiveStatus(job.status)) keys.add(job.itemKey);
  }
  return keys;
}

async function cleanupJobTempFiles(deps, meta) {
  if (!meta) return;
  await Promise.all([
    safeUnlink(deps.unlink, meta.transcodePartPath),
    safeUnlink(deps.unlink, meta.rawPartPath),
  ]);
}

function createAbortErr() {
  return Object.assign(new Error('Aborted'), { name: 'AbortError' });
}

function createStateEmitter(deps, getSnapshot) {
  let emitTimer = null;
  let lastEmitAt = 0;

  const emitNow = () => {
    if (!deps.onStateChange) return;
    lastEmitAt = Date.now();
    deps.onStateChange(getSnapshot());
  };

  const emitImmediate = () => {
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
    emitNow();
  };

  const scheduleEmit = () => {
    if (!deps.onStateChange) return;
    const elapsed = Date.now() - lastEmitAt;
    if (elapsed >= deps.throttleMs && !emitTimer) {
      emitNow();
      return;
    }
    if (!emitTimer) {
      const waitMs = Math.max(0, deps.throttleMs - elapsed);
      emitTimer = setTimeout(() => {
        emitTimer = null;
        emitNow();
      }, waitMs);
      emitTimer.unref?.();
    }
  };

  const clearTimer = () => {
    if (emitTimer) {
      clearTimeout(emitTimer);
      emitTimer = null;
    }
  };

  return { emitImmediate, scheduleEmit, clearTimer };
}

async function inspectItemConflict({ item, index, opts, inflightTargets, seenBatchTargets, statFn }) {
  const itemKey = deriveItemKey(item, index);
  const targetPath = resolveTargetPath({
    baseDir: opts.baseDir,
    structure: opts.structure,
    mediaType: item.mediaType,
    title: item.title,
    seriesName: item.seriesName,
    seasonNum: item.seasonNum,
    episodeNum: item.episodeNum,
    episodeTitle: item.episodeTitle,
    sourceExt: item.sourceExt,
    preset: opts.preset,
  });
  const normPath = path.resolve(targetPath);
  let conflict = null;

  if (inflightTargets.has(normPath)) {
    conflict = {
      index,
      itemKey,
      title: deriveDisplayTitle(item),
      existingPath: targetPath,
      existingSizeBytes: (await safeStatSize(statFn, targetPath)) ?? 0,
      reason: 'inflight',
    };
  } else if (seenBatchTargets.has(normPath)) {
    conflict = {
      index,
      itemKey,
      title: deriveDisplayTitle(item),
      existingPath: targetPath,
      existingSizeBytes: 0,
      reason: 'batch',
    };
  } else {
    const sizeBytes = await safeStatSize(statFn, targetPath);
    if (sizeBytes !== null) {
      conflict = {
        index,
        itemKey,
        title: deriveDisplayTitle(item),
        existingPath: targetPath,
        existingSizeBytes: sizeBytes,
        reason: 'disk',
      };
    }
  }

  seenBatchTargets.add(normPath);
  return { resolvedTarget: { index, itemKey, targetPath }, conflict };
}

async function checkConflictsWithCtx(ctx, items = [], options = {}) {
  const opts = resolveBatchOptions(options, ctx.deps.defaultBaseDir);
  const inflightTargets = collectInflightTargets(ctx.jobs);
  const seenBatchTargets = new Set();
  const conflicts = [];
  const resolvedTargets = [];

  for (let index = 0; index < items.length; index += 1) {
    const { resolvedTarget, conflict } = await inspectItemConflict({
      item: items[index] || {},
      index,
      opts,
      inflightTargets,
      seenBatchTargets,
      statFn: ctx.deps.stat,
    });
    resolvedTargets.push(resolvedTarget);
    if (conflict) conflicts.push(conflict);
  }

  return { conflicts, resolvedTargets };
}

async function finalizeOriginalJob(deps, job, meta, dlResult) {
  await deps.mkdir(path.dirname(job.finalPath), { recursive: true });
  await deps.rename(meta.rawPartPath, job.finalPath);
  const finalSize = await safeStatSize(deps.stat, job.finalPath);
  job.originalSizeBytes = finalSize ?? dlResult?.bytesWritten ?? job.bytesWritten;
  job.finalSizeBytes = job.originalSizeBytes;
  job.encoderUsed = 'original';
  job.progress = 100;
  job.speedBps = 0;
  job.etaSec = null;
  job.status = 'completed';
  job.error = null;
  job.errorStage = null;
}

async function handleStage1Failure(ctx, job, meta, err, signal) {
  await cleanupJobTempFiles(ctx.deps, meta);
  if (meta.diskExceeded) {
    job.status = 'error';
    job.errorStage = 'download';
    job.error = meta.diskErrorMsg;
  } else if (meta.cancelRequested || err?.name === 'AbortError' || signal.aborted) {
    job.status = 'cancelled';
    job.error = null;
    job.errorStage = null;
  } else {
    job.status = 'error';
    job.errorStage = 'download';
    job.error = sanitizeErrorMessage(err, meta.url, ctx.deps.redactUrl);
  }
  job.speedBps = 0;
  job.etaSec = null;
}

function createStage1ProgressHandler(ctx, job, meta, initialFreeBytes, controller) {
  return ({ bytesWritten, totalBytes, speedBps, etaSec }) => {
    if (job.status !== 'downloading') return;
    if (!meta.diskExceeded && totalBytes > 0 && initialFreeBytes !== null && totalBytes > initialFreeBytes) {
      meta.diskExceeded = true;
      meta.diskErrorMsg = 'Nicht genügend Speicherplatz für diesen Download verfügbar.';
      controller.abort();
      return;
    }
    job.bytesWritten = bytesWritten ?? 0;
    job.totalBytes = totalBytes ?? 0;
    job.speedBps = speedBps ?? 0;
    job.etaSec = etaSec ?? null;
    job.progress = job.totalBytes > 0
      ? Math.min(100, Math.max(0, (job.bytesWritten / job.totalBytes) * 100))
      : 0;
    ctx.emitter.scheduleEmit();
  };
}

async function completeStage1Job(ctx, job, meta, dlResult) {
  job.bytesWritten = dlResult?.bytesWritten ?? job.bytesWritten;
  job.totalBytes = dlResult?.totalBytes ?? job.totalBytes;

  if (job.preset === 'original') {
    await finalizeOriginalJob(ctx.deps, job, meta, dlResult);
    return;
  }
  job.originalSizeBytes = (await safeStatSize(ctx.deps.stat, meta.rawPartPath)) ?? job.bytesWritten;
  job.status = 'queued_transcode';
  job.progress = 0;
  job.speedBps = 0;
  job.etaSec = null;
  job.transcodeSpeed = null;
}

async function runStage1ForJob(ctx, job, meta) {
  const controller = new AbortController();
  meta.abortController = controller;
  meta.diskExceeded = false;
  meta.diskErrorMsg = null;

  try {
    const targetDir = path.dirname(job.finalPath);
    await ctx.deps.mkdir(targetDir, { recursive: true });
    const initialFreeBytes = await checkDiskSpace({
      statfsFn: ctx.deps.statfs,
      targetDir,
      minFreeBytes: ctx.deps.minFreeBytes,
      expectedBytes: meta.expectedBytes,
      stage: 'download',
    });

    if (meta.cancelRequested || controller.signal.aborted) throw createAbortErr();

    const dlResult = await ctx.deps.downloadFile({
      url: meta.url,
      partPath: meta.rawPartPath,
      signal: controller.signal,
      onProgress: createStage1ProgressHandler(ctx, job, meta, initialFreeBytes, controller),
    });

    if (meta.cancelRequested || controller.signal.aborted) throw createAbortErr();
    await completeStage1Job(ctx, job, meta, dlResult);
  } catch (err) {
    await handleStage1Failure(ctx, job, meta, err, controller.signal);
  } finally {
    if (meta.abortController === controller) {
      meta.abortController = null;
      meta.activePromise = null;
    }
    pumpQueueWithCtx(ctx);
    ctx.emitter.emitImmediate();
  }
}

async function handleStage2Failure(ctx, job, meta, err, signal) {
  await safeUnlink(ctx.deps.unlink, meta.transcodePartPath);
  if (meta.cancelRequested || err?.name === 'AbortError' || signal.aborted) {
    await safeUnlink(ctx.deps.unlink, meta.rawPartPath);
    job.status = 'cancelled';
    job.error = null;
    job.errorStage = null;
  } else {
    // Retain .raw.part so Stage 2 can be retried without re-downloading.
    job.status = 'error';
    job.errorStage = 'transcode';
    job.error = sanitizeErrorMessage(err, meta.url, ctx.deps.redactUrl);
  }
  job.transcodeSpeed = null;
  job.etaSec = null;
}

async function finalizeStage2Success(ctx, job, meta, result) {
  await ctx.deps.rename(meta.transcodePartPath, job.finalPath);
  await safeUnlink(ctx.deps.unlink, meta.rawPartPath);

  job.finalSizeBytes = await safeStatSize(ctx.deps.stat, job.finalPath);
  job.encoderUsed = result?.encoderUsed || null;
  if (result?.remuxFallbackToH264 && !job.statusNote) {
    job.statusNote = 'Remux nicht möglich → H.264';
  }
  job.progress = 100;
  job.transcodeSpeed = null;
  job.etaSec = null;
  job.status = 'completed';
  job.error = null;
  job.errorStage = null;
}

async function runStage2ForJob(ctx, job, meta) {
  const controller = new AbortController();
  meta.abortController = controller;

  try {
    const targetDir = path.dirname(job.finalPath);
    await ctx.deps.mkdir(targetDir, { recursive: true });
    await checkDiskSpace({
      statfsFn: ctx.deps.statfs,
      targetDir,
      minFreeBytes: ctx.deps.minFreeBytes,
      stage: 'transcode',
    });

    if (meta.cancelRequested || controller.signal.aborted) throw createAbortErr();

    const result = await ctx.deps.transcodeFile({
      inputPath: meta.rawPartPath,
      outputPath: meta.transcodePartPath,
      preset: job.preset,
      resolution: job.resolution,
      hwAccel: meta.hwAccel,
      signal: controller.signal,
      onProgress: ({ percent, speed, etaSec }) => {
        if (job.status !== 'transcoding') return;
        job.progress = Number.isFinite(percent) ? percent : job.progress;
        job.transcodeSpeed = speed ?? null;
        job.etaSec = etaSec ?? null;
        ctx.emitter.scheduleEmit();
      },
      onStatusNote: (note) => {
        job.statusNote = note || null;
        ctx.emitter.emitImmediate();
      },
    });

    if (meta.cancelRequested || controller.signal.aborted) throw createAbortErr();
    await finalizeStage2Success(ctx, job, meta, result);
  } catch (err) {
    await handleStage2Failure(ctx, job, meta, err, controller.signal);
  } finally {
    if (meta.abortController === controller) {
      meta.abortController = null;
      meta.activePromise = null;
    }
    pumpQueueWithCtx(ctx);
    ctx.emitter.emitImmediate();
  }
}

function pumpQueueWithCtx(ctx) {
  if (ctx.state.isShuttingDown) return;

  const summary = summarizeJobs(ctx.jobs);
  let queuedTranscodeCount = summary.queuedTranscode;

  if (summary.transcoding === 0 && queuedTranscodeCount > 0) {
    const nextTranscode = ctx.jobs.find((j) => j.status === 'queued_transcode');
    if (nextTranscode) {
      const meta = ctx.metaById.get(nextTranscode.id);
      nextTranscode.status = 'transcoding';
      nextTranscode.error = null;
      nextTranscode.errorStage = null;
      queuedTranscodeCount -= 1;
      meta.cancelRequested = false;
      meta.activePromise = runStage2ForJob(ctx, nextTranscode, meta);
    }
  }

  if (summary.downloading === 0 && queuedTranscodeCount < 1) {
    const nextDownload = ctx.jobs.find((j) => j.status === 'queued');
    if (nextDownload) {
      const meta = ctx.metaById.get(nextDownload.id);
      nextDownload.status = 'downloading';
      nextDownload.error = null;
      nextDownload.errorStage = null;
      meta.cancelRequested = false;
      meta.activePromise = runStage1ForJob(ctx, nextDownload, meta);
    }
  }
}

function enqueueDownloadsWithCtx(ctx, items = [], options = {}) {
  const opts = resolveBatchOptions(options, ctx.deps.defaultBaseDir);
  const activeItemKeys = collectActiveItemKeys(ctx.jobs);
  const reservedPaths = collectInflightTargets(ctx.jobs);
  const addedJobs = [];
  let skippedDuplicateItem = 0;
  let skippedExisting = 0;

  for (let index = 0; index < items.length; index += 1) {
    const item = items[index] || {};
    const itemKey = deriveItemKey(item, index);
    if (activeItemKeys.has(itemKey)) {
      skippedDuplicateItem += 1;
      continue;
    }

    const intendedPath = resolveTargetPath({
      baseDir: opts.baseDir,
      structure: opts.structure,
      mediaType: item.mediaType,
      title: item.title,
      seriesName: item.seriesName,
      seasonNum: item.seasonNum,
      episodeNum: item.episodeNum,
      episodeTitle: item.episodeTitle,
      sourceExt: item.sourceExt,
      preset: opts.preset,
    });

    const isCollision = (p) => reservedPaths.has(path.resolve(p)) || ctx.deps.existsSync(p);
    let finalPath = intendedPath;
    if (isCollision(intendedPath)) {
      const action = opts.duplicateAction === 'ask' ? 'skip' : opts.duplicateAction;
      const resolved = resolveDuplicatePath(intendedPath, action, isCollision);
      if (resolved.action === 'skip') {
        skippedExisting += 1;
        continue;
      }
      finalPath = resolved.finalPath;
    }

    ctx.state.jobSeq += 1;
    const id = `job_${ctx.state.jobSeq}_${Date.now().toString(36)}`;
    const job = createJobRecord({ id, item, itemKey, finalPath, opts });
    const meta = createJobMeta({ id, item, finalPath, hwAccel: opts.hwAccel });

    ctx.jobs.push(job);
    ctx.metaById.set(id, meta);
    activeItemKeys.add(itemKey);
    reservedPaths.add(path.resolve(finalPath));
    addedJobs.push(job);
  }

  if (addedJobs.length > 0) {
    pumpQueueWithCtx(ctx);
    ctx.emitter.emitImmediate();
  }

  return Promise.resolve({
    added: addedJobs.length,
    skippedDuplicateItem,
    skippedExisting,
    jobs: addedJobs.map(serializeJob),
  });
}

function resetJobAsCancelled(job) {
  job.status = 'cancelled';
  job.error = null;
  job.errorStage = null;
  job.speedBps = 0;
  job.transcodeSpeed = null;
  job.etaSec = null;
}

async function cancelJobWithCtx(ctx, jobId) {
  const job = ctx.jobs.find((j) => j.id === jobId);
  const meta = ctx.metaById.get(jobId);
  if (!job || !meta || !isActiveStatus(job.status)) return;

  meta.cancelRequested = true;
  if (job.status === 'queued' || job.status === 'queued_transcode') {
    resetJobAsCancelled(job);
    await cleanupJobTempFiles(ctx.deps, meta);
    pumpQueueWithCtx(ctx);
    ctx.emitter.emitImmediate();
    return;
  }

  const running = meta.activePromise;
  meta.abortController?.abort();
  if (running) await running.catch(() => {});
  await cleanupJobTempFiles(ctx.deps, meta);
}

async function cancelAllWithCtx(ctx) {
  const active = ctx.jobs.filter((j) => isActiveStatus(j.status));
  if (active.length === 0) return;

  const waiters = [];
  for (const job of active) {
    const meta = ctx.metaById.get(job.id);
    if (!meta) continue;
    meta.cancelRequested = true;
    if (job.status === 'queued' || job.status === 'queued_transcode') {
      resetJobAsCancelled(job);
      waiters.push(cleanupJobTempFiles(ctx.deps, meta));
    } else {
      if (meta.activePromise) {
        waiters.push(meta.activePromise.catch(() => {}).then(() => cleanupJobTempFiles(ctx.deps, meta)));
      }
      meta.abortController?.abort();
    }
  }

  await Promise.all(waiters);
  ctx.emitter.emitImmediate();
}

async function retryJobWithCtx(ctx, jobId) {
  const job = ctx.jobs.find((j) => j.id === jobId);
  const meta = ctx.metaById.get(jobId);
  if (!job || !meta || (job.status !== 'error' && job.status !== 'cancelled')) return false;

  const normFinal = path.resolve(job.finalPath);
  const conflictActive = ctx.jobs.some(
    (other) =>
      other.id !== job.id &&
      isActiveStatus(other.status) &&
      (other.itemKey === job.itemKey || path.resolve(other.finalPath) === normFinal)
  );
  if (conflictActive) return false;

  const canResumeStage2 =
    job.errorStage === 'transcode' &&
    job.preset !== 'original' &&
    ctx.deps.existsSync(meta.rawPartPath);

  await safeUnlink(ctx.deps.unlink, meta.transcodePartPath);
  meta.cancelRequested = false;
  job.error = null;
  job.errorStage = null;
  job.statusNote = null;
  job.progress = 0;
  job.etaSec = null;
  job.transcodeSpeed = null;

  if (canResumeStage2) {
    job.status = 'queued_transcode';
  } else {
    await safeUnlink(ctx.deps.unlink, meta.rawPartPath);
    job.bytesWritten = 0;
    job.totalBytes = 0;
    job.speedBps = 0;
    job.encoderUsed = null;
    job.status = 'queued';
  }

  pumpQueueWithCtx(ctx);
  ctx.emitter.emitImmediate();
  return true;
}

async function removeJobWithCtx(ctx, jobId) {
  const idx = ctx.jobs.findIndex((j) => j.id === jobId);
  if (idx === -1) return;
  const job = ctx.jobs[idx];
  const meta = ctx.metaById.get(jobId);

  if (isActiveStatus(job.status)) {
    await cancelJobWithCtx(ctx, jobId);
  } else {
    await cleanupJobTempFiles(ctx.deps, meta);
  }

  const currentIdx = ctx.jobs.findIndex((j) => j.id === jobId);
  if (currentIdx !== -1) ctx.jobs.splice(currentIdx, 1);
  ctx.metaById.delete(jobId);
  ctx.emitter.emitImmediate();
}

function clearCompletedWithCtx(ctx) {
  let removed = false;
  for (let i = ctx.jobs.length - 1; i >= 0; i -= 1) {
    if (CLEARABLE_STATUSES.has(ctx.jobs[i].status)) {
      const [removedJob] = ctx.jobs.splice(i, 1);
      const meta = ctx.metaById.get(removedJob.id);
      ctx.metaById.delete(removedJob.id);
      cleanupJobTempFiles(ctx.deps, meta).catch(() => {});
      removed = true;
    }
  }
  if (removed) ctx.emitter.emitImmediate();
}

async function shutdownWithCtx(ctx) {
  ctx.state.isShuttingDown = true;
  ctx.emitter.clearTimer();
  await cancelAllWithCtx(ctx);
  await Promise.all(Array.from(ctx.metaById.values(), (meta) => cleanupJobTempFiles(ctx.deps, meta)));
}

function createDownloadManager(rawDeps = {}) {
  const deps = resolveManagerDeps(rawDeps);
  const jobs = [];
  const metaById = new Map();
  const state = { jobSeq: 0, isShuttingDown: false };
  const getStateSnapshot = () => ({ jobs: jobs.map(serializeJob), summary: summarizeJobs(jobs) });
  const emitter = createStateEmitter(deps, getStateSnapshot);
  const ctx = { deps, jobs, metaById, state, emitter };

  return {
    checkConflicts: (items, options) => checkConflictsWithCtx(ctx, items, options),
    enqueueDownloads: (items, options) => enqueueDownloadsWithCtx(ctx, items, options),
    getStateSnapshot,
    cancelJob: (jobId) => cancelJobWithCtx(ctx, jobId),
    cancelAll: () => cancelAllWithCtx(ctx),
    retryJob: (jobId) => retryJobWithCtx(ctx, jobId),
    removeJob: (jobId) => removeJobWithCtx(ctx, jobId),
    clearCompleted: () => clearCompletedWithCtx(ctx),
    hasActiveJobs: () => jobs.some((j) => isActiveStatus(j.status)),
    shutdown: () => shutdownWithCtx(ctx),
  };
}

// --- Electron Singleton Integration ---

let singletonManager = null;

async function openDownloadTarget({ targetPath, app, shell }) {
  const resolved = targetPath || getDefaultDownloadDir(app);
  try {
    const st = await fs.promises.stat(resolved);
    if (st.isDirectory()) {
      const errMsg = await shell.openPath(resolved);
      return errMsg ? { ok: false, error: errMsg } : { ok: true };
    }
    shell.showItemInFolder(resolved);
    return { ok: true };
  } catch {
    const dir = path.extname(resolved) ? path.dirname(resolved) : resolved;
    await fs.promises.mkdir(dir, { recursive: true });
    const errMsg = await shell.openPath(dir);
    return errMsg ? { ok: false, error: errMsg } : { ok: true };
  }
}

function registerIpcHandlers({ ipcMain, dialog, shell, manager, getMainWindow, app }) {
  const handle = (channel, fn) => {
    ipcMain.removeHandler?.(channel);
    ipcMain.handle(channel, fn);
  };

  handle('download:get-default-dir', () => getDefaultDownloadDir(app));
  handle('download:select-dir', async (_event, currentDir) => {
    const win = getMainWindow?.() || null;
    const opts = {
      defaultPath: currentDir || getDefaultDownloadDir(app),
      properties: ['openDirectory', 'createDirectory'],
    };
    const res = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (!res || res.canceled || !Array.isArray(res.filePaths) || res.filePaths.length === 0) {
      return null;
    }
    return res.filePaths[0];
  });
  handle('download:list-vaapi-devices', () => defaultListVaapiDevices());
  handle('download:check-conflicts', (_event, payload = {}) =>
    manager.checkConflicts(payload?.items || [], payload?.options || {})
  );
  handle('download:enqueue', (_event, payload = {}) =>
    manager.enqueueDownloads(payload?.items || [], payload?.options || {})
  );
  handle('download:get-state', () => manager.getStateSnapshot());
  handle('download:cancel', (_event, jobId) => manager.cancelJob(jobId));
  handle('download:cancel-all', () => manager.cancelAll());
  handle('download:retry', (_event, jobId) => manager.retryJob(jobId));
  handle('download:remove', (_event, jobId) => manager.removeJob(jobId));
  handle('download:clear-completed', () => manager.clearCompleted());
  handle('download:open-folder', (_event, targetPath) => openDownloadTarget({ targetPath, app, shell }));
}

function init(getMainWindow, app) {
  const { dialog, ipcMain, shell } = require('electron');
  const defaultBaseDir = getDefaultDownloadDir(app);
  singletonManager = createDownloadManager({
    defaultBaseDir,
    onStateChange: (snapshot) => {
      const win = getMainWindow?.();
      if (win && !win.isDestroyed() && win.webContents && !win.webContents.isDestroyed()) {
        win.webContents.send('download-state-update', snapshot);
      }
    },
  });
  registerIpcHandlers({ ipcMain, dialog, shell, manager: singletonManager, getMainWindow, app });
  return singletonManager;
}

function hasActiveJobs() {
  return singletonManager ? singletonManager.hasActiveJobs() : false;
}

async function shutdown() {
  if (singletonManager) {
    await singletonManager.shutdown();
  }
}

module.exports = {
  sanitizeName,
  resolveTargetPath,
  resolveDuplicatePath,
  createDownloadManager,
  init,
  hasActiveJobs,
  shutdown,
};
