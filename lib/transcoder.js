/**
 * FFprobe & FFmpeg VAAPI/CPU Transcoder.
 *
 * Pure Node.js module (zero Electron / npm dependencies) handling:
 * - Local media probing via ffprobe
 * - German-preferred audio stream selection
 * - Linux VAAPI device discovery (/dev/dri/renderD*) & 1-frame encoder probing
 * - Deterministic FFmpeg argument generation across hevc/h264/remux/original
 * - `-progress pipe:1` chunk parsing & single runtime VAAPI -> CPU fallback
 * - AbortSignal cancellation with SIGTERM -> 3s SIGKILL escalation
 */

const { spawn, execFile } = require('child_process');
const { promisify } = require('util');
const fs = require('fs');

const execFileAsync = promisify(execFile);

const DRI_DIR = '/dev/dri';
const RENDER_NODE_RE = /^renderD(\d+)$/;
const GERMAN_LANG_CODES = new Set(['ger', 'deu', 'de']);
const GERMAN_TITLE_RE = /\b(german|deutsch|ger|deu)\b/i;
const REMUX_COMPATIBLE_CODECS = new Set(['h264', 'hevc', 'h265', 'mpeg4', 'av1']);
const DEFAULT_FFPROBE_TIMEOUT_MS = 15000;
const VAINFO_TIMEOUT_MS = 2000;
const VAAPI_PROBE_TIMEOUT_MS = 5000;
const DEFAULT_KILL_TIMEOUT_MS = 3000;
const MAX_STDERR_CHARS = 4096;

const probeCache = new Map();

function createAbortError(message = 'Transcode aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function getTag(tags, targetKey) {
  if (!tags || typeof tags !== 'object') return '';
  const lower = targetKey.toLowerCase();
  const entry = Object.entries(tags).find(([k, v]) => k.toLowerCase() === lower && v != null);
  return entry ? String(entry[1]).trim() : '';
}

function parsePositiveNumber(val) {
  const num = Number(val);
  return Number.isFinite(num) && num > 0 ? num : 0;
}

function buildCpuEncoderConfig(preset) {
  return preset === 'hevc'
    ? { mode: 'cpu', videoEncoder: 'libx265', hwDevice: null }
    : { mode: 'cpu', videoEncoder: 'libx264', hwDevice: null };
}

async function safeUnlink(unlinkFn, filePath) {
  if (!filePath || typeof unlinkFn !== 'function') return;
  try {
    await unlinkFn(filePath);
  } catch {
    // Ignore ENOENT / cleanup failures so primary errors stay intact.
  }
}

function spawnCollect(cmd, args, { spawnFn = spawn, timeoutMs, timeoutLabel }) {
  return new Promise((resolve, reject) => {
    const proc = spawnFn(cmd, args);
    proc.stdin?.end?.();
    let stdout = '';
    let stderr = '';
    let settled = false;

    const timer = timeoutMs > 0
      ? setTimeout(() => {
          if (settled) return;
          settled = true;
          try { proc.kill('SIGKILL'); } catch { /* ignore */ }
          reject(new Error(`${timeoutLabel} timed out after ${timeoutMs}ms`));
        }, timeoutMs)
      : null;
    timer?.unref?.();

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(val);
    };

    proc.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    proc.stderr?.on('data', (chunk) => {
      stderr = (stderr + chunk.toString()).slice(-MAX_STDERR_CHARS);
    });
    proc.on('error', (err) => finish(reject, err));
    proc.on('close', (code) => finish(resolve, { code, stdout, stderr }));
  });
}

function normalizeAudioStream(stream) {
  const index = Number(stream.index);
  if (!Number.isInteger(index) || index < 0) return null;
  return {
    index,
    codec: String(stream.codec_name || '').toLowerCase(),
    channels: parsePositiveNumber(stream.channels),
    language: getTag(stream.tags, 'language'),
    title: getTag(stream.tags, 'title'),
  };
}

function normalizeProbeData(data) {
  const streams = Array.isArray(data?.streams) ? data.streams : [];
  const videoStream = streams.find((s) => s?.codec_type === 'video');
  const durationSec = parsePositiveNumber(data?.format?.duration) || parsePositiveNumber(videoStream?.duration);
  const audioStreams = streams
    .filter((s) => s?.codec_type === 'audio')
    .map(normalizeAudioStream)
    .filter(Boolean);

  return {
    durationSec,
    width: parsePositiveNumber(videoStream?.width),
    height: parsePositiveNumber(videoStream?.height),
    videoCodec: String(videoStream?.codec_name || '').toLowerCase(),
    audioStreams,
  };
}

async function probeMedia(filePath, _deps = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new Error('probeMedia requires a valid filePath');
  }
  const ffprobeArgs = [
    '-v', 'error',
    '-show_entries', 'format=duration:stream=index,codec_type,codec_name,width,height,channels:stream_tags=language,title',
    '-of', 'json',
    filePath,
  ];
  const { code, stdout, stderr } = await spawnCollect('ffprobe', ffprobeArgs, {
    spawnFn: _deps.spawn || spawn,
    timeoutMs: _deps.timeoutMs ?? DEFAULT_FFPROBE_TIMEOUT_MS,
    timeoutLabel: 'ffprobe',
  });
  if (code !== 0) {
    throw new Error(`ffprobe failed with code ${code}: ${stderr.trim()}`);
  }
  try {
    return normalizeProbeData(JSON.parse(stdout));
  } catch (err) {
    throw new Error(`Failed to parse ffprobe JSON: ${err.message}`);
  }
}

function selectAudioStream(audioStreams) {
  if (!Array.isArray(audioStreams) || audioStreams.length === 0) return null;

  const byLang = audioStreams.find((s) =>
    GERMAN_LANG_CODES.has(String(s?.language || '').trim().toLowerCase())
  );
  if (byLang && Number.isInteger(byLang.index)) return byLang.index;

  const byTitle = audioStreams.find((s) => GERMAN_TITLE_RE.test(String(s?.title || '')));
  if (byTitle && Number.isInteger(byTitle.index)) return byTitle.index;

  const firstIndex = audioStreams[0]?.index;
  return Number.isInteger(firstIndex) ? firstIndex : null;
}

function extractVainfoRenderer(output) {
  const match = /Driver version:\s*(.+)/i.exec(String(output || ''));
  if (!match) return '';
  let text = match[1].trim();
  const forMatch = /\bfor\s+(.+)/i.exec(text);
  if (forMatch) text = forMatch[1].trim();
  return text.replace(/\s*\([^)]*\)\s*$/, '').trim();
}

async function getVaapiDeviceLabel(devicePath, execFileFn) {
  try {
    const res = await execFileFn('vainfo', ['--display', 'drm', '--device', devicePath], {
      timeout: VAINFO_TIMEOUT_MS,
    });
    const combined = `${res?.stdout || ''}\n${res?.stderr || ''}`;
    const renderer = extractVainfoRenderer(combined);
    return renderer ? `${renderer} (${devicePath})` : devicePath;
  } catch {
    return devicePath;
  }
}

async function listVaapiDevices(_deps = {}) {
  const readdirFn = _deps.readdir || fs.promises.readdir;
  const execFileFn = _deps.execFile || execFileAsync;

  let entries;
  try {
    entries = await readdirFn(DRI_DIR);
  } catch {
    return [];
  }

  const nodes = (entries || [])
    .map((name) => {
      const m = RENDER_NODE_RE.exec(name);
      return m ? { name, num: Number(m[1]) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => a.num - b.num);

  return Promise.all(
    nodes.map(async ({ name }) => {
      const devicePath = `${DRI_DIR}/${name}`;
      const label = await getVaapiDeviceLabel(devicePath, execFileFn);
      return { path: devicePath, label };
    })
  );
}

async function probeVaapiEncoder(devicePath, encoderName, _deps = {}) {
  if (!devicePath || !encoderName) return false;
  const cacheKey = `${devicePath}:${encoderName}`;
  if (probeCache.has(cacheKey)) return probeCache.get(cacheKey);

  // Use 640x360: AMD VCN HEVC rejects frames narrower than 384px.
  const probeArgs = [
    '-hide_banner',
    '-loglevel', 'error',
    '-vaapi_device', devicePath,
    '-f', 'lavfi',
    '-i', 'color=c=black:s=640x360:d=0.04',
    '-vf', 'format=nv12,hwupload',
    '-c:v', encoderName,
    '-rc_mode', 'CQP',
    '-qp', '24',
    '-frames:v', '1',
    '-f', 'null', '-',
  ];

  let ok = false;
  try {
    const res = await spawnCollect('ffmpeg', probeArgs, {
      spawnFn: _deps.spawn || spawn,
      timeoutMs: _deps.timeoutMs ?? VAAPI_PROBE_TIMEOUT_MS,
      timeoutLabel: 'vaapi-probe',
    });
    ok = res.code === 0;
  } catch {
    ok = false;
  }

  probeCache.set(cacheKey, ok);
  return ok;
}

function clearProbeCache() {
  probeCache.clear();
}

async function pickFirstWorkingVaapiDevice(devices, vaapiEncoder, probeFn) {
  for (const dev of devices) {
    const devPath = typeof dev === 'string' ? dev : dev?.path;
    if (devPath && await probeFn(devPath, vaapiEncoder)) {
      return { mode: 'vaapi', videoEncoder: vaapiEncoder, hwDevice: devPath };
    }
  }
  return null;
}

async function resolveEncoderConfig({
  preset,
  hwAccel = 'auto',
  _probeFn = probeVaapiEncoder,
  _listDevicesFn = listVaapiDevices,
}) {
  if (preset === 'original' || preset === 'remux') {
    return { mode: preset, videoEncoder: null, hwDevice: null };
  }
  if (preset !== 'hevc' && preset !== 'h264') {
    throw new Error(`Unsupported transcode preset: ${preset}`);
  }

  const cpuConfig = buildCpuEncoderConfig(preset);
  if (hwAccel === 'cpu') return cpuConfig;

  const vaapiEncoder = preset === 'hevc' ? 'hevc_vaapi' : 'h264_vaapi';
  if (typeof hwAccel === 'string' && hwAccel.startsWith('/dev/dri/')) {
    const ok = await _probeFn(hwAccel, vaapiEncoder);
    return ok ? { mode: 'vaapi', videoEncoder: vaapiEncoder, hwDevice: hwAccel } : cpuConfig;
  }

  const devices = await _listDevicesFn();
  return (await pickFirstWorkingVaapiDevice(devices, vaapiEncoder, _probeFn)) || cpuConfig;
}

function resolveTargetHeight(resolution) {
  if (resolution === '720p') return 720;
  if (resolution === '1080p') return 1080;
  return 0;
}

function appendStreamMappings(args, selectedAudioIndex) {
  args.push('-map', '0:v:0');
  if (selectedAudioIndex !== null) {
    args.push('-map', `0:${selectedAudioIndex}`);
  }
  args.push('-sn', '-dn');
}

function appendMp4ContainerArgs(args, selectedAudioIndex, outputPath) {
  if (selectedAudioIndex !== null) {
    args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  }
  args.push('-movflags', '+faststart', '-f', 'mp4', '-progress', 'pipe:1', '-nostats', '-y', outputPath);
}

function appendVideoEncoderFlags(args, targetPreset, encoderConfig) {
  const isVaapi = encoderConfig.mode === 'vaapi';
  if (targetPreset === 'hevc') {
    if (isVaapi) {
      args.push('-c:v', encoderConfig.videoEncoder || 'hevc_vaapi', '-rc_mode', 'CQP', '-qp', '24', '-tag:v', 'hvc1');
    } else {
      args.push('-c:v', encoderConfig.videoEncoder || 'libx265', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1');
    }
    return;
  }

  if (isVaapi) {
    args.push('-c:v', encoderConfig.videoEncoder || 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '22');
  } else {
    args.push('-c:v', encoderConfig.videoEncoder || 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p');
  }
}

function buildEncodedVideoArgs({ inputPath, outputPath, targetPreset, resolution, probe, encoderConfig }) {
  const args = ['-hide_banner', '-loglevel', 'error'];
  const isVaapi = encoderConfig.mode === 'vaapi';
  if (isVaapi && encoderConfig.hwDevice) {
    args.push('-vaapi_device', encoderConfig.hwDevice);
  }
  args.push('-i', inputPath);

  const selectedAudioIndex = selectAudioStream(probe?.audioStreams);
  appendStreamMappings(args, selectedAudioIndex);

  const targetHeight = resolveTargetHeight(resolution);
  const sourceHeight = parsePositiveNumber(probe?.height);
  const needsScale = targetHeight > 0 && sourceHeight > targetHeight;

  if (isVaapi) {
    const vf = needsScale ? `scale=-2:${targetHeight},format=nv12,hwupload` : 'format=nv12,hwupload';
    args.push('-vf', vf);
  } else if (needsScale) {
    args.push('-vf', `scale=-2:${targetHeight}`);
  }

  appendVideoEncoderFlags(args, targetPreset, encoderConfig);
  appendMp4ContainerArgs(args, selectedAudioIndex, outputPath);
  return args;
}

function buildRemuxCopyArgs({ inputPath, outputPath, probe, sourceCodec }) {
  const args = ['-hide_banner', '-loglevel', 'error', '-i', inputPath];
  const selectedAudioIndex = selectAudioStream(probe?.audioStreams);
  appendStreamMappings(args, selectedAudioIndex);
  args.push('-c:v', 'copy');
  if (sourceCodec === 'hevc' || sourceCodec === 'h265') {
    args.push('-tag:v', 'hvc1');
  }
  appendMp4ContainerArgs(args, selectedAudioIndex, outputPath);
  return args;
}

function buildRemuxTranscodeArgs({ inputPath, outputPath, resolution, probe, fallbackEncoderConfig }) {
  const sourceCodec = String(probe?.videoCodec || '').toLowerCase();
  if (REMUX_COMPATIBLE_CODECS.has(sourceCodec)) {
    return {
      args: buildRemuxCopyArgs({ inputPath, outputPath, probe, sourceCodec }),
      remuxFallbackToH264: false,
    };
  }
  return {
    args: buildEncodedVideoArgs({
      inputPath,
      outputPath,
      targetPreset: 'h264',
      resolution,
      probe,
      encoderConfig: fallbackEncoderConfig || buildCpuEncoderConfig('h264'),
    }),
    remuxFallbackToH264: true,
  };
}

function buildTranscodeArgs({
  inputPath,
  outputPath,
  preset,
  resolution = '1080p',
  probe = {},
  encoderConfig,
  fallbackEncoderConfig,
}) {
  if (preset === 'original') {
    return {
      args: ['-hide_banner', '-loglevel', 'error', '-i', inputPath, '-map', '0', '-c', 'copy', '-progress', 'pipe:1', '-nostats', '-y', outputPath],
      remuxFallbackToH264: false,
    };
  }
  if (preset === 'remux') {
    return buildRemuxTranscodeArgs({ inputPath, outputPath, resolution, probe, fallbackEncoderConfig });
  }
  if (preset !== 'hevc' && preset !== 'h264') {
    throw new Error(`Unsupported transcode preset: ${preset}`);
  }

  return {
    args: buildEncodedVideoArgs({
      inputPath,
      outputPath,
      targetPreset: preset,
      resolution,
      probe,
      encoderConfig: encoderConfig || buildCpuEncoderConfig(preset),
    }),
    remuxFallbackToH264: false,
  };
}

function parseOutTimeSec(current) {
  if (current.out_time_us !== undefined && current.out_time_us !== 'N/A') {
    const us = Number(current.out_time_us);
    if (Number.isFinite(us)) return us >= 0 ? us / 1_000_000 : 0;
  }
  if (typeof current.out_time === 'string') {
    const m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(current.out_time.trim());
    if (m) {
      const sec = Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      if (Number.isFinite(sec)) return sec >= 0 ? sec : 0;
    }
  }
  return null;
}

function parseSpeed(raw) {
  if (raw === undefined || raw === null || raw === 'N/A') return null;
  const val = parseFloat(String(raw).replace(/x$/i, '').trim());
  return Number.isFinite(val) && val >= 0 ? val : null;
}

function parseFfmpegProgressChunk(chunk, parserState = { buffer: '', current: {} }) {
  if (typeof parserState.buffer !== 'string') parserState.buffer = '';
  if (!parserState.current || typeof parserState.current !== 'object') parserState.current = {};

  parserState.buffer += String(chunk || '');
  const lines = parserState.buffer.split(/\r?\n/);
  parserState.buffer = lines.pop() ?? '';

  const updates = [];
  for (const rawLine of lines) {
    const line = rawLine.trim();
    const eqIdx = line.indexOf('=');
    if (!line || eqIdx === -1) continue;

    const key = line.slice(0, eqIdx).trim();
    const val = line.slice(eqIdx + 1).trim();
    parserState.current[key] = val;

    if (key === 'progress') {
      updates.push({
        outTimeSec: parseOutTimeSec(parserState.current),
        speed: parseSpeed(parserState.current.speed),
        progressEnd: val === 'end',
      });
      parserState.current = {};
    }
  }
  return updates;
}

function computeProgressMetrics(update, durationSec) {
  const { outTimeSec, speed } = update;
  let percent = 0;
  if (durationSec > 0 && outTimeSec !== null) {
    percent = Math.min(99.9, Math.max(0, (outTimeSec / durationSec) * 100));
  }

  let etaSec = null;
  if (durationSec > 0 && outTimeSec !== null && speed !== null && speed > 0) {
    const remaining = Math.max(0, durationSec - outTimeSec);
    const rawEta = Math.ceil(remaining / speed);
    etaSec = Number.isFinite(rawEta) ? rawEta : null;
  }
  return { percent, speed, etaSec, outTimeSec };
}

function runFfmpegAttempt({ args, durationSec, signal, onProgress, spawnFn, killTimeoutMs }) {
  if (signal?.aborted) return Promise.reject(createAbortError());

  return new Promise((resolve, reject) => {
    const proc = spawnFn('ffmpeg', args);
    proc.stdin?.end?.();

    const parserState = { buffer: '', current: {} };
    let stderrTail = '';
    let settled = false;
    let aborted = false;
    let killTimer = null;
    let safetyTimer = null;

    const cleanup = () => {
      if (killTimer) clearTimeout(killTimer);
      if (safetyTimer) clearTimeout(safetyTimer);
      signal?.removeEventListener('abort', onAbort);
    };

    const finish = (fn, val) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(val);
    };

    const onAbort = () => {
      if (settled || aborted) return;
      aborted = true;
      try { proc.kill('SIGTERM'); } catch { /* ignore */ }
      if (settled) return;
      killTimer = setTimeout(() => {
        if (settled) return;
        try { proc.kill('SIGKILL'); } catch { /* ignore */ }
      }, killTimeoutMs);
      killTimer.unref?.();
      safetyTimer = setTimeout(() => finish(reject, createAbortError()), killTimeoutMs + 200);
      safetyTimer.unref?.();
    };

    signal?.addEventListener('abort', onAbort, { once: true });

    proc.stdout?.on('data', (chunk) => {
      if (typeof onProgress !== 'function') return;
      for (const update of parseFfmpegProgressChunk(chunk.toString(), parserState)) {
        onProgress(computeProgressMetrics(update, durationSec));
      }
    });

    proc.stderr?.on('data', (chunk) => {
      stderrTail = (stderrTail + chunk.toString()).slice(-MAX_STDERR_CHARS);
    });

    proc.on('error', (err) => {
      finish(reject, aborted || signal?.aborted ? createAbortError() : err);
    });

    proc.on('close', (code) => {
      if (aborted || signal?.aborted) return finish(reject, createAbortError());
      if (code !== 0) {
        const msg = stderrTail.trim();
        return finish(reject, new Error(`ffmpeg exited with code ${code}${msg ? `: ${msg}` : ''}`));
      }
      finish(resolve);
    });
  });
}

async function resolveInitialConfigs({ preset, hwAccel, probe, deps }) {
  const sourceCodec = String(probe?.videoCodec || '').toLowerCase();
  const needsRemuxFallback = preset === 'remux' && !REMUX_COMPATIBLE_CODECS.has(sourceCodec);

  if (needsRemuxFallback) {
    const fallbackEncoderConfig = await deps.resolveEncoderConfig({
      preset: 'h264',
      hwAccel,
      _probeFn: deps.probeVaapiEncoder,
      _listDevicesFn: deps.listVaapiDevices,
    });
    return {
      encoderConfig: { mode: 'remux', videoEncoder: null, hwDevice: null },
      fallbackEncoderConfig,
    };
  }

  const encoderConfig = await deps.resolveEncoderConfig({
    preset,
    hwAccel,
    _probeFn: deps.probeVaapiEncoder,
    _listDevicesFn: deps.listVaapiDevices,
  });
  return { encoderConfig, fallbackEncoderConfig: null };
}

async function runAttemptWithCleanup({ args, durationSec, signal, onProgress, deps, outputPath }) {
  try {
    await runFfmpegAttempt({
      args,
      durationSec,
      signal,
      onProgress,
      spawnFn: deps.spawn,
      killTimeoutMs: deps.killTimeoutMs,
    });
  } catch (err) {
    await safeUnlink(deps.unlink, outputPath);
    if (err?.name === 'AbortError' || signal?.aborted) throw createAbortError();
    throw err;
  }
}

function resolveTranscodeDeps(_deps = {}) {
  return {
    probeMedia,
    listVaapiDevices,
    probeVaapiEncoder,
    resolveEncoderConfig,
    spawn,
    unlink: fs.promises.unlink,
    killTimeoutMs: DEFAULT_KILL_TIMEOUT_MS,
    ..._deps,
  };
}

async function retryTranscodeOnCpu({
  inputPath,
  outputPath,
  preset,
  resolution,
  probe,
  encoderConfig,
  remuxFallbackToH264,
  signal,
  onProgress,
  onStatusNote,
  deps,
}) {
  onStatusNote?.('VAAPI fehlgeschlagen → CPU-Fallback');
  const cpuConfig = buildCpuEncoderConfig(remuxFallbackToH264 ? 'h264' : preset);
  const { args: retryArgs } = buildTranscodeArgs({
    inputPath,
    outputPath,
    preset,
    resolution,
    probe,
    encoderConfig: remuxFallbackToH264 ? encoderConfig : cpuConfig,
    fallbackEncoderConfig: remuxFallbackToH264 ? cpuConfig : null,
  });

  await runAttemptWithCleanup({
    args: retryArgs,
    durationSec: probe.durationSec,
    signal,
    onProgress,
    deps,
    outputPath,
  });
  return { encoderUsed: cpuConfig.videoEncoder, remuxFallbackToH264 };
}

async function transcodeFile({
  inputPath,
  outputPath,
  preset,
  resolution = '1080p',
  hwAccel = 'auto',
  signal,
  onProgress,
  onStatusNote,
  _deps = {},
}) {
  const deps = resolveTranscodeDeps(_deps);
  if (signal?.aborted) throw createAbortError();

  const probe = await deps.probeMedia(inputPath);
  if (signal?.aborted) throw createAbortError();

  const { encoderConfig, fallbackEncoderConfig } = await resolveInitialConfigs({ preset, hwAccel, probe, deps });
  if (signal?.aborted) throw createAbortError();

  const { args, remuxFallbackToH264 } = buildTranscodeArgs({
    inputPath, outputPath, preset, resolution, probe, encoderConfig, fallbackEncoderConfig,
  });
  if (remuxFallbackToH264) onStatusNote?.('Remux nicht möglich → H.264');

  const activeConfig = remuxFallbackToH264 ? fallbackEncoderConfig : encoderConfig;
  const isCopy = preset === 'original' || (preset === 'remux' && !remuxFallbackToH264);
  const encoderUsed = isCopy ? 'copy' : activeConfig.videoEncoder;

  try {
    await runAttemptWithCleanup({ args, durationSec: probe.durationSec, signal, onProgress, deps, outputPath });
    return { encoderUsed, remuxFallbackToH264 };
  } catch (err) {
    if (err?.name === 'AbortError' || hwAccel !== 'auto' || activeConfig?.mode !== 'vaapi') {
      throw err;
    }
    return retryTranscodeOnCpu({
      inputPath, outputPath, preset, resolution, probe, encoderConfig, remuxFallbackToH264,
      signal, onProgress, onStatusNote, deps,
    });
  }
}

module.exports = {
  probeMedia,
  selectAudioStream,
  listVaapiDevices,
  probeVaapiEncoder,
  clearProbeCache,
  resolveEncoderConfig,
  buildTranscodeArgs,
  parseFfmpegProgressChunk,
  transcodeFile,
};
