/**
 * Parallel EPG history prefetch for timeshift-enabled streams.
 *
 * Pure module: takes a list of streams and a fetcher, runs them with bounded
 * concurrency and per-fetch timeout, returns aggregate stats. No DOM or IDB
 * dependencies — caller wires those in.
 *
 * @param {Array<{streamId?: number|string, epgChannelId?: string}>} streams
 * @param {object} opts
 * @param {(stream) => Promise<{epg_listings?: Array}>} opts.fetcher
 * @param {number} [opts.concurrency=5]
 * @param {number} [opts.perFetchTimeoutMs=15000]
 * @param {(current: number, total: number, stream: object) => void} [opts.onProgress]
 * @returns {Promise<{total: number, succeeded: number, failed: number, skipped: number, results: Array<{stream: object, listings: object|null, error: Error|null}>}>}
 */
async function prefetchEpgHistory(streams, opts) {
  const {
    fetcher,
    concurrency = 5,
    perFetchTimeoutMs = 15000,
    onProgress = null
  } = opts || {};

  const list = Array.isArray(streams) ? streams : [];
  const stats = { total: list.length, succeeded: 0, failed: 0, skipped: 0, results: [] };
  if (list.length === 0) return stats;

  // Pre-filter into runnable + skipped so the worker pool only sees valid work.
  const queue = [];
  for (const s of list) {
    if (!s || !s.streamId || !s.epgChannelId) {
      stats.skipped++;
    } else {
      queue.push(s);
    }
  }

  let nextIndex = 0;
  let progressCount = 0; // counts work items started (excludes skipped streams)

  async function worker() {
    while (true) {
      const i = nextIndex++;
      if (i >= queue.length) return;
      const stream = queue[i];
      progressCount++;
      if (typeof onProgress === 'function') {
        try { onProgress(progressCount, list.length, stream); } catch (_) { /* swallow callback errors */ }
      }
      try {
        const value = await runWithTimeout(fetcher(stream), perFetchTimeoutMs, `timeout after ${perFetchTimeoutMs}ms`);
        stats.succeeded++;
        stats.results.push({ stream, listings: value, error: null });
      } catch (err) {
        stats.failed++;
        stats.results.push({ stream, listings: null, error: err });
        // Surfacing the error to console helps the existing log surface identify the channel.
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`[EPG Prefetch] ${stream.name || stream.streamId}: ${(err && err.message) || err}`);
        }
      }
    }
  }

  const workerCount = Math.max(1, Math.min(concurrency, queue.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return stats;
}

function runWithTimeout(promise, ms, message) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(message || 'timeout')), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// CommonJS export for tests; renderer just uses the global.
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { prefetchEpgHistory };
}
if (typeof window !== 'undefined') {
  window.prefetchEpgHistory = prefetchEpgHistory;
}
