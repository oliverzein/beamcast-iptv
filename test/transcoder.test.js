const { test } = require('node:test');
const assert = require('node:assert');
const { EventEmitter } = require('node:events');

const {
  probeMedia,
  selectAudioStream,
  listVaapiDevices,
  probeVaapiEncoder,
  clearProbeCache,
  resolveEncoderConfig,
  buildTranscodeArgs,
  parseFfmpegProgressChunk,
  transcodeFile,
} = require('../lib/transcoder.js');

function createFakeProcess({ onSpawn, closeOnSigterm = true, closeOnSigkill = true } = {}) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end() {} };
  proc.killedSignals = [];
  proc.kill = (sig = 'SIGTERM') => {
    proc.killedSignals.push(sig);
    if (sig === 'SIGTERM' && closeOnSigterm) {
      queueMicrotask(() => proc.emit('close', null, 'SIGTERM'));
    } else if (sig === 'SIGKILL' && closeOnSigkill) {
      queueMicrotask(() => proc.emit('close', null, 'SIGKILL'));
    }
    return true;
  };
  if (onSpawn) {
    queueMicrotask(() => onSpawn(proc));
  }
  return proc;
}

function assertSubsequence(args, expectedPair) {
  for (let i = 0; i <= args.length - expectedPair.length; i++) {
    let matches = true;
    for (let j = 0; j < expectedPair.length; j++) {
      if (args[i + j] !== expectedPair[j]) {
        matches = false;
        break;
      }
    }
    if (matches) return;
  }
  assert.fail(`Expected args [${args.join(' ')}] to contain sequence [${expectedPair.join(' ')}]`);
}

test('selectAudioStream: prefers German language codes, then German title, else first stream or null', () => {
  assert.strictEqual(selectAudioStream([]), null);
  assert.strictEqual(selectAudioStream(null), null);

  assert.strictEqual(
    selectAudioStream([
      { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: 'English' },
      { index: 2, codec: 'aac', channels: 2, language: 'ger', title: '' },
    ]),
    2
  );

  assert.strictEqual(
    selectAudioStream([
      { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: 'German Dub' },
      { index: 3, codec: 'eac3', channels: 6, language: ' DEU ', title: '' },
    ]),
    3
  );

  assert.strictEqual(
    selectAudioStream([
      { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: '' },
      { index: 4, codec: 'aac', channels: 2, language: 'de', title: '' },
    ]),
    4
  );

  assert.strictEqual(
    selectAudioStream([
      { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: 'English 5.1' },
      { index: 2, codec: 'aac', channels: 2, language: 'und', title: 'Deutsch Stereo' },
    ]),
    2
  );

  assert.strictEqual(
    selectAudioStream([
      { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: 'English' },
      { index: 5, codec: 'aac', channels: 2, language: 'und', title: 'German AC3' },
    ]),
    5
  );

  assert.strictEqual(
    selectAudioStream([
      { index: 3, codec: 'ac3', channels: 6, language: 'fra', title: 'French' },
      { index: 4, codec: 'aac', channels: 2, language: 'spa', title: 'Spanish' },
    ]),
    3
  );
});

test('buildTranscodeArgs: hevc VAAPI 1080p on 4K source builds expected args and hwupload filter', () => {
  const probe = {
    durationSec: 5400,
    width: 3840,
    height: 2160,
    videoCodec: 'h264',
    audioStreams: [
      { index: 1, codec: 'ac3', channels: 6, language: 'eng', title: 'English' },
      { index: 2, codec: 'eac3', channels: 6, language: 'ger', title: 'Deutsch' },
    ],
  };
  const encoderConfig = {
    mode: 'vaapi',
    videoEncoder: 'hevc_vaapi',
    hwDevice: '/dev/dri/renderD128',
  };

  const { args, remuxFallbackToH264 } = buildTranscodeArgs({
    inputPath: '/tmp/in.raw.part',
    outputPath: '/tmp/out.transcode.part.mp4',
    preset: 'hevc',
    resolution: '1080p',
    probe,
    encoderConfig,
  });

  assert.strictEqual(remuxFallbackToH264, false);
  assertSubsequence(args, ['-vaapi_device', '/dev/dri/renderD128']);
  assert.ok(args.indexOf('-vaapi_device') < args.indexOf('-i'));
  assertSubsequence(args, ['-map', '0:v:0']);
  assertSubsequence(args, ['-map', '0:2']);
  assertSubsequence(args, ['-vf', 'scale=-2:1080,format=nv12,hwupload']);
  assertSubsequence(args, ['-c:v', 'hevc_vaapi']);
  assertSubsequence(args, ['-rc_mode', 'CQP', '-qp', '24']);
  assertSubsequence(args, ['-tag:v', 'hvc1']);
  assertSubsequence(args, ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']);
  assert.ok(args.includes('-sn'));
  assert.ok(args.includes('-dn'));
  assertSubsequence(args, ['-movflags', '+faststart']);
  assertSubsequence(args, ['-f', 'mp4']);
  assertSubsequence(args, ['-progress', 'pipe:1']);
  assert.strictEqual(args[args.length - 1], '/tmp/out.transcode.part.mp4');
});

test('buildTranscodeArgs: never upscales and emits proper CPU hevc/h264 flags', () => {
  const probe720 = {
    durationSec: 1200,
    width: 1280,
    height: 720,
    videoCodec: 'h264',
    audioStreams: [{ index: 1, codec: 'aac', channels: 2, language: 'deu', title: '' }],
  };

  const vaapiNoUpscale = buildTranscodeArgs({
    inputPath: '/tmp/720.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'hevc',
    resolution: '1080p',
    probe: probe720,
    encoderConfig: { mode: 'vaapi', videoEncoder: 'hevc_vaapi', hwDevice: '/dev/dri/renderD128' },
  });
  assertSubsequence(vaapiNoUpscale.args, ['-vf', 'format=nv12,hwupload']);
  assert.ok(!vaapiNoUpscale.args.some((arg) => arg.includes('scale=')));

  const cpuNoUpscale = buildTranscodeArgs({
    inputPath: '/tmp/720.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'hevc',
    resolution: '1080p',
    probe: probe720,
    encoderConfig: { mode: 'cpu', videoEncoder: 'libx265', hwDevice: null },
  });
  assert.ok(!cpuNoUpscale.args.includes('-vf'));
  assertSubsequence(cpuNoUpscale.args, ['-c:v', 'libx265', '-preset', 'medium', '-crf', '24', '-pix_fmt', 'yuv420p', '-tag:v', 'hvc1']);

  const probe1080 = {
    durationSec: 1200,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioStreams: [{ index: 1, codec: 'aac', channels: 2, language: 'eng', title: '' }],
  };

  const cpu720pHevc = buildTranscodeArgs({
    inputPath: '/tmp/1080.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'hevc',
    resolution: '720p',
    probe: probe1080,
    encoderConfig: { mode: 'cpu', videoEncoder: 'libx265', hwDevice: null },
  });
  assertSubsequence(cpu720pHevc.args, ['-vf', 'scale=-2:720']);
  assertSubsequence(cpu720pHevc.args, ['-c:v', 'libx265']);
  assertSubsequence(cpu720pHevc.args, ['-crf', '24']);
  assertSubsequence(cpu720pHevc.args, ['-pix_fmt', 'yuv420p']);

  const cpu720pH264 = buildTranscodeArgs({
    inputPath: '/tmp/1080.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'h264',
    resolution: '720p',
    probe: probe1080,
    encoderConfig: { mode: 'cpu', videoEncoder: 'libx264', hwDevice: null },
  });
  assertSubsequence(cpu720pH264.args, ['-vf', 'scale=-2:720']);
  assertSubsequence(cpu720pH264.args, ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p']);
  assert.ok(!cpu720pH264.args.includes('hvc1'));

  const vaapiOriginalResH264 = buildTranscodeArgs({
    inputPath: '/tmp/1080.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'h264',
    resolution: 'original',
    probe: { ...probe1080, height: 2160 },
    encoderConfig: { mode: 'vaapi', videoEncoder: 'h264_vaapi', hwDevice: '/dev/dri/renderD129' },
  });
  assertSubsequence(vaapiOriginalResH264.args, ['-vf', 'format=nv12,hwupload']);
  assertSubsequence(vaapiOriginalResH264.args, ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '22']);
});

test('buildTranscodeArgs: video-only source omits audio mapping and audio codec flags', () => {
  const probeVideoOnly = {
    durationSec: 600,
    width: 1920,
    height: 1080,
    videoCodec: 'h264',
    audioStreams: [],
  };

  const { args } = buildTranscodeArgs({
    inputPath: '/tmp/silent.mkv',
    outputPath: '/tmp/silent.mp4',
    preset: 'h264',
    resolution: '1080p',
    probe: probeVideoOnly,
    encoderConfig: { mode: 'cpu', videoEncoder: 'libx264', hwDevice: null },
  });

  assertSubsequence(args, ['-map', '0:v:0']);
  assert.ok(!args.some((arg) => arg.startsWith('0:a') || /^0:[1-9]/.test(arg)));
  assert.ok(!args.includes('-c:a'));
  assert.ok(!args.includes('-b:a'));
  assert.ok(!args.includes('-ac'));
  assert.ok(args.includes('-sn'));
  assert.ok(args.includes('-dn'));
});

test('buildTranscodeArgs: remux copies compatible codecs and falls back to h264 on vc1/mpeg2video; original copies 1:1', () => {
  const baseAudio = [{ index: 1, codec: 'ac3', channels: 6, language: 'ger', title: '' }];

  const remuxH264 = buildTranscodeArgs({
    inputPath: '/tmp/in.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'remux',
    probe: { durationSec: 100, width: 1920, height: 1080, videoCodec: 'h264', audioStreams: baseAudio },
    encoderConfig: { mode: 'remux', videoEncoder: null, hwDevice: null },
  });
  assert.strictEqual(remuxH264.remuxFallbackToH264, false);
  assertSubsequence(remuxH264.args, ['-c:v', 'copy']);
  assert.ok(!remuxH264.args.includes('hvc1'));
  assertSubsequence(remuxH264.args, ['-c:a', 'aac', '-b:a', '160k', '-ac', '2']);

  const remuxHevc = buildTranscodeArgs({
    inputPath: '/tmp/in.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'remux',
    probe: { durationSec: 100, width: 1920, height: 1080, videoCodec: 'hevc', audioStreams: baseAudio },
    encoderConfig: { mode: 'remux', videoEncoder: null, hwDevice: null },
  });
  assert.strictEqual(remuxHevc.remuxFallbackToH264, false);
  assertSubsequence(remuxHevc.args, ['-c:v', 'copy']);
  assertSubsequence(remuxHevc.args, ['-tag:v', 'hvc1']);

  const remuxVc1DefaultCpu = buildTranscodeArgs({
    inputPath: '/tmp/in.mkv',
    outputPath: '/tmp/out.mp4',
    preset: 'remux',
    probe: { durationSec: 100, width: 1920, height: 1080, videoCodec: 'vc1', audioStreams: baseAudio },
    encoderConfig: { mode: 'remux', videoEncoder: null, hwDevice: null },
  });
  assert.strictEqual(remuxVc1DefaultCpu.remuxFallbackToH264, true);
  assertSubsequence(remuxVc1DefaultCpu.args, ['-c:v', 'libx264', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p']);

  const remuxMpeg2Vaapi = buildTranscodeArgs({
    inputPath: '/tmp/in.ts',
    outputPath: '/tmp/out.mp4',
    preset: 'remux',
    probe: { durationSec: 100, width: 1920, height: 1080, videoCodec: 'mpeg2video', audioStreams: baseAudio },
    encoderConfig: { mode: 'remux', videoEncoder: null, hwDevice: null },
    fallbackEncoderConfig: { mode: 'vaapi', videoEncoder: 'h264_vaapi', hwDevice: '/dev/dri/renderD128' },
  });
  assert.strictEqual(remuxMpeg2Vaapi.remuxFallbackToH264, true);
  assertSubsequence(remuxMpeg2Vaapi.args, ['-vaapi_device', '/dev/dri/renderD128']);
  assertSubsequence(remuxMpeg2Vaapi.args, ['-c:v', 'h264_vaapi', '-rc_mode', 'CQP', '-qp', '22']);

  const original = buildTranscodeArgs({
    inputPath: '/tmp/in.mkv',
    outputPath: '/tmp/out.mkv',
    preset: 'original',
    probe: { durationSec: 100, width: 1920, height: 1080, videoCodec: 'vc1', audioStreams: baseAudio },
    encoderConfig: { mode: 'original', videoEncoder: null, hwDevice: null },
  });
  assert.strictEqual(original.remuxFallbackToH264, false);
  assertSubsequence(original.args, ['-map', '0', '-c', 'copy']);
  assert.ok(!original.args.includes('-sn'));
  assert.ok(!original.args.includes('mp4'));
});

test('parseFfmpegProgressChunk: parses split multi-line -progress pipe:1 chunks accurately', () => {
  const parserState = { buffer: '', current: {} };

  const chunk1 = 'frame=120\nfps=60.0\nout_time_us=4500';
  assert.deepStrictEqual(parseFfmpegProgressChunk(chunk1, parserState), []);

  const chunk2 = '000\nspeed= 2.50x\nprogress=continue\nout_time_us=12000000\nspeed=N/A\nprogress=end\n';
  const updates = parseFfmpegProgressChunk(chunk2, parserState);

  assert.deepStrictEqual(updates, [
    { outTimeSec: 4.5, speed: 2.5, progressEnd: false },
    { outTimeSec: 12, speed: null, progressEnd: true },
  ]);
  assert.strictEqual(parserState.buffer, '');
  assert.deepStrictEqual(parserState.current, {});
});

test('resolveEncoderConfig & probeVaapiEncoder: caches VAAPI probe results, prefers renderD128 in auto, falls back to cpu', async () => {
  clearProbeCache();
  let spawnCount = 0;
  const fakeSpawn = (_cmd, args) => {
    spawnCount++;
    assert.ok(args.includes('color=c=black:s=640x360:d=0.04'));
    assert.ok(args.includes('-rc_mode'));
    assert.ok(args.includes('CQP'));
    assert.ok(args.includes('-qp'));
    assert.ok(args.includes('24'));
    return createFakeProcess({
      onSpawn: (proc) => proc.emit('close', 0),
    });
  };

  const firstProbe = await probeVaapiEncoder('/dev/dri/renderD128', 'hevc_vaapi', { spawn: fakeSpawn });
  const secondProbe = await probeVaapiEncoder('/dev/dri/renderD128', 'hevc_vaapi', { spawn: fakeSpawn });
  assert.strictEqual(firstProbe, true);
  assert.strictEqual(secondProbe, true);
  assert.strictEqual(spawnCount, 1);

  clearProbeCache();
  await probeVaapiEncoder('/dev/dri/renderD128', 'hevc_vaapi', { spawn: fakeSpawn });
  assert.strictEqual(spawnCount, 2);
  clearProbeCache();

  const probedDevices = [];
  const autoPicked = await resolveEncoderConfig({
    preset: 'hevc',
    hwAccel: 'auto',
    _listDevicesFn: async () => [
      { path: '/dev/dri/renderD128', label: 'AMD Radeon RX' },
      { path: '/dev/dri/renderD129', label: 'Intel iGPU' },
    ],
    _probeFn: async (devicePath, encoderName) => {
      probedDevices.push(`${devicePath}:${encoderName}`);
      return devicePath === '/dev/dri/renderD128';
    },
  });
  assert.deepStrictEqual(autoPicked, {
    mode: 'vaapi',
    videoEncoder: 'hevc_vaapi',
    hwDevice: '/dev/dri/renderD128',
  });
  assert.deepStrictEqual(probedDevices, ['/dev/dri/renderD128:hevc_vaapi']);

  const secondFallback = await resolveEncoderConfig({
    preset: 'h264',
    hwAccel: 'auto',
    _listDevicesFn: async () => [
      { path: '/dev/dri/renderD128', label: 'dGPU' },
      { path: '/dev/dri/renderD129', label: 'iGPU' },
    ],
    _probeFn: async (devicePath) => devicePath === '/dev/dri/renderD129',
  });
  assert.deepStrictEqual(secondFallback, {
    mode: 'vaapi',
    videoEncoder: 'h264_vaapi',
    hwDevice: '/dev/dri/renderD129',
  });

  const cpuFallback = await resolveEncoderConfig({
    preset: 'hevc',
    hwAccel: 'auto',
    _listDevicesFn: async () => [{ path: '/dev/dri/renderD128', label: 'dGPU' }],
    _probeFn: async () => false,
  });
  assert.deepStrictEqual(cpuFallback, {
    mode: 'cpu',
    videoEncoder: 'libx265',
    hwDevice: null,
  });

  const explicitCpu = await resolveEncoderConfig({
    preset: 'h264',
    hwAccel: 'cpu',
    _listDevicesFn: async () => { throw new Error('should not list devices'); },
    _probeFn: async () => { throw new Error('should not probe devices'); },
  });
  assert.deepStrictEqual(explicitCpu, {
    mode: 'cpu',
    videoEncoder: 'libx264',
    hwDevice: null,
  });

  const remuxCfg = await resolveEncoderConfig({ preset: 'remux', hwAccel: 'auto' });
  assert.deepStrictEqual(remuxCfg, { mode: 'remux', videoEncoder: null, hwDevice: null });
});

test('transcodeFile: runtime VAAPI failure in auto mode unlinks partial output, emits status note, retries CPU once', async () => {
  const spawnCalls = [];
  const unlinkedPaths = [];
  const statusNotes = [];
  const progressEvents = [];
  let attempt = 0;

  const result = await transcodeFile({
    inputPath: '/tmp/movie.raw.part',
    outputPath: '/tmp/movie.transcode.part.mp4',
    preset: 'hevc',
    resolution: '1080p',
    hwAccel: 'auto',
    onStatusNote: (note) => statusNotes.push(note),
    onProgress: (p) => progressEvents.push({ ...p }),
    _deps: {
      probeMedia: async () => ({
        durationSec: 100,
        width: 1920,
        height: 1080,
        videoCodec: 'h264',
        audioStreams: [{ index: 1, codec: 'ac3', channels: 6, language: 'ger', title: '' }],
      }),
      resolveEncoderConfig: async () => ({
        mode: 'vaapi',
        videoEncoder: 'hevc_vaapi',
        hwDevice: '/dev/dri/renderD128',
      }),
      unlink: async (target) => {
        unlinkedPaths.push(target);
      },
      spawn: (cmd, args) => {
        attempt++;
        spawnCalls.push({ cmd, args });
        if (attempt === 1) {
          return createFakeProcess({
            onSpawn: (proc) => {
              proc.stderr.emit('data', Buffer.from('vaapi encode init failed\n'));
              proc.emit('close', 1);
            },
          });
        }
        return createFakeProcess({
          onSpawn: (proc) => {
            proc.stdout.emit('data', Buffer.from('out_time_us=50000000\nspeed=2.0x\nprogress=continue\n'));
            proc.stdout.emit('data', Buffer.from('out_time_us=100000000\nspeed=2.0x\nprogress=end\n'));
            proc.emit('close', 0);
          },
        });
      },
    },
  });

  assert.deepStrictEqual(result, {
    encoderUsed: 'libx265',
    remuxFallbackToH264: false,
  });
  assert.strictEqual(spawnCalls.length, 2);
  assert.ok(spawnCalls[0].args.includes('hevc_vaapi'));
  assert.ok(spawnCalls[1].args.includes('libx265'));
  assert.deepStrictEqual(unlinkedPaths, ['/tmp/movie.transcode.part.mp4']);
  assert.deepStrictEqual(statusNotes, ['VAAPI fehlgeschlagen → CPU-Fallback']);
  assert.strictEqual(progressEvents.length, 2);
  assert.strictEqual(progressEvents[0].percent, 50);
  assert.strictEqual(progressEvents[0].speed, 2);
  assert.strictEqual(progressEvents[0].etaSec, 25);
  assert.strictEqual(progressEvents[0].outTimeSec, 50);
  assert.strictEqual(progressEvents[1].percent, 99.9);
  assert.strictEqual(progressEvents[1].etaSec, 0);
});

test('transcodeFile: aborts cleanly on AbortController with SIGTERM, unlinks partial output, and escalates to SIGKILL when hung', async () => {
  const controller1 = new AbortController();
  let spawnedProc1;
  const unlinked1 = [];

  const p1 = transcodeFile({
    inputPath: '/tmp/a.raw.part',
    outputPath: '/tmp/a.transcode.part.mp4',
    preset: 'h264',
    hwAccel: 'cpu',
    signal: controller1.signal,
    _deps: {
      probeMedia: async () => ({
        durationSec: 100,
        width: 1280,
        height: 720,
        videoCodec: 'h264',
        audioStreams: [],
      }),
      unlink: async (target) => { unlinked1.push(target); },
      spawn: () => {
        spawnedProc1 = createFakeProcess({ closeOnSigterm: true });
        return spawnedProc1;
      },
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  controller1.abort();

  await assert.rejects(p1, (err) => err && err.name === 'AbortError');
  assert.deepStrictEqual(spawnedProc1.killedSignals, ['SIGTERM']);
  assert.deepStrictEqual(unlinked1, ['/tmp/a.transcode.part.mp4']);

  const controller2 = new AbortController();
  let spawnedProc2;
  const unlinked2 = [];

  const p2 = transcodeFile({
    inputPath: '/tmp/b.raw.part',
    outputPath: '/tmp/b.transcode.part.mp4',
    preset: 'h264',
    hwAccel: 'cpu',
    signal: controller2.signal,
    _deps: {
      killTimeoutMs: 30,
      probeMedia: async () => ({
        durationSec: 100,
        width: 1280,
        height: 720,
        videoCodec: 'h264',
        audioStreams: [],
      }),
      unlink: async (target) => { unlinked2.push(target); },
      spawn: () => {
        spawnedProc2 = createFakeProcess({ closeOnSigterm: false, closeOnSigkill: true });
        return spawnedProc2;
      },
    },
  });

  await new Promise((r) => setTimeout(r, 10));
  controller2.abort();

  await assert.rejects(p2, (err) => err && err.name === 'AbortError');
  assert.deepStrictEqual(spawnedProc2.killedSignals, ['SIGTERM', 'SIGKILL']);
  assert.deepStrictEqual(unlinked2, ['/tmp/b.transcode.part.mp4']);
});

test('probeMedia & listVaapiDevices: parses ffprobe JSON and sorts/labels renderD devices', async () => {
  const probed = await probeMedia('/tmp/sample.mkv', {
    spawn: () => createFakeProcess({
      onSpawn: (proc) => {
        proc.stdout.emit('data', Buffer.from(JSON.stringify({
          format: { duration: '3600.5' },
          streams: [
            { index: 0, codec_type: 'video', codec_name: 'HEVC', width: 1920, height: 1080 },
            { index: 1, codec_type: 'audio', codec_name: 'eac3', channels: 6, tags: { language: 'ger', title: 'Deutsch 5.1' } },
          ],
        })));
        proc.emit('close', 0);
      },
    }),
  });

  assert.deepStrictEqual(probed, {
    durationSec: 3600.5,
    width: 1920,
    height: 1080,
    videoCodec: 'hevc',
    audioStreams: [
      { index: 1, codec: 'eac3', channels: 6, language: 'ger', title: 'Deutsch 5.1' },
    ],
  });

  const devices = await listVaapiDevices({
    readdir: async () => ['card0', 'renderD129', 'renderD128', 'controlD64'],
    execFile: async (_cmd, args) => {
      const dev = args[args.length - 1];
      if (dev === '/dev/dri/renderD128') {
        return { stdout: 'vainfo: Driver version: Mesa Gallium driver 26.3.1 for AMD Radeon RX 9070 XT (radeonsi)\n', stderr: '' };
      }
      if (dev === '/dev/dri/renderD129') {
        return { stdout: 'vainfo: Driver version: Intel iHD driver for Intel(R) Gen Graphics - 24.3.4 ()\n', stderr: '' };
      }
      throw new Error('vainfo failed');
    },
  });

  assert.deepStrictEqual(devices, [
    { path: '/dev/dri/renderD128', label: 'AMD Radeon RX 9070 XT (/dev/dri/renderD128)' },
    { path: '/dev/dri/renderD129', label: 'Intel(R) Gen Graphics - 24.3.4 (/dev/dri/renderD129)' },
  ]);

  const missingDri = await listVaapiDevices({
    readdir: async () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }); },
  });
  assert.deepStrictEqual(missingDri, []);
});

test('transcodeFile: remux incompatible codec resolves h264 VAAPI and supports runtime CPU fallback', async () => {
  const resolveCalls = [];
  const spawnCalls = [];
  const notes = [];
  const unlinked = [];
  let attempt = 0;

  const res = await transcodeFile({
    inputPath: '/tmp/old.ts',
    outputPath: '/tmp/old.transcode.part.mp4',
    preset: 'remux',
    hwAccel: 'auto',
    onStatusNote: (note) => notes.push(note),
    _deps: {
      probeMedia: async () => ({
        durationSec: 60,
        width: 1920,
        height: 1080,
        videoCodec: 'vc1',
        audioStreams: [],
      }),
      resolveEncoderConfig: async (opts) => {
        resolveCalls.push(opts.preset);
        return { mode: 'vaapi', videoEncoder: 'h264_vaapi', hwDevice: '/dev/dri/renderD128' };
      },
      unlink: async (p) => unlinked.push(p),
      spawn: (_cmd, args) => {
        attempt++;
        spawnCalls.push(args);
        return createFakeProcess({
          onSpawn: (proc) => proc.emit('close', attempt === 1 ? 1 : 0),
        });
      },
    },
  });

  assert.deepStrictEqual(resolveCalls, ['h264']);
  assert.deepStrictEqual(res, { encoderUsed: 'libx264', remuxFallbackToH264: true });
  assert.ok(spawnCalls[0].includes('h264_vaapi'));
  assert.ok(spawnCalls[1].includes('libx264'));
  assert.deepStrictEqual(notes, ['Remux nicht möglich → H.264', 'VAAPI fehlgeschlagen → CPU-Fallback']);
  assert.deepStrictEqual(unlinked, ['/tmp/old.transcode.part.mp4']);
});

test('transcodeFile: explicit device failure does not fallback to CPU; double failure unlinks twice; pre-aborted signal rejects early', async () => {
  const unlinkedExplicit = [];
  let explicitSpawns = 0;

  await assert.rejects(
    transcodeFile({
      inputPath: '/tmp/in.mkv',
      outputPath: '/tmp/out.mp4',
      preset: 'hevc',
      hwAccel: '/dev/dri/renderD128',
      _deps: {
        probeMedia: async () => ({ durationSec: 10, width: 1920, height: 1080, videoCodec: 'h264', audioStreams: [] }),
        resolveEncoderConfig: async () => ({ mode: 'vaapi', videoEncoder: 'hevc_vaapi', hwDevice: '/dev/dri/renderD128' }),
        unlink: async (p) => unlinkedExplicit.push(p),
        spawn: () => {
          explicitSpawns++;
          return createFakeProcess({ onSpawn: (proc) => proc.emit('close', 1) });
        },
      },
    }),
    /ffmpeg exited with code 1/
  );
  assert.strictEqual(explicitSpawns, 1);
  assert.deepStrictEqual(unlinkedExplicit, ['/tmp/out.mp4']);

  const unlinkedBoth = [];
  let autoSpawns = 0;
  await assert.rejects(
    transcodeFile({
      inputPath: '/tmp/in.mkv',
      outputPath: '/tmp/out2.mp4',
      preset: 'hevc',
      hwAccel: 'auto',
      _deps: {
        probeMedia: async () => ({ durationSec: 10, width: 1920, height: 1080, videoCodec: 'h264', audioStreams: [] }),
        resolveEncoderConfig: async () => ({ mode: 'vaapi', videoEncoder: 'hevc_vaapi', hwDevice: '/dev/dri/renderD128' }),
        unlink: async (p) => unlinkedBoth.push(p),
        spawn: () => {
          autoSpawns++;
          return createFakeProcess({
            onSpawn: (proc) => {
              proc.stderr.emit('data', Buffer.from(`fail attempt ${autoSpawns}`));
              proc.emit('close', 2);
            },
          });
        },
      },
    }),
    /fail attempt 2/
  );
  assert.strictEqual(autoSpawns, 2);
  assert.deepStrictEqual(unlinkedBoth, ['/tmp/out2.mp4', '/tmp/out2.mp4']);

  const ac = new AbortController();
  ac.abort();
  let probeCalled = false;
  await assert.rejects(
    transcodeFile({
      inputPath: '/tmp/in.mkv',
      outputPath: '/tmp/out3.mp4',
      preset: 'h264',
      signal: ac.signal,
      _deps: {
        probeMedia: async () => { probeCalled = true; return {}; },
      },
    }),
    (err) => err && err.name === 'AbortError'
  );
  assert.strictEqual(probeCalled, false);
});

