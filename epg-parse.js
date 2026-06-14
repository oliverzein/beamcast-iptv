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

  function decodeEntities(str) {
    if (!str) return '';
    return str
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&apos;/g, "'")
      .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)))
      .replace(/&#x([0-9a-fA-F]+);/g, (_, n) => String.fromCharCode(parseInt(n, 16)))
      .replace(/&amp;/g, '&')
      .trim();
  }

  function tagText(block, tag) {
    const m = block.match(new RegExp('<' + tag + '\\b[^>]*>([\\s\\S]*?)<\\/' + tag + '>', 'i'));
    return m ? decodeEntities(m[1]) : '';
  }

  function attr(attrs, name) {
    const m = attrs.match(new RegExp(name + '\\s*=\\s*"([^"]*)"', 'i'));
    return m ? m[1] : '';
  }

  function parseXmltv(xml) {
    const out = {};
    if (typeof xml !== 'string' || xml.indexOf('<programme') === -1) return out;
    const re = /<programme\b([^>]*)>([\s\S]*?)<\/programme>/gi;
    let m;
    while ((m = re.exec(xml)) !== null) {
      const attrs = m[1];
      const body = m[2];
      const channel = attr(attrs, 'channel');
      if (!channel) continue;
      const start = xmltvTimeToEpoch(attr(attrs, 'start'));
      const stop = xmltvTimeToEpoch(attr(attrs, 'stop'));
      if (Number.isNaN(start) || Number.isNaN(stop)) continue;
      (out[channel] || (out[channel] = [])).push({
        start,
        stop,
        title: tagText(body, 'title'),
        desc: tagText(body, 'desc'),
        category: tagText(body, 'category')
      });
    }
    Object.keys(out).forEach((k) => out[k].sort((a, b) => a.start - b.start));
    return out;
  }

  const api = { xmltvTimeToEpoch, parseXmltv };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else {
    root.parseXmltv = parseXmltv;
    root.xmltvTimeToEpoch = xmltvTimeToEpoch;
  }
})(typeof self !== 'undefined' ? self : this);
