const { test } = require('node:test');
const assert = require('node:assert');
const { xmltvTimeToEpoch } = require('../epg-parse.js');

test('xmltvTimeToEpoch: UTC offset', () => {
  // 2026-06-14 18:00:00 UTC
  assert.strictEqual(xmltvTimeToEpoch('20260614180000 +0000'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: positive offset converts to UTC', () => {
  // 20:00 at +0200 == 18:00 UTC
  assert.strictEqual(xmltvTimeToEpoch('20260614200000 +0200'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: negative offset converts to UTC', () => {
  // 13:00 at -0500 == 18:00 UTC
  assert.strictEqual(xmltvTimeToEpoch('20260614130000 -0500'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: missing offset assumes UTC', () => {
  assert.strictEqual(xmltvTimeToEpoch('20260614180000'), Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('xmltvTimeToEpoch: garbage returns NaN', () => {
  assert.ok(Number.isNaN(xmltvTimeToEpoch('not-a-date')));
  assert.ok(Number.isNaN(xmltvTimeToEpoch('')));
  assert.ok(Number.isNaN(xmltvTimeToEpoch(undefined)));
});
