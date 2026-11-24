const test = require('node:test');
const assert = require('node:assert');
const { buildMpvArgs, setMpvOptions, extractMpvErrorMessage, DEFAULT_MPV_OPTIONS } = require('../lib/external-player.js');

test('external-player: buildMpvArgs generates default buffer args without overriding mpv.conf cache', () => {
  setMpvOptions(DEFAULT_MPV_OPTIONS);
  const args = buildMpvArgs('http://example.com/stream.m3u8');
  assert.ok(!args.includes('--cache=yes'));
  assert.ok(!args.some(a => a.startsWith('--demuxer-max-bytes')));
  assert.ok(!args.some(a => a.startsWith('--demuxer-readahead-secs')));
  assert.ok(args.includes('--cache-pause-initial=yes'));
  assert.ok(args.includes('--cache-pause-wait=5'));
  assert.ok(args.includes('--force-seekable=yes'));
  assert.strictEqual(args[args.length - 1], 'http://example.com/stream.m3u8');
});

test('external-player: buildMpvArgs respects custom options and overrides', () => {
  const args = buildMpvArgs('http://example.com/stream.m3u8', {
    mpvCachePauseInitial: 'no',
    mpvCachePauseWait: 0,
    mpvForceSeekable: 'no',
    mpvExtraArgs: '--stream-buffer-size=2M --title="Test Live"'
  });

  assert.ok(args.includes('--cache-pause-initial=no'));
  assert.ok(args.includes('--cache-pause-wait=0'));
  assert.ok(!args.includes('--force-seekable=yes'));
  assert.ok(args.includes('--stream-buffer-size=2M'));
  assert.ok(args.includes('--title=Test Live'));
  assert.strictEqual(args[args.length - 1], 'http://example.com/stream.m3u8');
});

test('external-player: setMpvOptions updates defaults for subsequent calls', () => {
  setMpvOptions({
    mpvCachePauseWait: 15,
    mpvForceSeekable: 'no'
  });

  const args = buildMpvArgs('http://example.com/live.ts');
  assert.ok(args.includes('--cache-pause-wait=15'));
  assert.ok(!args.includes('--force-seekable=yes'));

  // Reset to default
  setMpvOptions(DEFAULT_MPV_OPTIONS);
});

test('external-player: extractMpvErrorMessage parses relevant error lines and filters ytdl noise', () => {
  const sampleLines = [
    '[curl] HTTP error 503',
    '[curl] transfer failed: Failed writing received data to disk/application',
    'Failed to open http://s-tv.cx:8080/timeshift/test/394043.ts.',
    '[ytdl_hook] Subprocess failed: init',
    '[ytdl_hook] Subprocess failed: init',
    '[ytdl_hook] youtube-dl failed: not found or not enough permissions',
    'Exiting... (Errors when loading file)'
  ];

  const msg = extractMpvErrorMessage(sampleLines);
  assert.ok(msg.includes('[curl] HTTP error 503'));
  assert.ok(msg.includes('Failed to open'));
  assert.ok(!msg.includes('ytdl_hook'));
  assert.ok(!msg.includes('youtube-dl failed'));

  // Fallback on empty / unknown
  assert.strictEqual(extractMpvErrorMessage([]), 'MPV beendet mit Fehler (keine Details verfügbar).');
  assert.strictEqual(extractMpvErrorMessage(null), 'MPV beendet mit Fehler (keine Details verfügbar).');
});
