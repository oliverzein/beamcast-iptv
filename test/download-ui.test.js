const { test } = require('node:test');
const assert = require('node:assert');

const { createDownloadController, buildPathPreview } = require('../renderer-downloads.js');

function createStubSettings(overrides = {}) {
  const store = {
    downloadDir: '',
    downloadFolderStructure: 'structured',
    downloadDefaultPreset: 'hevc',
    downloadDefaultResolution: '1080p',
    downloadClickAction: 'dialog',
    downloadDuplicateAction: 'ask',
    downloadHwAccel: 'auto',
    ...overrides,
  };
  const setCalls = [];
  return {
    store,
    setCalls,
    get(key, def) {
      return store[key] !== undefined ? store[key] : def;
    },
    async set(key, val) {
      store[key] = val;
      setCalls.push([key, val]);
    },
  };
}

function createStubElectronAPI({ conflicts = [], enqueueResult = { added: 1, jobs: [{ id: 'job_1' }] } } = {}) {
  const calls = {
    checkDownloadConflicts: [],
    enqueueDownloads: [],
  };
  return {
    calls,
    async checkDownloadConflicts(items, options) {
      calls.checkDownloadConflicts.push({ items, options });
      return { conflicts, resolvedTargets: [] };
    },
    async enqueueDownloads(items, options) {
      calls.enqueueDownloads.push({ items, options });
      return typeof enqueueResult === 'function' ? enqueueResult(items, options) : enqueueResult;
    },
  };
}

const sampleMovie = {
  itemKey: 'movie:101',
  mediaType: 'movie',
  title: 'Dune: Part Two (2024)',
  url: 'http://provider.local:8080/movie/secretUser/secretPass/101.mkv',
  sourceExt: 'mkv',
  downloadable: true,
};

test('default click (downloadClickAction=dialog): opens Options modal instead of immediate enqueue; submits and persists rememberDefaults', async () => {
  const AppSettings = createStubSettings({ downloadClickAction: 'dialog', downloadDuplicateAction: 'ask' });
  const electronAPI = createStubElectronAPI({ conflicts: [] });
  const optionsCalls = [];
  const conflictCalls = [];
  const enqueuedBatches = [];

  let resolveOptions;
  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: (payload) => {
      optionsCalls.push(payload);
      return new Promise((res) => { resolveOptions = res; });
    },
    openConflictModal: async (payload) => {
      conflictCalls.push(payload);
      return 'skip';
    },
    onBatchEnqueued: (res) => enqueuedBatches.push(res),
  });

  const pending = controller.triggerDownload([sampleMovie], { source: 'button' });

  // Before modal resolves, neither conflict check nor enqueue should have run.
  assert.strictEqual(optionsCalls.length, 1);
  assert.strictEqual(optionsCalls[0].items.length, 1);
  assert.strictEqual(optionsCalls[0].defaultOptions.preset, 'hevc');
  assert.strictEqual(optionsCalls[0].defaultOptions.resolution, '1080p');
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 0);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 0);

  resolveOptions({
    options: {
      baseDir: '/tmp/custom-vod',
      structure: 'structured',
      preset: 'h264',
      resolution: '720p',
      hwAccel: 'auto',
      duplicateAction: 'ask',
    },
    rememberDefaults: true,
  });

  const result = await pending;
  assert.strictEqual(result.added, 1);
  assert.strictEqual(conflictCalls.length, 0);
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads[0].options.preset, 'h264');
  assert.strictEqual(electronAPI.calls.enqueueDownloads[0].options.resolution, '720p');
  assert.strictEqual(electronAPI.calls.enqueueDownloads[0].options.baseDir, '/tmp/custom-vod');
  assert.deepStrictEqual(AppSettings.setCalls, [
    ['downloadDefaultPreset', 'h264'],
    ['downloadDefaultResolution', '720p'],
  ]);
  assert.strictEqual(enqueuedBatches.length, 1);
});

test('cancelling Options modal does not check conflicts or enqueue downloads', async () => {
  const AppSettings = createStubSettings({ downloadClickAction: 'dialog' });
  const electronAPI = createStubElectronAPI();
  const enqueuedBatches = [];

  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: async () => null,
    openConflictModal: async () => 'rename',
    onBatchEnqueued: (res) => enqueuedBatches.push(res),
  });

  const result = await controller.triggerDownload([sampleMovie], { source: 'button' });
  assert.strictEqual(result.cancelled, true);
  assert.strictEqual(result.added, 0);
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 0);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 0);
  assert.strictEqual(enqueuedBatches.length, 0);
});

test('instant click with 1 conflict and duplicateAction=ask opens Conflict modal before enqueueing', async () => {
  const AppSettings = createStubSettings({
    downloadClickAction: 'instant',
    downloadDuplicateAction: 'ask',
  });
  const conflict = {
    index: 0,
    itemKey: 'movie:101',
    title: 'Dune: Part Two (2024)',
    existingPath: '/downloads/Movies/Dune Part Two (2024).mp4',
    existingSizeBytes: 123456,
    reason: 'disk',
  };
  const electronAPI = createStubElectronAPI({ conflicts: [conflict] });
  const optionsCalls = [];
  const conflictCalls = [];
  const enqueuedBatches = [];

  let resolveConflict;
  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: async (p) => {
      optionsCalls.push(p);
      return null;
    },
    openConflictModal: (payload) => {
      conflictCalls.push(payload);
      return new Promise((res) => { resolveConflict = res; });
    },
    onBatchEnqueued: (res) => enqueuedBatches.push(res),
  });

  const pending = controller.triggerDownload([sampleMovie], { source: 'button' });

  // Wait a microtask for async checkDownloadConflicts to complete.
  await new Promise((r) => setImmediate(r));

  assert.strictEqual(optionsCalls.length, 0);
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 1);
  assert.strictEqual(conflictCalls.length, 1);
  assert.strictEqual(conflictCalls[0].conflicts.length, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 0);

  resolveConflict('rename');
  const result = await pending;

  assert.strictEqual(result.added, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads[0].options.duplicateAction, 'rename');
  assert.strictEqual(enqueuedBatches.length, 1);
});

test('context-menu default mode checks conflicts even when clickAction=dialog; cancelling conflict aborts enqueue', async () => {
  const AppSettings = createStubSettings({
    downloadClickAction: 'dialog',
    downloadDuplicateAction: 'ask',
  });
  const electronAPI = createStubElectronAPI({
    conflicts: [{ index: 0, itemKey: 'movie:101', title: 'Dune', existingPath: '/x.mp4', existingSizeBytes: 10, reason: 'disk' }],
  });
  const optionsCalls = [];
  const conflictCalls = [];

  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: async (p) => { optionsCalls.push(p); return null; },
    openConflictModal: async (p) => { conflictCalls.push(p); return 'cancel'; },
  });

  const result = await controller.triggerDownload([sampleMovie], { source: 'context-default' });
  assert.strictEqual(optionsCalls.length, 0);
  assert.strictEqual(conflictCalls.length, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 0);
  assert.strictEqual(result.cancelled, true);
});

test('instant click with zero conflicts calls enqueueDownloads directly without opening modals', async () => {
  const AppSettings = createStubSettings({
    downloadClickAction: 'instant',
    downloadDuplicateAction: 'ask',
  });
  const electronAPI = createStubElectronAPI({ conflicts: [] });
  const optionsCalls = [];
  const conflictCalls = [];
  const enqueuedBatches = [];

  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: async (p) => { optionsCalls.push(p); return null; },
    openConflictModal: async (p) => { conflictCalls.push(p); return 'skip'; },
    onBatchEnqueued: (res) => enqueuedBatches.push(res),
  });

  const result = await controller.triggerDownload([sampleMovie], { source: 'button' });
  assert.strictEqual(result.added, 1);
  assert.strictEqual(optionsCalls.length, 0);
  assert.strictEqual(conflictCalls.length, 0);
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 1);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 1);
  assert.strictEqual(enqueuedBatches.length, 1);
});

test('context-options or forceDialog opens Options modal even when downloadClickAction=instant', async () => {
  const AppSettings = createStubSettings({ downloadClickAction: 'instant' });
  const electronAPI = createStubElectronAPI({ conflicts: [] });
  const optionsCalls = [];

  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: async (p) => {
      optionsCalls.push(p);
      return { options: p.defaultOptions, rememberDefaults: false };
    },
    openConflictModal: async () => 'skip',
  });

  await controller.triggerDownload([sampleMovie], { source: 'context-options', forceDialog: true });
  assert.strictEqual(optionsCalls.length, 1);
  assert.strictEqual(AppSettings.setCalls.length, 0);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 1);
});

test('getJobForItemKey prioritizes active jobs over older finished ones', () => {
  const AppSettings = createStubSettings();
  const electronAPI = createStubElectronAPI();
  const controller = createDownloadController({ AppSettings, electronAPI });

  controller.updateSnapshot({
    jobs: [
      { id: 'j1', itemKey: 'episode:10', status: 'completed', progress: 100 },
      { id: 'j2', itemKey: 'episode:10', status: 'downloading', progress: 42 },
      { id: 'j3', itemKey: 'episode:20', status: 'transcoding', progress: 70 },
      { id: 'j4', itemKey: 'episode:20', status: 'error', progress: 0 },
      { id: 'j5', itemKey: 'episode:30', status: 'error', progress: 0 },
      { id: 'j6', itemKey: 'episode:30', status: 'completed', progress: 100 },
    ],
    summary: { downloading: 1, transcoding: 1, queued: 0, queuedTranscode: 0, completed: 2, error: 2, activeTotal: 2 },
  });

  assert.strictEqual(controller.getJobForItemKey('episode:10')?.id, 'j2');
  assert.strictEqual(controller.getJobForItemKey('episode:20')?.id, 'j3');
  assert.strictEqual(controller.getJobForItemKey('episode:30')?.id, 'j6');
  assert.strictEqual(controller.getJobForItemKey('episode:999'), null);
  assert.strictEqual(controller.getSnapshot().jobs.length, 6);
});

test('buildPathPreview mirrors structured and flat paths without exposing URLs', () => {
  const moviePreview = buildPathPreview({
    items: [sampleMovie],
    baseDir: '/home/user/Downloads/BeamcastIPTV',
    structure: 'structured',
    preset: 'hevc',
  });
  assert.strictEqual(moviePreview, '/home/user/Downloads/BeamcastIPTV/Movies/Dune Part Two (2024).mp4');

  const epPreview = buildPathPreview({
    items: [
      {
        mediaType: 'episode',
        seriesName: 'Breaking Bad',
        seasonNum: 1,
        episodeNum: 1,
        episodeTitle: 'Breaking Bad S01E01 Pilot',
        sourceExt: 'mkv',
      },
      {
        mediaType: 'episode',
        seriesName: 'Breaking Bad',
        seasonNum: 1,
        episodeNum: 2,
        episodeTitle: 'Cat',
        sourceExt: 'mkv',
      },
    ],
    baseDir: '/downloads',
    structure: 'structured',
    preset: 'original',
  });
  assert.strictEqual(epPreview, '/downloads/Series/Breaking Bad/Season 01/Breaking Bad - S01E01.mkv (+1 weitere)');
});

test('triggerDownload & runEnqueueWithConflictCheck reject relative downloadDir cleanly without IPC calls', async () => {
  const AppSettings = createStubSettings({
    downloadClickAction: 'dialog',
    downloadDir: '',
  });
  const electronAPI = createStubElectronAPI({ conflicts: [] });
  const controller = createDownloadController({
    AppSettings,
    electronAPI,
    openOptionsModal: async (p) => ({
      options: { ...p.defaultOptions, baseDir: 'relative/movies', preset: 'h264' },
      rememberDefaults: true,
    }),
  });

  await assert.rejects(
    () => controller.triggerDownload([sampleMovie], { source: 'button' }),
    /absoluter Pfad/
  );
  assert.strictEqual(AppSettings.setCalls.length, 0);
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 0);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 0);

  await assert.rejects(
    () => controller.runEnqueueWithConflictCheck([sampleMovie], { baseDir: '../../etc' }),
    /absoluter Pfad/
  );
  assert.strictEqual(electronAPI.calls.checkDownloadConflicts.length, 0);
  assert.strictEqual(electronAPI.calls.enqueueDownloads.length, 0);
});
