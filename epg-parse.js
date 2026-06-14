/**
 * epg-parse.js — dependency-free XMLTV parser.
 * Runs in Node (tests) and in the browser worker/renderer.
 * Regex-based on purpose: DOMParser is unavailable in plain Node.
 */
(function (root) {
  'use strict';

  // "YYYYMMDDHHMMSS +ZZZZ" -> epoch seconds (UTC). Returns NaN if unparseable.
  function xmltvTimeToEpoch(str) {
    if (typeof str !== 'string') return NaN;
    const m = str.trim().match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\s*([+-])(\d{2})(\d{2}))?$/);
    if (!m) return NaN;
    const [, y, mo, d, h, mi, s, sign, oh, om] = m;
    const utcMs = Date.UTC(+y, +mo - 1, +d, +h, +mi, +s);
    let offsetSec = 0;
    if (sign) {
      offsetSec = (sign === '-' ? -1 : 1) * (parseInt(oh, 10) * 3600 + parseInt(om, 10) * 60);
    }
    return Math.floor(utcMs / 1000) - offsetSec;
  }

  const api = { xmltvTimeToEpoch };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.parseXmltv = root.parseXmltv || null; // defined in Task 2
    root.xmltvTimeToEpoch = xmltvTimeToEpoch;
  }
})(typeof self !== 'undefined' ? self : this);
