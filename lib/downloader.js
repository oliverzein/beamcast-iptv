/**
 * Streaming HTTP/HTTPS VOD Downloader.
 *
 * Pure Node.js module handling Xtream HTTP quirks:
 * - Unexpected HTTP 206 Partial Content on initial GET without Range
 * - Chunked HTTP 206 continuation loops until totalBytes is reached
 * - Cross-protocol 301/302/303/307/308 redirects preserving User-Agent & Range
 * - Exponential-backoff Range retries (or reset-from-0 when non-resumable)
 * - Inactivity timeouts, AbortSignal cancellation, and credential redaction
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');

const REDIRECT_STATUS_CODES = new Set([301, 302, 303, 307, 308]);
const NON_RETRYABLE_STATUS_CODES = new Set([401, 403, 404, 410]);
const SENSITIVE_QUERY_KEYS = new Set(['username', 'password', 'token']);
const XTREAM_PATH_RE = /^\/(live|movie|series)\/([^/]+)\/([^/]+)(\/.*)?$/i;
const CONTENT_RANGE_RE = /^bytes\s+(\d+)-(\d+|\*)\/(\d+|\*)$/i;

function maskXtreamPath(pathname) {
  return pathname.replace(
    XTREAM_PATH_RE,
    (_, kind, _user, _pass, rest = '') => `/${kind}/***/***${rest}`
  );
}

function redactUnparseableUrl(text) {
  return text
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/:@\s]+):([^/@\s]+)@/gi, '$1***:***@')
    .replace(/([a-z][a-z0-9+.-]*:\/\/)([^/@\s]+)@/gi, '$1***@')
    .replace(
      /(^|[a-z][a-z0-9+.-]*:\/\/[^/\s]+)\/(live|movie|series)\/([^/\s]+)\/([^/\s]+)(\/[^\s?#]*)?/gi,
      (_, prefix, kind, _user, _pass, rest = '') => `${prefix}/${kind}/***/***${rest}`
    )
    .replace(/([?&](?:username|password|token)=)([^&\s#]*)/gi, '$1***');
}

function redactUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl) return '';
  try {
    const parsed = new URL(rawUrl);
    if (parsed.username) parsed.username = '***';
    if (parsed.password) parsed.password = '***';
    parsed.pathname = maskXtreamPath(parsed.pathname);
    for (const key of Array.from(parsed.searchParams.keys())) {
      if (SENSITIVE_QUERY_KEYS.has(key.toLowerCase())) {
        parsed.searchParams.set(key, '***');
      }
    }
    return parsed.toString();
  } catch {
    return redactUnparseableUrl(rawUrl);
  }
}

function parseContentRange(header) {
  if (typeof header !== 'string') return null;
  const match = CONTENT_RANGE_RE.exec(header.trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = match[2] === '*' ? null : Number(match[2]);
  const total = match[3] === '*' ? null : Number(match[3]);
  if (!Number.isSafeInteger(start) || start < 0) return null;
  if (end !== null && (!Number.isSafeInteger(end) || end < start)) return null;
  if (total !== null && (!Number.isSafeInteger(total) || total < 0)) return null;
  return { start, end, total };
}

function parseContentLength(headers) {
  const raw = headers['content-length'];
  if (raw === undefined) return null;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createAbortError(message = 'Download aborted') {
  const err = new Error(message);
  err.name = 'AbortError';
  return err;
}

function createHttpStatusError(statusCode, targetUrl) {
  const err = new Error(`HTTP ${statusCode} for ${redactUrl(targetUrl)}`);
  err.statusCode = statusCode;
  err.nonRetryable = NON_RETRYABLE_STATUS_CODES.has(statusCode);
  return err;
}

function sanitizeError(err, knownUrls = []) {
  if (!err || err.name === 'AbortError') return err;
  let message = typeof err.message === 'string' ? err.message : String(err);
  for (const raw of knownUrls) {
    if (raw && message.includes(raw)) {
      message = message.split(raw).join(redactUrl(raw));
    }
  }
  message = redactUnparseableUrl(message);
  if (message === err.message && !Object.prototype.hasOwnProperty.call(err, 'input')) {
    return err;
  }
  const wrapped = new Error(message);
  wrapped.name = err.name;
  wrapped.code = err.code;
  wrapped.statusCode = err.statusCode;
  wrapped.nonRetryable = err.nonRetryable;
  return wrapped;
}

function parseSupportedUrl(rawUrl, fallbackUrl = rawUrl) {
  let parsed;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error(`Invalid URL: ${redactUrl(fallbackUrl)}`);
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`Unsupported protocol "${parsed.protocol}" for ${redactUrl(rawUrl)}`);
  }
  return parsed;
}

function sleepWithAbort(delayMs, signal) {
  if (signal?.aborted) return Promise.reject(createAbortError());
  if (delayMs <= 0) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const onAbort = () => {
      clearTimeout(timer);
      reject(createAbortError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, delayMs);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function computeProgress({ bytesWritten, totalBytes, sessionBytes, startedAtMs }) {
  const safeBytes = Number.isFinite(bytesWritten) && bytesWritten >= 0 ? bytesWritten : 0;
  const safeTotal = Number.isFinite(totalBytes) && totalBytes > 0 ? totalBytes : 0;
  const elapsedSec = (Date.now() - startedAtMs) / 1000;
  const rawSpeed = elapsedSec > 0 && sessionBytes > 0 ? sessionBytes / elapsedSec : 0;
  const speedBps = Number.isFinite(rawSpeed) && rawSpeed > 0 ? Math.round(rawSpeed) : 0;

  let etaSec = null;
  if (safeTotal > 0 && speedBps > 0) {
    const remaining = Math.max(0, safeTotal - safeBytes);
    const rawEta = Math.ceil(remaining / speedBps);
    etaSec = Number.isFinite(rawEta) ? rawEta : null;
  }
  return { bytesWritten: safeBytes, totalBytes: safeTotal, speedBps, etaSec };
}

function createProgressReporter(onProgress, startedAtMs) {
  let lastBytes = -1;
  let lastTotal = -1;
  return (bytesWritten, totalBytes, sessionBytes, force = false) => {
    if (typeof onProgress !== 'function') return;
    if (!force && lastBytes === bytesWritten && lastTotal === totalBytes) return;
    lastBytes = bytesWritten;
    lastTotal = totalBytes;
    onProgress(computeProgress({ bytesWritten, totalBytes, sessionBytes, startedAtMs }));
  };
}

async function safeFileSize(filePath) {
  try {
    const stat = await fs.promises.stat(filePath);
    return stat.size;
  } catch {
    return 0;
  }
}

function destroyTransport(req, res) {
  if (req && !req.destroyed) req.destroy();
  if (res && !res.destroyed) res.destroy();
}

function disposeConnection(connection) {
  if (!connection) return;
  connection.cleanupEarlyListeners?.();
  connection.setReqErrorHandler?.(() => {});
  connection.res?.on('error', () => {});
  destroyTransport(connection.req, connection.res);
}

function closeWriteStream(writeStream, flush) {
  if (!writeStream || writeStream.closed) return Promise.resolve();

  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (err) => {
      if (done) return;
      done = true;
      writeStream.removeListener('close', onClose);
      writeStream.removeListener('error', onError);
      if (err) reject(err);
      else resolve();
    };
    const onClose = () => finish();
    const onError = (err) => finish(err);
    writeStream.on('close', onClose);
    writeStream.on('error', onError);

    if (flush && !writeStream.destroyed && !writeStream.writableEnded) {
      writeStream.end();
    } else if (!writeStream.destroyed) {
      writeStream.destroy();
    }
  });
}

function wrapStreamResponse(res, req, setReqErrorHandler) {
  // Pause synchronously so 'data'/'end' cannot fire before streamResponseToFile attaches listeners.
  res.pause();
  const earlyState = { reqError: null, resError: null, resAborted: false };
  const onEarlyResError = (err) => { earlyState.resError = err; };
  const onEarlyResAborted = () => { earlyState.resAborted = true; };
  setReqErrorHandler((err) => { earlyState.reqError = err; });
  res.on('error', onEarlyResError);
  res.on('aborted', onEarlyResAborted);

  return {
    kind: 'stream',
    res,
    req,
    earlyState,
    cleanupEarlyListeners: () => {
      res.removeListener('error', onEarlyResError);
      res.removeListener('aborted', onEarlyResAborted);
    },
    setReqErrorHandler,
  };
}

function sendHttpRequest({ targetUrl, startOffset, userAgent, requestTimeoutMs, signal }) {
  if (signal?.aborted) return Promise.reject(createAbortError());

  const parsed = parseSupportedUrl(targetUrl);
  const transport = parsed.protocol === 'https:' ? https : http;
  const headers = { 'User-Agent': userAgent };
  if (startOffset > 0) headers.Range = `bytes=${startOffset}-`;

  return new Promise((resolve, reject) => {
    let settled = false;
    let reqErrorHandler = null;
    let timer = null;

    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
    };
    const fail = (err) => {
      if (settled) return;
      settled = true;
      cleanup();
      reqErrorHandler = () => {};
      if (!req.destroyed) req.destroy();
      reject(err);
    };
    const onAbort = () => fail(createAbortError());

    const req = transport.request(parsed, { method: 'GET', headers, agent: false });
    reqErrorHandler = (err) => fail(sanitizeError(err, [targetUrl]));
    req.on('error', (err) => { if (reqErrorHandler) reqErrorHandler(err); });

    if (requestTimeoutMs > 0) {
      timer = setTimeout(() => {
        fail(new Error(`Request timeout after ${requestTimeoutMs}ms for ${redactUrl(targetUrl)}`));
      }, requestTimeoutMs);
    }
    signal?.addEventListener('abort', onAbort, { once: true });

    req.once('response', (res) => {
      if (settled) {
        res.on('error', () => {});
        res.destroy();
        return;
      }
      settled = true;
      cleanup();

      const status = res.statusCode || 0;
      if (REDIRECT_STATUS_CODES.has(status) || status >= 400 || (status !== 200 && status !== 206)) {
        reqErrorHandler = () => {};
        res.on('error', () => {});
        const control = { kind: 'control', statusCode: status, headers: res.headers };
        destroyTransport(req, res);
        resolve(control);
        return;
      }
      resolve(wrapStreamResponse(res, req, (fn) => { reqErrorHandler = fn; }));
    });
    req.end();
  });
}

function resolveControlResponse(response, currentUrl, originalUrl, redirects, maxRedirects) {
  const { statusCode, headers } = response;
  if (REDIRECT_STATUS_CODES.has(statusCode)) {
    const location = headers.location;
    if (!location) {
      throw new Error(`HTTP ${statusCode} redirect missing Location header for ${redactUrl(currentUrl)}`);
    }
    if (redirects >= maxRedirects) {
      throw new Error(`Too many redirects (${maxRedirects}) for ${redactUrl(originalUrl)}`);
    }
    try {
      return new URL(location, currentUrl).toString();
    } catch {
      throw new Error(`Invalid redirect Location "${redactUrl(String(location))}" from ${redactUrl(currentUrl)}`);
    }
  }
  if (statusCode >= 400) throw createHttpStatusError(statusCode, currentUrl);
  const err = new Error(`Unexpected HTTP status ${statusCode} for ${redactUrl(currentUrl)}`);
  err.statusCode = statusCode;
  throw err;
}

async function openHttpResponse({ url, startOffset, userAgent, maxRedirects, requestTimeoutMs, signal }) {
  let currentUrl = url;
  for (let redirects = 0; ; redirects += 1) {
    const response = await sendHttpRequest({
      targetUrl: currentUrl,
      startOffset,
      userAgent,
      requestTimeoutMs,
      signal,
    });
    if (response.kind === 'stream') {
      return { ...response, finalUrl: currentUrl };
    }
    currentUrl = resolveControlResponse(response, currentUrl, url, redirects, maxRedirects);
  }
}

function resolveResponsePlan(res, startOffset, knownTotalBytes, targetUrl) {
  const statusCode = res.statusCode;
  const legContentLength = parseContentLength(res.headers);
  const acceptRanges = String(res.headers['accept-ranges'] || '').toLowerCase().includes('bytes');

  if (statusCode === 200) {
    return {
      statusCode,
      effectiveOffset: 0,
      flags: 'w',
      needsTruncate: false,
      canResume: acceptRanges,
      legContentLength,
      totalBytes: legContentLength !== null ? legContentLength : 0,
    };
  }

  const parsedRange = parseContentRange(res.headers['content-range']);
  if (parsedRange && parsedRange.start > startOffset) {
    throw new Error(
      `Unexpected Content-Range start ${parsedRange.start} > expected ${startOffset} for ${redactUrl(targetUrl)}`
    );
  }

  const effectiveOffset = parsedRange ? parsedRange.start : startOffset;
  let totalBytes = 0;
  if (parsedRange) {
    totalBytes = parsedRange.total !== null ? parsedRange.total : 0;
  } else if (effectiveOffset === 0 && legContentLength !== null) {
    totalBytes = legContentLength;
  } else {
    totalBytes = knownTotalBytes || 0;
  }

  return {
    statusCode,
    effectiveOffset,
    flags: effectiveOffset === 0 ? 'w' : 'a',
    needsTruncate: effectiveOffset > 0 && effectiveOffset < startOffset,
    canResume: true,
    legContentLength,
    totalBytes,
  };
}

function getEarlyConnectionError(connection, signal) {
  const { res, finalUrl, earlyState, cleanupEarlyListeners } = connection;
  cleanupEarlyListeners();
  if (signal?.aborted) return createAbortError();
  if (earlyState.reqError) return sanitizeError(earlyState.reqError, [finalUrl]);
  if (earlyState.resError) return sanitizeError(earlyState.resError, [finalUrl]);
  if (earlyState.resAborted || res.destroyed) {
    return new Error(`Stream aborted for ${redactUrl(finalUrl)}`);
  }
  return null;
}

function verifyLegCompletion(res, plan, legBytes, finalUrl) {
  if (res.complete === false) {
    return new Error(`Incomplete response body for ${redactUrl(finalUrl)}`);
  }
  if (plan.legContentLength !== null && legBytes < plan.legContentLength) {
    return new Error(`Premature EOF (${legBytes}/${plan.legContentLength} bytes) for ${redactUrl(finalUrl)}`);
  }
  return null;
}

function createInactivityTimer(requestTimeoutMs, onTimeout) {
  let timer = null;
  return {
    reset: () => {
      clearTimeout(timer);
      if (requestTimeoutMs > 0) {
        timer = setTimeout(onTimeout, requestTimeoutMs);
      }
    },
    clear: () => clearTimeout(timer),
  };
}

function attachStreamDataAndEnd({ res, writeStream, plan, timer, state, finalUrl, onChunk, onFail, onSuccess }) {
  res.on('data', (chunk) => {
    if (state.settled) return;
    timer.reset();
    state.legBytes += chunk.length;
    onChunk(chunk.length);
    if (!writeStream.write(chunk) && !state.waitingForDrain) {
      state.waitingForDrain = true;
      res.pause();
      writeStream.once('drain', () => {
        state.waitingForDrain = false;
        if (!state.settled) res.resume();
      });
    }
  });

  res.on('end', () => {
    if (state.settled) return;
    state.resEnded = true;
    const incompleteErr = verifyLegCompletion(res, plan, state.legBytes, finalUrl);
    if (incompleteErr) {
      onFail(incompleteErr, true);
      return;
    }
    onSuccess(state.legBytes);
  });
}

function pumpBodyStream({ connection, writeStream, partPath, plan, requestTimeoutMs, signal, onChunk }) {
  const { res, req, finalUrl, setReqErrorHandler } = connection;

  return new Promise((resolve, reject) => {
    const state = { settled: false, resEnded: false, writeOpened: false, waitingForDrain: false, legBytes: 0 };

    const timer = createInactivityTimer(requestTimeoutMs, () => {
      fail(new Error(`Stream inactivity timeout after ${requestTimeoutMs}ms for ${redactUrl(finalUrl)}`), true);
    });

    const cleanup = () => {
      timer.clear();
      signal?.removeEventListener('abort', onAbort);
      setReqErrorHandler(() => {});
      res.on('error', () => {});
    };

    const fail = (err, flushWriteStream) => {
      if (state.settled) return;
      state.settled = true;
      cleanup();
      destroyTransport(req, res);
      closeWriteStream(writeStream, flushWriteStream)
        .catch(() => {})
        .finally(async () => {
          err.persistedBytes = state.writeOpened ? await safeFileSize(partPath) : null;
          reject(err);
        });
    };

    const onSuccess = (legBytes) => {
      state.settled = true;
      cleanup();
      closeWriteStream(writeStream, true)
        .then(() => resolve({ legBytes }))
        .catch((err) => {
          const diskErr = sanitizeError(err, [finalUrl]);
          diskErr.nonRetryable = true;
          reject(diskErr);
        });
    };

    const onAbort = () => fail(createAbortError(), false);
    setReqErrorHandler((err) => fail(sanitizeError(err, [finalUrl]), true));
    signal?.addEventListener('abort', onAbort, { once: true });

    writeStream.on('open', () => { state.writeOpened = true; });
    writeStream.on('error', (err) => {
      const diskErr = sanitizeError(err, [finalUrl]);
      diskErr.nonRetryable = true;
      fail(diskErr, false);
    });

    res.on('error', (err) => fail(sanitizeError(err, [finalUrl]), true));
    res.on('aborted', () => fail(new Error(`Response aborted for ${redactUrl(finalUrl)}`), true));
    res.on('close', () => {
      if (!state.settled && !state.resEnded) {
        fail(new Error(`Connection closed prematurely for ${redactUrl(finalUrl)}`), true);
      }
    });

    attachStreamDataAndEnd({ res, writeStream, plan, timer, state, finalUrl, onChunk, onFail: fail, onSuccess });
    timer.reset();
    res.resume();
  });
}

async function streamResponseToFile({ connection, partPath, plan, requestTimeoutMs, signal, onChunk }) {
  const earlyFailure = getEarlyConnectionError(connection, signal);
  if (earlyFailure) {
    disposeConnection(connection);
    throw earlyFailure;
  }

  let writeStream;
  try {
    if (plan.needsTruncate) {
      await fs.promises.truncate(partPath, plan.effectiveOffset);
    }
    writeStream = fs.createWriteStream(partPath, { flags: plan.flags });
  } catch (err) {
    disposeConnection(connection);
    throw err;
  }

  return pumpBodyStream({ connection, writeStream, partPath, plan, requestTimeoutMs, signal, onChunk });
}

async function runDownloadLeg({
  url,
  partPath,
  legStartOffset,
  knownTotalBytes,
  userAgent,
  maxRedirects,
  requestTimeoutMs,
  signal,
  onPlan,
  onChunk,
}) {
  const connection = await openHttpResponse({
    url,
    startOffset: legStartOffset,
    userAgent,
    maxRedirects,
    requestTimeoutMs,
    signal,
  });

  let plan;
  try {
    plan = resolveResponsePlan(connection.res, legStartOffset, knownTotalBytes, connection.finalUrl);
  } catch (err) {
    disposeConnection(connection);
    throw err;
  }

  onPlan(plan);
  const { legBytes } = await streamResponseToFile({
    connection,
    partPath,
    plan,
    requestTimeoutMs,
    signal,
    onChunk,
  });
  return { plan, legBytes };
}

async function downloadFile({
  url,
  partPath,
  signal,
  onProgress,
  userAgent = 'BeamcastIPTV/1.3.1',
  maxRedirects = 10,
  maxRetries = 3,
  requestTimeoutMs = 30000,
  retryBaseDelayMs = 1000,
}) {
  if (signal?.aborted) throw createAbortError();
  await fs.promises.mkdir(path.dirname(partPath), { recursive: true });

  const reportProgress = createProgressReporter(onProgress, Date.now());
  let bytesWritten = 0;
  let totalBytes = 0;
  let sessionBytes = 0;
  let canResume = false;
  let retryAttempt = 0;

  while (true) {
    if (signal?.aborted) throw createAbortError();
    const legStartOffset = bytesWritten;

    try {
      const { plan, legBytes } = await runDownloadLeg({
        url,
        partPath,
        legStartOffset,
        knownTotalBytes: totalBytes,
        userAgent,
        maxRedirects,
        requestTimeoutMs,
        signal,
        onPlan: (resolved) => {
          if (resolved.canResume) canResume = true;
          totalBytes = resolved.totalBytes;
          bytesWritten = resolved.effectiveOffset;
        },
        onChunk: (len) => {
          bytesWritten += len;
          sessionBytes += len;
          reportProgress(bytesWritten, totalBytes, sessionBytes, false);
        },
      });

      if (plan.statusCode === 200 || totalBytes === 0 || bytesWritten >= totalBytes) {
        reportProgress(bytesWritten, totalBytes, sessionBytes, true);
        return { bytesWritten, totalBytes };
      }
      if (legBytes === 0 || bytesWritten <= legStartOffset) {
        throw new Error(`Server made no forward progress at offset ${legStartOffset} for ${redactUrl(url)}`);
      }
      retryAttempt = 0;
    } catch (err) {
      if (err && typeof err.persistedBytes === 'number') {
        bytesWritten = err.persistedBytes;
      }
      const cleanErr = sanitizeError(err, [url]);
      if (cleanErr.name === 'AbortError' || cleanErr.nonRetryable || retryAttempt >= maxRetries) {
        throw cleanErr;
      }
      if (!canResume) bytesWritten = 0;

      const delayMs = retryBaseDelayMs * (2 ** retryAttempt);
      retryAttempt += 1;
      await sleepWithAbort(delayMs, signal);
    }
  }
}

module.exports = {
  redactUrl,
  parseContentRange,
  downloadFile,
};
