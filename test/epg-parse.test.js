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

const { parseXmltv } = require('../epg-parse.js');

const SAMPLE = `<?xml version="1.0" encoding="UTF-8"?>
<tv>
  <channel id="bbc.one"><display-name>BBC One</display-name></channel>
  <programme start="20260614170000 +0000" stop="20260614180000 +0000" channel="bbc.one">
    <title lang="en">Late Show</title>
    <desc lang="en">A &amp; B</desc>
    <category lang="en">Talk</category>
  </programme>
  <programme start="20260614160000 +0000" stop="20260614170000 +0000" channel="bbc.one">
    <title>Early Show</title>
  </programme>
  <programme start="20260614180000 +0000" stop="20260614190000 +0000" channel="cnn.int">
    <title>World News</title>
    <desc>Headlines</desc>
  </programme>
</tv>`;

test('parseXmltv: groups by channel and sorts by start', () => {
  const map = parseXmltv(SAMPLE);
  assert.deepStrictEqual(Object.keys(map).sort(), ['bbc.one', 'cnn.int']);
  assert.strictEqual(map['bbc.one'].length, 2);
  // sorted ascending: Early (16:00) before Late (17:00)
  assert.strictEqual(map['bbc.one'][0].title, 'Early Show');
  assert.strictEqual(map['bbc.one'][1].title, 'Late Show');
});

test('parseXmltv: decodes entities and fields', () => {
  const p = parseXmltv(SAMPLE)['bbc.one'][1];
  assert.strictEqual(p.title, 'Late Show');
  assert.strictEqual(p.desc, 'A & B');
  assert.strictEqual(p.category, 'Talk');
  assert.strictEqual(p.start, Date.UTC(2026, 5, 14, 17, 0, 0) / 1000);
  assert.strictEqual(p.stop, Date.UTC(2026, 5, 14, 18, 0, 0) / 1000);
});

test('parseXmltv: missing desc/category default to empty string', () => {
  const p = parseXmltv(SAMPLE)['bbc.one'][0];
  assert.strictEqual(p.desc, '');
  assert.strictEqual(p.category, '');
});

test('parseXmltv: empty/garbage input returns {}', () => {
  assert.deepStrictEqual(parseXmltv(''), {});
  assert.deepStrictEqual(parseXmltv('not xml'), {});
  assert.deepStrictEqual(parseXmltv(null), {});
});
