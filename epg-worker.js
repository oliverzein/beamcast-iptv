/* EPG XMLTV parse worker. Keeps multi-MB parsing off the UI thread. */
importScripts('epg-parse.js');

self.onmessage = function (e) {
  try {
    const channelMap = parseXmltv(e.data && e.data.xml);
    self.postMessage({ channelMap });
  } catch (err) {
    self.postMessage({ error: err && err.message ? err.message : String(err) });
  }
};
