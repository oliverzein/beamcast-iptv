const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sanitizeName,
  resolveTargetPath,
  resolveDuplicatePath,
  createDownloadManager,
} = require('../lib/download-manager.js');

function createDeferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function createAbortError(message = 'Aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beamcast-dm-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test('sanitizeName: keeps German umlauts, strips illegal chars, neutralizes .. traversal', () => {
  assert.strictEqual(sanitizeName('Das Boot: Größe & Spaß (1981)'), 'Das Boot Größe & Spaß (1981)');
  assert.strictEqual(sanitizeName('äöüÄÖÜß - Der Film?*|<>'), 'äöüÄÖÜß - Der Film');
  assert.strictEqual(sanitizeName('../../etc/passwd'), 'etc passwd');
  assert.strictEqual(sanitizeName('foo/../bar\\baz..qux'), 'foo bar baz qux');
  assert.strictEqual(sanitizeName('..'), 'video');
  assert.strictEqual(sanitizeName('...'), 'video');
  assert.strictEqual(sanitizeName('   .   '), 'video');
  assert.strictEqual(sanitizeName(''), 'video');
  assert.strictEqual(sanitizeName('Dr. House'), 'Dr. House');
});

test('resolveTargetPath: resolves structured and flat movie/series paths and omits redundant episode titles', () => {
  const baseDir = '/downloads/BeamcastIPTV';

  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'structured',
      mediaType: 'movie',
      title: 'Der König: Größe?',
      sourceExt: 'mkv',
      preset: 'hevc',
    }),
    path.join(baseDir, 'Movies', 'Der König Größe.mp4')
  );

  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'structured',
      mediaType: 'movie',
      title: 'Alien',
      sourceExt: '.mkv',
      preset: 'original',
    }),
    path.join(baseDir, 'Movies', 'Alien.mkv')
  );

  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'structured',
      mediaType: 'episode',
      seriesName: 'Dark',
      seasonNum: 1,
      episodeNum: 2,
      episodeTitle: 'Lügen',
      sourceExt: 'mkv',
      preset: 'h264',
    }),
    path.join(baseDir, 'Series', 'Dark', 'Season 01', 'Dark - S01E02 - Lügen.mp4')
  );

  // Prefix check must not strip real words starting with seriesName (e.g. Dark -> Darkness Falls)
  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'structured',
      mediaType: 'episode',
      seriesName: 'Dark',
      seasonNum: 1,
      episodeNum: 3,
      episodeTitle: 'Darkness Falls',
      sourceExt: 'mkv',
      preset: 'hevc',
    }),
    path.join(baseDir, 'Series', 'Dark', 'Season 01', 'Dark - S01E03 - Darkness Falls.mp4')
  );

  // Redundant Episode N and seriesName prefix omitted
  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'structured',
      mediaType: 'episode',
      seriesName: 'Meine Serie',
      seasonNum: 1,
      episodeNum: 2,
      episodeTitle: 'Episode 2',
      sourceExt: 'mkv',
      preset: 'hevc',
    }),
    path.join(baseDir, 'Series', 'Meine Serie', 'Season 01', 'Meine Serie - S01E02.mp4')
  );

  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'structured',
      mediaType: 'episode',
      seriesName: 'Meine Serie',
      seasonNum: 1,
      episodeNum: 2,
      episodeTitle: 'Meine Serie - S01E02',
      sourceExt: 'mkv',
      preset: 'hevc',
    }),
    path.join(baseDir, 'Series', 'Meine Serie', 'Season 01', 'Meine Serie - S01E02.mp4')
  );

  // Flat mode writes directly into baseDir
  assert.strictEqual(
    resolveTargetPath({
      baseDir,
      structure: 'flat',
      mediaType: 'episode',
      seriesName: 'Dark',
      seasonNum: 2,
      episodeNum: 4,
      episodeTitle: 'Die Reisenden',
      sourceExt: 'ts',
      preset: 'original',
    }),
    path.join(baseDir, 'Dark - S02E04 - Die Reisenden.ts')
  );
});

test('resolveDuplicatePath: handles skip, overwrite, and incremental rename', () => {
  const target = '/tmp/Movies/Test Film.mp4';
  assert.deepStrictEqual(resolveDuplicatePath(target, 'skip'), {
    action: 'skip',
    finalPath: target,
  });
  assert.deepStrictEqual(resolveDuplicatePath(target, 'overwrite'), {
    action: 'overwrite',
    finalPath: target,
  });

  const existing = new Set([
    '/tmp/Movies/Test Film.mp4',
    '/tmp/Movies/Test Film (1).mp4',
  ]);
  assert.deepStrictEqual(
    resolveDuplicatePath(target, 'rename', (p) => existing.has(p)),
    {
      action: 'rename',
      finalPath: '/tmp/Movies/Test Film (2).mp4',
    }
  );
  assert.deepStrictEqual(
    resolveDuplicatePath('/tmp/Movies/Fresh.mp4', 'rename', (p) => existing.has(p)),
    {
      action: 'rename',
      finalPath: '/tmp/Movies/Fresh.mp4',
    }
  );
});

test('checkConflicts: detects disk, batch, and inflight collisions', async () => {
  await withTempDir(async (tmpDir) => {
    const moviesDir = path.join(tmpDir, 'Movies');
    await fs.promises.mkdir(moviesDir, { recursive: true });
    const diskFile = path.join(moviesDir, 'Existing Movie.mkv');
    await fs.promises.writeFile(diskFile, Buffer.alloc(2048));

    const dl1 = createDeferred();
    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      downloadFile: ({ signal }) => {
        signal.addEventListener('abort', () => dl1.reject(createAbortError()), { once: true });
        return dl1.promise;
      },
      transcodeFile: async () => ({ encoderUsed: 'copy', remuxFallbackToH264: false }),
      statfs: async () => ({ bavail: 1000000, bsize: 4096 }),
    });

    await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:100',
          mediaType: 'movie',
          title: 'Active Movie',
          url: 'http://provider.test/movie/u/p/100.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, structure: 'structured', preset: 'original' }
    );

    const check = await manager.checkConflicts(
      [
        {
          itemKey: 'movie:1',
          mediaType: 'movie',
          title: 'Existing Movie',
          url: 'http://provider.test/movie/u/p/1.mkv',
          sourceExt: 'mkv',
        },
        {
          itemKey: 'movie:2',
          mediaType: 'movie',
          title: 'Batch: Film',
          url: 'http://provider.test/movie/u/p/2.mkv',
          sourceExt: 'mkv',
        },
        {
          itemKey: 'movie:3',
          mediaType: 'movie',
          title: 'Batch? Film',
          url: 'http://provider.test/movie/u/p/3.mkv',
          sourceExt: 'mkv',
        },
        {
          itemKey: 'movie:101',
          mediaType: 'movie',
          title: 'Active Movie',
          url: 'http://provider.test/movie/u/p/101.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, structure: 'structured', preset: 'original' }
    );

    assert.strictEqual(check.resolvedTargets.length, 4);
    assert.strictEqual(check.conflicts.length, 3);

    const byIndex = new Map(check.conflicts.map((c) => [c.index, c]));
    assert.strictEqual(byIndex.get(0).reason, 'disk');
    assert.strictEqual(byIndex.get(0).existingPath, diskFile);
    assert.strictEqual(byIndex.get(0).existingSizeBytes, 2048);

    assert.strictEqual(byIndex.get(2).reason, 'batch');
    assert.strictEqual(byIndex.get(2).existingPath, path.join(moviesDir, 'Batch Film.mkv'));

    assert.strictEqual(byIndex.get(3).reason, 'inflight');
    assert.strictEqual(byIndex.get(3).existingPath, path.join(moviesDir, 'Active Movie.mkv'));

    await manager.shutdown();
  });
});

test('enqueueDownloads: deduplicates active itemKeys and strips url completely from snapshots', async () => {
  await withTempDir(async (tmpDir) => {
    const dl = createDeferred();
    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      downloadFile: ({ signal }) => {
        signal.addEventListener('abort', () => dl.reject(createAbortError()), { once: true });
        return dl.promise;
      },
      transcodeFile: async () => ({ encoderUsed: 'hevc_vaapi', remuxFallbackToH264: false }),
      statfs: async () => ({ bavail: 1000000, bsize: 4096 }),
    });

    const item = {
      itemKey: 'movie:77',
      mediaType: 'movie',
      title: 'Secret Movie',
      url: 'http://xtream.test/movie/secretUser/secretPass/77.mkv',
      sourceExt: 'mkv',
    };

    const res1 = await manager.enqueueDownloads([item, { ...item }], {
      baseDir: tmpDir,
      preset: 'hevc',
    });
    assert.strictEqual(res1.added, 1);
    assert.strictEqual(res1.skippedDuplicateItem, 1);
    assert.strictEqual(res1.jobs.length, 1);
    assert.strictEqual('url' in res1.jobs[0], false);

    const res2 = await manager.enqueueDownloads([item], { baseDir: tmpDir, preset: 'hevc' });
    assert.strictEqual(res2.added, 0);
    assert.strictEqual(res2.skippedDuplicateItem, 1);

    const snap = manager.getStateSnapshot();
    assert.strictEqual(snap.jobs.length, 1);
    assert.strictEqual('url' in snap.jobs[0], false);
    const json = JSON.stringify(snap);
    assert.strictEqual(json.includes('secretUser'), false);
    assert.strictEqual(json.includes('secretPass'), false);

    await manager.shutdown();
  });
});

test('pipeline concurrency & backpressure: max 1 download, overlaps download N+1 with transcode N, pauses at queued_transcode=1', async () => {
  await withTempDir(async (tmpDir) => {
    const downloadCalls = [];
    const transcodeCalls = [];
    let activeDownloads = 0;
    let maxConcurrentDownloads = 0;
    let activeTranscodes = 0;
    let maxConcurrentTranscodes = 0;

    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => ({ bavail: 2000000, bsize: 4096 }),
      downloadFile: ({ partPath }) => {
        const d = createDeferred();
        activeDownloads += 1;
        maxConcurrentDownloads = Math.max(maxConcurrentDownloads, activeDownloads);
        downloadCalls.push({ partPath, d });
        return fs.promises.writeFile(partPath, 'raw').then(() =>
          d.promise.finally(() => { activeDownloads -= 1; })
        );
      },
      transcodeFile: ({ inputPath, outputPath }) => {
        const d = createDeferred();
        activeTranscodes += 1;
        maxConcurrentTranscodes = Math.max(maxConcurrentTranscodes, activeTranscodes);
        transcodeCalls.push({ inputPath, outputPath, d });
        return fs.promises.writeFile(outputPath, 'mp4').then(() =>
          d.promise.finally(() => { activeTranscodes -= 1; })
        );
      },
    });

    const items = [1, 2, 3].map((n) => ({
      itemKey: `episode:${n}`,
      mediaType: 'episode',
      seriesName: 'Show',
      seasonNum: 1,
      episodeNum: n,
      episodeTitle: `Ep ${n}`,
      url: `http://xtream.test/series/u/p/${n}.mkv`,
      sourceExt: 'mkv',
    }));

    await manager.enqueueDownloads(items, { baseDir: tmpDir, preset: 'hevc', structure: 'structured' });
    await new Promise((r) => setTimeout(r, 20));

    // Only item 1 is downloading
    assert.strictEqual(downloadCalls.length, 1);
    assert.strictEqual(transcodeCalls.length, 0);

    // Finish item 1 download -> item 1 transcodes AND item 2 starts downloading
    downloadCalls[0].d.resolve({ bytesWritten: 3, totalBytes: 3 });
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(transcodeCalls.length, 1);
    assert.strictEqual(downloadCalls.length, 2);
    let snap = manager.getStateSnapshot();
    assert.strictEqual(snap.jobs[0].status, 'transcoding');
    assert.strictEqual(snap.jobs[1].status, 'downloading');
    assert.strictEqual(snap.jobs[2].status, 'queued');

    // Finish item 2 download while item 1 is still transcoding -> item 2 enters queued_transcode, item 3 stays queued (backpressure cap = 1)
    downloadCalls[1].d.resolve({ bytesWritten: 3, totalBytes: 3 });
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(downloadCalls.length, 2);
    assert.strictEqual(transcodeCalls.length, 1);
    snap = manager.getStateSnapshot();
    assert.strictEqual(snap.jobs[0].status, 'transcoding');
    assert.strictEqual(snap.jobs[1].status, 'queued_transcode');
    assert.strictEqual(snap.jobs[2].status, 'queued');
    assert.strictEqual(snap.summary.queuedTranscode, 1);
    assert.strictEqual(snap.summary.queued, 1);

    // Finish item 1 transcode -> item 2 begins transcoding AND item 3 begins downloading
    transcodeCalls[0].d.resolve({ encoderUsed: 'hevc_vaapi', remuxFallbackToH264: false });
    await new Promise((r) => setTimeout(r, 20));

    assert.strictEqual(transcodeCalls.length, 2);
    assert.strictEqual(downloadCalls.length, 3);
    snap = manager.getStateSnapshot();
    assert.strictEqual(snap.jobs[0].status, 'completed');
    assert.strictEqual(snap.jobs[1].status, 'transcoding');
    assert.strictEqual(snap.jobs[2].status, 'downloading');

    // Finish remaining stages
    downloadCalls[2].d.resolve({ bytesWritten: 3, totalBytes: 3 });
    transcodeCalls[1].d.resolve({ encoderUsed: 'hevc_vaapi', remuxFallbackToH264: false });
    await new Promise((r) => setTimeout(r, 20));
    assert.strictEqual(transcodeCalls.length, 3);
    transcodeCalls[2].d.resolve({ encoderUsed: 'hevc_vaapi', remuxFallbackToH264: false });
    await new Promise((r) => setTimeout(r, 20));

    snap = manager.getStateSnapshot();
    assert.strictEqual(snap.summary.completed, 3);
    assert.strictEqual(manager.hasActiveJobs(), false);
    assert.strictEqual(maxConcurrentDownloads, 1);
    assert.strictEqual(maxConcurrentTranscodes, 1);
  });
});

test('pre-flight disk space check (< 500 MB before Stage 2): fails cleanly in German, retains .raw.part, sets errorStage transcode', async () => {
  await withTempDir(async (tmpDir) => {
    let statfsCall = 0;
    let capturedRawPath = null;
    let transcodeCalled = false;

    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => {
        statfsCall += 1;
        // 1st call (Stage 1 pre-flight): plenty of space (2 GB)
        // 2nd call (Stage 2 pre-flight): < 500 MB (100 MB)
        return statfsCall === 1
          ? { bavail: 524288, bsize: 4096 }
          : { bavail: 25600, bsize: 4096 };
      },
      downloadFile: async ({ partPath }) => {
        capturedRawPath = partPath;
        await fs.promises.writeFile(partPath, 'raw-data');
        return { bytesWritten: 8, totalBytes: 8 };
      },
      transcodeFile: async () => {
        transcodeCalled = true;
        return { encoderUsed: 'hevc_vaapi', remuxFallbackToH264: false };
      },
    });

    await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:50',
          mediaType: 'movie',
          title: 'Disk Full Movie',
          url: 'http://xtream.test/movie/u/p/50.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'hevc' }
    );

    await new Promise((r) => setTimeout(r, 30));

    const snap = manager.getStateSnapshot();
    assert.strictEqual(transcodeCalled, false);
    assert.strictEqual(snap.jobs[0].status, 'error');
    assert.strictEqual(snap.jobs[0].errorStage, 'transcode');
    assert.match(snap.jobs[0].error, /Speicherplatz|500\s*MB/i);
    assert.strictEqual(fs.existsSync(capturedRawPath), true);

    await manager.shutdown();
    assert.strictEqual(fs.existsSync(capturedRawPath), false);
  });
});

test('Stage-2 failure retention & retry: unlinks .transcode.part.mp4, retains .raw.part, retryJob skips Stage 1, removeJob/shutdown unlinks .raw.part', async () => {
  await withTempDir(async (tmpDir) => {
    let downloadCount = 0;
    let transcodeCount = 0;
    let rawPartPath = null;
    let transcodePartPath = null;

    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => ({ bavail: 2000000, bsize: 4096 }),
      downloadFile: async ({ partPath }) => {
        downloadCount += 1;
        rawPartPath = partPath;
        await fs.promises.writeFile(partPath, 'raw-video');
        return { bytesWritten: 9, totalBytes: 9 };
      },
      transcodeFile: async ({ outputPath }) => {
        transcodeCount += 1;
        transcodePartPath = outputPath;
        await fs.promises.writeFile(outputPath, 'partial-mp4');
        if (transcodeCount === 1) {
          throw new Error('FFmpeg boom');
        }
        return { encoderUsed: 'libx265', remuxFallbackToH264: false };
      },
    });

    const { jobs } = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:88',
          mediaType: 'movie',
          title: 'Retry Movie',
          url: 'http://xtream.test/movie/u/p/88.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'hevc' }
    );
    const jobId = jobs[0].id;
    await new Promise((r) => setTimeout(r, 30));

    let snap = manager.getStateSnapshot();
    assert.strictEqual(snap.jobs[0].status, 'error');
    assert.strictEqual(snap.jobs[0].errorStage, 'transcode');
    assert.strictEqual(downloadCount, 1);
    assert.strictEqual(transcodeCount, 1);
    assert.strictEqual(fs.existsSync(rawPartPath), true);
    assert.strictEqual(fs.existsSync(transcodePartPath), false);

    // Retry re-runs Stage 2 without re-downloading
    const retried = await manager.retryJob(jobId);
    assert.strictEqual(retried, true);
    await new Promise((r) => setTimeout(r, 30));

    snap = manager.getStateSnapshot();
    assert.strictEqual(downloadCount, 1);
    assert.strictEqual(transcodeCount, 2);
    assert.strictEqual(snap.jobs[0].status, 'completed');
    assert.strictEqual(snap.jobs[0].encoderUsed, 'libx265');
    assert.strictEqual(fs.existsSync(snap.jobs[0].finalPath), true);
    assert.strictEqual(fs.existsSync(rawPartPath), false);

    // Also verify removeJob unlinks retained .raw.part on a failed Stage-2 job
    transcodeCount = 0;
    const { jobs: jobs2 } = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:89',
          mediaType: 'movie',
          title: 'Remove Retained Raw',
          url: 'http://xtream.test/movie/u/p/89.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'hevc' }
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(fs.existsSync(rawPartPath), true);
    await manager.removeJob(jobs2[0].id);
    assert.strictEqual(fs.existsSync(rawPartPath), false);
    assert.strictEqual(manager.getStateSnapshot().jobs.length, 1);
  });
});

test('Stage-1 error and active cancel unlink .raw.part and .transcode.part.mp4 cleanly', async () => {
  await withTempDir(async (tmpDir) => {
    let rawPath1 = null;
    let rawPath2 = null;
    let transcodePath2 = null;
    const transcodeDeferred = createDeferred();

    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => ({ bavail: 2000000, bsize: 4096 }),
      downloadFile: async ({ url, partPath }) => {
        if (url.includes('/fail')) {
          rawPath1 = partPath;
          await fs.promises.writeFile(partPath, 'broken');
          throw new Error(`HTTP 500 for ${url}`);
        }
        rawPath2 = partPath;
        await fs.promises.writeFile(partPath, 'ok-raw');
        return { bytesWritten: 6, totalBytes: 6 };
      },
      transcodeFile: async ({ outputPath, signal }) => {
        transcodePath2 = outputPath;
        await fs.promises.writeFile(outputPath, 'partial-transcode');
        signal.addEventListener('abort', () => transcodeDeferred.reject(createAbortError()), { once: true });
        return transcodeDeferred.promise;
      },
    });

    const { jobs: failJobs } = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:fail',
          mediaType: 'movie',
          title: 'Fail Stage 1',
          url: 'http://xtream.test/movie/secretUser/secretPass/fail.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'hevc' }
    );
    await new Promise((r) => setTimeout(r, 30));

    let snap = manager.getStateSnapshot();
    const failJob = snap.jobs.find((j) => j.id === failJobs[0].id);
    assert.strictEqual(failJob.status, 'error');
    assert.strictEqual(failJob.errorStage, 'download');
    assert.strictEqual(failJob.error.includes('secretPass'), false);
    assert.strictEqual(fs.existsSync(rawPath1), false);

    // Enqueue second job, let it enter Stage 2 transcoding, then cancel
    const { jobs: cancelJobs } = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:cancel',
          mediaType: 'movie',
          title: 'Cancel Stage 2',
          url: 'http://xtream.test/movie/u/p/ok.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'hevc' }
    );
    await new Promise((r) => setTimeout(r, 30));

    assert.strictEqual(fs.existsSync(rawPath2), true);
    assert.strictEqual(fs.existsSync(transcodePath2), true);

    await manager.cancelJob(cancelJobs[0].id);
    snap = manager.getStateSnapshot();
    const cancelledJob = snap.jobs.find((j) => j.id === cancelJobs[0].id);
    assert.strictEqual(cancelledJob.status, 'cancelled');
    assert.strictEqual(fs.existsSync(rawPath2), false);
    assert.strictEqual(fs.existsSync(transcodePath2), false);
  });
});

test('original preset finalizes without transcoding, clearCompleted removes finished jobs, and init registers Electron IPC handlers', async () => {
  await withTempDir(async (tmpDir) => {
    let transcodeCalled = false;
    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => ({ bavail: 2000000, bsize: 4096 }),
      downloadFile: async ({ partPath, onProgress }) => {
        onProgress?.({ bytesWritten: 5, totalBytes: 10, speedBps: 500, etaSec: 1 });
        await fs.promises.writeFile(partPath, '0123456789');
        return { bytesWritten: 10, totalBytes: 10 };
      },
      transcodeFile: async () => {
        transcodeCalled = true;
        return { encoderUsed: 'copy', remuxFallbackToH264: false };
      },
    });

    await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:orig',
          mediaType: 'movie',
          title: 'Original Film',
          url: 'http://xtream.test/movie/u/p/orig.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'original' }
    );
    await new Promise((r) => setTimeout(r, 30));

    let snap = manager.getStateSnapshot();
    assert.strictEqual(transcodeCalled, false);
    assert.strictEqual(snap.jobs[0].status, 'completed');
    assert.strictEqual(snap.jobs[0].encoderUsed, 'original');
    assert.strictEqual(snap.jobs[0].finalSizeBytes, 10);
    assert.strictEqual(fs.existsSync(snap.jobs[0].finalPath), true);

    manager.clearCompleted();
    snap = manager.getStateSnapshot();
    assert.strictEqual(snap.jobs.length, 0);
  });

  // Verify Electron IPC handler registration & { items, options } destructuring via mocked electron module
  const electronPath = require.resolve('electron');
  const dmPath = require.resolve('../lib/download-manager.js');
  const prevElectronEntry = require.cache[electronPath];
  const prevDmEntry = require.cache[dmPath];
  const registeredHandlers = new Map();

  require.cache[electronPath] = {
    id: electronPath,
    filename: electronPath,
    loaded: true,
    exports: {
      dialog: { showOpenDialog: async () => ({ canceled: false, filePaths: ['/tmp/chosen'] }) },
      ipcMain: {
        handle: (channel, fn) => registeredHandlers.set(channel, fn),
        removeHandler: (channel) => registeredHandlers.delete(channel),
      },
      shell: {
        showItemInFolder: () => {},
        openPath: async () => '',
      },
    },
  };
  delete require.cache[dmPath];

  try {
    const dm = require('../lib/download-manager.js');
    assert.strictEqual(dm.hasActiveJobs(), false);
    await dm.shutdown();

    const fakeApp = { getPath: () => '/home/tester/Downloads' };
    dm.init(() => null, fakeApp);

    const expectedChannels = [
      'download:get-default-dir',
      'download:select-dir',
      'download:list-vaapi-devices',
      'download:check-conflicts',
      'download:enqueue',
      'download:get-state',
      'download:cancel',
      'download:cancel-all',
      'download:retry',
      'download:remove',
      'download:clear-completed',
      'download:open-folder',
    ];
    for (const ch of expectedChannels) {
      assert.strictEqual(registeredHandlers.has(ch), true, `Missing IPC handler: ${ch}`);
    }

    assert.strictEqual(
      await registeredHandlers.get('download:get-default-dir')({}),
      path.join('/home/tester/Downloads', 'BeamcastIPTV')
    );
    assert.strictEqual(
      await registeredHandlers.get('download:select-dir')({}, '/tmp'),
      '/tmp/chosen'
    );
    const conflictRes = await registeredHandlers.get('download:check-conflicts')(
      {},
      { items: [], options: {} }
    );
    assert.deepStrictEqual(conflictRes, { conflicts: [], resolvedTargets: [] });

    await dm.shutdown();
  } finally {
    if (prevElectronEntry) require.cache[electronPath] = prevElectronEntry;
    else delete require.cache[electronPath];
    if (prevDmEntry) require.cache[dmPath] = prevDmEntry;
    else delete require.cache[dmPath];
  }
});

test('enqueueDownloads rename/skip conflict resolution, Stage-1 disk check, cancelAll, and throttled emissions', async () => {
  await withTempDir(async (tmpDir) => {
    const emissions = [];
    const dlDeferred = createDeferred();
    let mode = 'stall';

    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      throttleMs: 250,
      onStateChange: (snap) => emissions.push(snap),
      statfs: async () => ({ bavail: 200000, bsize: 4096 }), // ~800 MB free
      downloadFile: async ({ partPath, signal, onProgress }) => {
        if (mode === 'oversize') {
          signal.addEventListener('abort', () => {}, { once: true });
          onProgress({ bytesWritten: 100, totalBytes: 2 * 1024 * 1024 * 1024, speedBps: 100, etaSec: 10 });
          await new Promise((r) => setTimeout(r, 20));
          return { bytesWritten: 100, totalBytes: 2 * 1024 * 1024 * 1024 };
        }
        onProgress({ bytesWritten: 1, totalBytes: 10, speedBps: 10, etaSec: 1 });
        onProgress({ bytesWritten: 2, totalBytes: 10, speedBps: 10, etaSec: 1 });
        onProgress({ bytesWritten: 3, totalBytes: 10, speedBps: 10, etaSec: 1 });
        await fs.promises.writeFile(partPath, 'part');
        signal.addEventListener('abort', () => dlDeferred.reject(createAbortError()), { once: true });
        return dlDeferred.promise;
      },
    });

    // Oversized Stage-1 totalBytes triggers German disk error
    mode = 'oversize';
    await manager.enqueueDownloads(
      [{ itemKey: 'm:over', mediaType: 'movie', title: 'Huge', url: 'http://x.test/movie/u/p/1.mkv', sourceExt: 'mkv' }],
      { baseDir: tmpDir, preset: 'original' }
    );
    await new Promise((r) => setTimeout(r, 40));
    assert.strictEqual(manager.getStateSnapshot().jobs[0].status, 'error');
    assert.strictEqual(manager.getStateSnapshot().jobs[0].errorStage, 'download');
    assert.match(manager.getStateSnapshot().jobs[0].error, /Speicherplatz/);

    // Intra-batch rename + skip + cancelAll + throttled progress emissions
    mode = 'stall';
    emissions.length = 0;
    const batchRes = await manager.enqueueDownloads(
      [
        { itemKey: 'm:1', mediaType: 'movie', title: 'Same:Name', url: 'http://x.test/1.mkv', sourceExt: 'mkv' },
        { itemKey: 'm:2', mediaType: 'movie', title: 'Same?Name', url: 'http://x.test/2.mkv', sourceExt: 'mkv' },
      ],
      { baseDir: tmpDir, preset: 'original', duplicateAction: 'rename' }
    );
    assert.strictEqual(batchRes.added, 2);
    assert.strictEqual(path.basename(batchRes.jobs[0].finalPath), 'Same Name.mkv');
    assert.strictEqual(path.basename(batchRes.jobs[1].finalPath), 'Same Name (1).mkv');

    const skipRes = await manager.enqueueDownloads(
      [{ itemKey: 'm:3', mediaType: 'movie', title: 'Same Name', url: 'http://x.test/3.mkv', sourceExt: 'mkv' }],
      { baseDir: tmpDir, preset: 'original', duplicateAction: 'skip' }
    );
    assert.strictEqual(skipRes.added, 0);
    assert.strictEqual(skipRes.skippedExisting, 1);

    await new Promise((r) => setTimeout(r, 20));
    // Rapid progress ticks were throttled (1 immediate enqueue emission + at most 1 throttled progress timer)
    assert.ok(emissions.length <= 2, `Expected throttled emissions <= 2, got ${emissions.length}`);

    await manager.cancelAll();
    assert.strictEqual(manager.hasActiveJobs(), false);
    const statuses = manager.getStateSnapshot().jobs.slice(1).map((j) => j.status);
    assert.deepStrictEqual(statuses, ['cancelled', 'cancelled']);
  });
});

test('retryJob: concurrent double-retry Promise.all runs only once', async () => {
  await withTempDir(async (tmpDir) => {
    let transcodeCount = 0;
    const retryTranscodeDeferred = createDeferred();

    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => ({ bavail: 2000000, bsize: 4096 }),
      unlink: async (filePath) => {
        await new Promise((r) => setTimeout(r, 15));
        try {
          await fs.promises.unlink(filePath);
        } catch {
          // ignore ENOENT
        }
      },
      downloadFile: async ({ partPath }) => {
        await fs.promises.writeFile(partPath, 'raw');
        return { bytesWritten: 3, totalBytes: 3 };
      },
      transcodeFile: async ({ outputPath }) => {
        transcodeCount += 1;
        await fs.promises.writeFile(outputPath, 'mp4');
        if (transcodeCount === 1) throw new Error('Initial transcode failure');
        return retryTranscodeDeferred.promise;
      },
    });

    const { jobs } = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:race',
          mediaType: 'movie',
          title: 'Race Test',
          url: 'http://x.test/movie/u/p/race.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, preset: 'hevc' }
    );
    const jobId = jobs[0].id;
    await new Promise((r) => setTimeout(r, 60));

    assert.strictEqual(manager.getStateSnapshot().jobs[0].status, 'error');
    assert.strictEqual(transcodeCount, 1);

    const results = await Promise.all([manager.retryJob(jobId), manager.retryJob(jobId)]);
    await new Promise((r) => setTimeout(r, 30));

    assert.deepStrictEqual(results, [true, false]);
    assert.strictEqual(transcodeCount, 2);

    retryTranscodeDeferred.resolve({ encoderUsed: 'libx265', remuxFallbackToH264: false });
    await new Promise((r) => setTimeout(r, 40));

    assert.strictEqual(manager.getStateSnapshot().jobs[0].status, 'completed');
    assert.strictEqual(transcodeCount, 2);
  });
});

test('duplicateAction overwrite overwrites disk files but never shares finalPath across inflight or same-batch jobs', async () => {
  await withTempDir(async (tmpDir) => {
    const moviesDir = path.join(tmpDir, 'Movies');
    await fs.promises.mkdir(moviesDir, { recursive: true });
    const existingDiskPath = path.join(moviesDir, 'Existing.mkv');
    await fs.promises.writeFile(existingDiskPath, 'old-bytes');

    const stallDeferreds = [];
    const manager = createDownloadManager({
      defaultBaseDir: tmpDir,
      statfs: async () => ({ bavail: 2000000, bsize: 4096 }),
      downloadFile: ({ partPath, signal }) => {
        const d = createDeferred();
        stallDeferreds.push(d);
        signal.addEventListener('abort', () => d.reject(createAbortError()), { once: true });
        return fs.promises.writeFile(partPath, 'new-bytes').then(() => d.promise);
      },
    });

    // Disk collision with overwrite keeps exact target path
    const first = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:disk-ow',
          mediaType: 'movie',
          title: 'Existing',
          url: 'http://x.test/1.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, structure: 'structured', preset: 'original', duplicateAction: 'overwrite' }
    );
    assert.strictEqual(first.added, 1);
    assert.strictEqual(first.jobs[0].finalPath, existingDiskPath);

    // Active inflight collision with overwrite must NOT reuse active finalPath
    const second = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:inflight-ow',
          mediaType: 'movie',
          title: 'Existing',
          url: 'http://x.test/2.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, structure: 'structured', preset: 'original', duplicateAction: 'overwrite' }
    );
    if (second.added === 1) {
      assert.notStrictEqual(second.jobs[0].finalPath, existingDiskPath);
    }

    // Same-batch collision with overwrite must produce distinct finalPaths for active jobs
    const batch = await manager.enqueueDownloads(
      [
        {
          itemKey: 'movie:b1',
          mediaType: 'movie',
          title: 'Batch:One',
          url: 'http://x.test/3.mkv',
          sourceExt: 'mkv',
        },
        {
          itemKey: 'movie:b2',
          mediaType: 'movie',
          title: 'Batch?One',
          url: 'http://x.test/4.mkv',
          sourceExt: 'mkv',
        },
      ],
      { baseDir: tmpDir, structure: 'structured', preset: 'original', duplicateAction: 'overwrite' }
    );
    const activePaths = manager.getStateSnapshot().jobs.map((j) => j.finalPath);
    assert.strictEqual(new Set(activePaths).size, activePaths.length);
    assert.ok(batch.added >= 1);

    await manager.shutdown();
  });
});


