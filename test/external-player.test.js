const test = require('node:test');
const assert = require('node:assert');
const { buildMpvArgs, setMpvOptions, DEFAULT_MPV_OPTIONS } = require('../lib/external-player.js');

test('external-player: buildMpvArgs generates default buffer args', () => {
  setMpvOptions(DEFAULT_MPV_OPTIONS);
  const args = buildMpvArgs('http://example.com/stream.m3u8');
  assert.ok(args.includes('--cache=yes'));
  assert.ok(args.includes('--demuxer-max-bytes=500M'));
  assert.ok(args.includes('--demuxer-readahead-secs=30'));
  assert.ok(args.includes('--cache-pause-initial=yes'));
  assert.ok(args.includes('--cache-pause-wait=5'));
  assert.ok(args.includes('--force-seekable=yes'));
  assert.strictEqual(args[args.length - 1], 'http://example.com/stream.m3u8');
});

test('external-player: buildMpvArgs respects custom options and overrides', () => {
  const args = buildMpvArgs('http://example.com/stream.m3u8', {
    mpvDemuxerMaxBytes: 1024,
    mpvDemuxerReadaheadSecs: 60,
    mpvCachePauseInitial: 'no',
    mpvCachePauseWait: 0,
    mpvForceSeekable: 'no',
    mpvExtraArgs: '--stream-buffer-size=2M --title="Test Live"'
  });

  assert.ok(args.includes('--demuxer-max-bytes=1024M'));
  assert.ok(args.includes('--demuxer-readahead-secs=60'));
  assert.ok(args.includes('--cache-pause-initial=no'));
  assert.ok(args.includes('--cache-pause-wait=0'));
  assert.ok(!args.includes('--force-seekable=yes'));
  assert.ok(args.includes('--stream-buffer-size=2M'));
  assert.ok(args.includes('--title=Test Live'));
  assert.strictEqual(args[args.length - 1], 'http://example.com/stream.m3u8');
});

test('external-player: setMpvOptions updates defaults for subsequent calls', () => {
  setMpvOptions({
    mpvDemuxerMaxBytes: 250,
    mpvDemuxerReadaheadSecs: 15
  });

  const args = buildMpvArgs('http://example.com/live.ts');
  assert.ok(args.includes('--demuxer-max-bytes=250M'));
  assert.ok(args.includes('--demuxer-readahead-secs=15'));

  // Reset to default
  setMpvOptions(DEFAULT_MPV_OPTIONS);
});
