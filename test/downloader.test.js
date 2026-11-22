const { test } = require('node:test');
const assert = require('node:assert');
const http = require('node:http');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { redactUrl, parseContentRange, downloadFile } = require('../lib/downloader.js');

async function startMockServer(handler) {
  const server = http.createServer(handler);
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const addr = server.address();
  return {
    server,
    port: addr.port,
    baseUrl: `http://127.0.0.1:${addr.port}`,
    close: async () => {
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function withTempDir(fn) {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'beamcast-dl-test-'));
  try {
    return await fn(dir);
  } finally {
    await fs.promises.rm(dir, { recursive: true, force: true });
  }
}

test('redactUrl: masks credentials in userinfo, Xtream paths, query params, and invalid URLs', () => {
  assert.strictEqual(
    redactUrl('http://alice:s3cr3t@iptv.example.com:8080/video.mkv'),
    'http://***:***@iptv.example.com:8080/video.mkv'
  );
  assert.strictEqual(
    redactUrl('http://iptv.example.com:8080/movie/myUser/myPass/123.mkv'),
    'http://iptv.example.com:8080/movie/***/***/123.mkv'
  );
  assert.strictEqual(
    redactUrl('https://iptv.example.com/series/myUser/myPass/45.mp4'),
    'https://iptv.example.com/series/***/***/45.mp4'
  );
  assert.strictEqual(
    redactUrl('http://iptv.example.com/live/myUser/myPass/9.ts'),
    'http://iptv.example.com/live/***/***/9.ts'
  );
  assert.strictEqual(
    redactUrl('http://iptv.example.com/player_api.php?username=x&password=y&action=get_vod&token=tok123'),
    'http://iptv.example.com/player_api.php?username=***&password=***&action=get_vod&token=***'
  );
  assert.strictEqual(
    redactUrl('/movie/myUser/myPass/123.mkv?username=x&password=y'),
    '/movie/***/***/123.mkv?username=***&password=***'
  );
  assert.strictEqual(
    redactUrl('http://cdn.example.com/streams/public-movie.mp4'),
    'http://cdn.example.com/streams/public-movie.mp4'
  );
});

test('parseContentRange: parses valid headers and returns null on invalid ones', () => {
  assert.deepStrictEqual(parseContentRange('bytes 0-1023/1024'), { start: 0, end: 1023, total: 1024 });
  assert.deepStrictEqual(parseContentRange('bytes 256-511/1024'), { start: 256, end: 511, total: 1024 });
  assert.deepStrictEqual(parseContentRange('bytes 0-511/*'), { start: 0, end: 511, total: null });
  assert.deepStrictEqual(parseContentRange('bytes 100-*/*'), { start: 100, end: null, total: null });
  assert.strictEqual(parseContentRange('bytes */1024'), null);
  assert.strictEqual(parseContentRange('invalid'), null);
  assert.strictEqual(parseContentRange(''), null);
  assert.strictEqual(parseContentRange(null), null);
});

test('downloadFile: handles HTTP 200 OK with Content-Length and reports valid progress', async () => {
  const payload = Buffer.alloc(2048, 0x61);
  for (let i = 0; i < payload.length; i++) payload[i] = i % 251;

  const mock = await startMockServer((req, res) => {
    res.writeHead(200, {
      'Content-Length': String(payload.length),
      'Content-Type': 'application/octet-stream',
    });
    res.end(payload);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'nested', 'movie.raw.part');
      const progressEvents = [];
      const result = await downloadFile({
        url: `${mock.baseUrl}/movie.mkv`,
        partPath,
        onProgress: (p) => progressEvents.push({ ...p }),
      });

      assert.deepStrictEqual(result, { bytesWritten: 2048, totalBytes: 2048 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);
      assert.ok(progressEvents.length >= 1);
      const last = progressEvents[progressEvents.length - 1];
      assert.strictEqual(last.bytesWritten, 2048);
      assert.strictEqual(last.totalBytes, 2048);
      for (const evt of progressEvents) {
        assert.ok(Number.isFinite(evt.speedBps) && evt.speedBps >= 0);
        assert.ok(evt.etaSec === null || (Number.isFinite(evt.etaSec) && evt.etaSec >= 0));
      }
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: handles HTTP 200 OK without Content-Length cleanly with totalBytes 0 and etaSec null', async () => {
  const chunk1 = Buffer.from('hello-stream-');
  const chunk2 = Buffer.from('without-content-length');
  const expected = Buffer.concat([chunk1, chunk2]);

  const mock = await startMockServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    res.write(chunk1);
    setTimeout(() => {
      res.write(chunk2);
      res.end();
    }, 15);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'unknown-len.raw.part');
      const progressEvents = [];
      const result = await downloadFile({
        url: `${mock.baseUrl}/stream.mkv`,
        partPath,
        onProgress: (p) => progressEvents.push({ ...p }),
      });

      assert.deepStrictEqual(result, { bytesWritten: expected.length, totalBytes: 0 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, expected);
      assert.ok(progressEvents.length >= 1);
      for (const evt of progressEvents) {
        assert.strictEqual(evt.totalBytes, 0);
        assert.strictEqual(evt.etaSec, null);
        assert.ok(Number.isFinite(evt.speedBps) && evt.speedBps >= 0);
      }
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: handles single HTTP 206 Partial Content on initial GET without Range header', async () => {
  const payload = Buffer.alloc(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 7) & 0xff;
  let requestCount = 0;
  let initialHadRange = false;

  const mock = await startMockServer((req, res) => {
    requestCount += 1;
    if (requestCount === 1 && req.headers.range) initialHadRange = true;
    res.writeHead(206, {
      'Content-Range': 'bytes 0-1023/1024',
      'Content-Length': '1024',
    });
    res.end(payload);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'single206.raw.part');
      const result = await downloadFile({
        url: `${mock.baseUrl}/movie/u/p/1.mkv`,
        partPath,
      });

      assert.strictEqual(requestCount, 1);
      assert.strictEqual(initialHadRange, false);
      assert.deepStrictEqual(result, { bytesWritten: 1024, totalBytes: 1024 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: handles HTTP 206 with unknown total (bytes 0-511/*) without looping indefinitely', async () => {
  const payload = Buffer.alloc(512, 0x42);
  let requestCount = 0;

  const mock = await startMockServer((req, res) => {
    requestCount += 1;
    res.writeHead(206, {
      'Content-Range': 'bytes 0-511/*',
      'Content-Length': '512',
    });
    res.end(payload);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'unknown206.raw.part');
      const progressEvents = [];
      const result = await downloadFile({
        url: `${mock.baseUrl}/movie/u/p/2.mkv`,
        partPath,
        onProgress: (p) => progressEvents.push({ ...p }),
      });

      assert.strictEqual(requestCount, 1);
      assert.deepStrictEqual(result, { bytesWritten: 512, totalBytes: 0 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);
      for (const evt of progressEvents) {
        assert.strictEqual(evt.totalBytes, 0);
        assert.strictEqual(evt.etaSec, null);
        assert.ok(!Number.isNaN(evt.speedBps));
      }
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: executes chunked HTTP 206 continuation loop with Range headers', async () => {
  const total = 1024;
  const chunkSize = 256;
  const payload = Buffer.alloc(total);
  for (let i = 0; i < total; i++) payload[i] = i & 0xff;
  const seenRanges = [];

  const mock = await startMockServer((req, res) => {
    const rangeHeader = req.headers.range || null;
    seenRanges.push(rangeHeader);
    let start = 0;
    if (rangeHeader) {
      const match = /^bytes=(\d+)-$/.exec(rangeHeader);
      assert.ok(match, `unexpected Range header: ${rangeHeader}`);
      start = Number(match[1]);
    }
    const end = Math.min(start + chunkSize - 1, total - 1);
    const slice = payload.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/${total}`,
      'Content-Length': String(slice.length),
    });
    res.end(slice);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'chunked206.raw.part');
      const result = await downloadFile({
        url: `${mock.baseUrl}/series/u/p/45.mp4`,
        partPath,
      });

      assert.deepStrictEqual(result, { bytesWritten: 1024, totalBytes: 1024 });
      assert.deepStrictEqual(seenRanges, [
        null,
        'bytes=256-',
        'bytes=512-',
        'bytes=768-',
      ]);
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: follows 302 and 307 redirects across mock servers while preserving User-Agent and Range', async () => {
  const payload = Buffer.alloc(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 3) & 0xff;

  const logA = [];
  const logB = [];
  const logC = [];

  const serverC = await startMockServer((req, res) => {
    logC.push({ ua: req.headers['user-agent'], range: req.headers.range || null });
    const start = req.headers.range ? Number(/^bytes=(\d+)-$/.exec(req.headers.range)[1]) : 0;
    const end = start === 0 ? 511 : 1023;
    const slice = payload.subarray(start, end + 1);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${end}/1024`,
      'Content-Length': String(slice.length),
    });
    res.end(slice);
  });

  const serverB = await startMockServer((req, res) => {
    logB.push({ ua: req.headers['user-agent'], range: req.headers.range || null });
    res.writeHead(307, { Location: `${serverC.baseUrl}/final.mkv` });
    res.end();
  });

  const serverA = await startMockServer((req, res) => {
    logA.push({ ua: req.headers['user-agent'], range: req.headers.range || null });
    res.writeHead(302, { Location: `${serverB.baseUrl}/hop` });
    res.end();
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'redirected.raw.part');
      const result = await downloadFile({
        url: `${serverA.baseUrl}/start`,
        partPath,
        userAgent: 'BeamcastTestUA/2.0',
      });

      assert.deepStrictEqual(result, { bytesWritten: 1024, totalBytes: 1024 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);

      assert.deepStrictEqual(logA, [
        { ua: 'BeamcastTestUA/2.0', range: null },
        { ua: 'BeamcastTestUA/2.0', range: 'bytes=512-' },
      ]);
      assert.deepStrictEqual(logB, [
        { ua: 'BeamcastTestUA/2.0', range: null },
        { ua: 'BeamcastTestUA/2.0', range: 'bytes=512-' },
      ]);
      assert.deepStrictEqual(logC, [
        { ua: 'BeamcastTestUA/2.0', range: null },
        { ua: 'BeamcastTestUA/2.0', range: 'bytes=512-' },
      ]);
    });
  } finally {
    await serverA.close();
    await serverB.close();
    await serverC.close();
  }
});

test('downloadFile: recovers from mid-stream socket.destroy() via Range retry', async () => {
  const payload = Buffer.alloc(1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i + 17) & 0xff;
  let attempts = 0;
  const seenRanges = [];

  const mock = await startMockServer((req, res) => {
    attempts += 1;
    seenRanges.push(req.headers.range || null);

    if (attempts === 1) {
      res.writeHead(200, {
        'Content-Length': String(payload.length),
        'Accept-Ranges': 'bytes',
      });
      res.write(payload.subarray(0, 320));
      setTimeout(() => res.socket.destroy(), 15);
      return;
    }

    const match = /^bytes=(\d+)-$/.exec(req.headers.range || '');
    const start = match ? Number(match[1]) : 0;
    const slice = payload.subarray(start);
    res.writeHead(206, {
      'Content-Range': `bytes ${start}-${payload.length - 1}/${payload.length}`,
      'Content-Length': String(slice.length),
    });
    res.end(slice);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'retry-range.raw.part');
      const result = await downloadFile({
        url: `${mock.baseUrl}/movie/u/p/77.mkv`,
        partPath,
        retryBaseDelayMs: 10,
      });

      assert.strictEqual(attempts, 2);
      assert.strictEqual(seenRanges[0], null);
      assert.strictEqual(seenRanges[1], 'bytes=320-');
      assert.deepStrictEqual(result, { bytesWritten: 1024, totalBytes: 1024 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: resets from byte 0 on retry when server did not advertise Accept-Ranges or 206', async () => {
  const payload = Buffer.alloc(1024, 0x5a);
  let attempts = 0;
  const seenRanges = [];

  const mock = await startMockServer((req, res) => {
    attempts += 1;
    seenRanges.push(req.headers.range || null);
    if (attempts === 1) {
      res.writeHead(200, { 'Content-Length': String(payload.length) });
      res.write(payload.subarray(0, 300));
      setTimeout(() => res.socket.destroy(), 15);
      return;
    }
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'retry-reset.raw.part');
      const result = await downloadFile({
        url: `${mock.baseUrl}/no-ranges.mkv`,
        partPath,
        retryBaseDelayMs: 10,
      });

      assert.strictEqual(attempts, 2);
      assert.deepStrictEqual(seenRanges, [null, null]);
      assert.deepStrictEqual(result, { bytesWritten: 1024, totalBytes: 1024 });
      const written = await fs.promises.readFile(partPath);
      assert.deepStrictEqual(written, payload);
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: rejects 404 without retrying and without leaking Xtream credentials in err.message', async () => {
  let attempts = 0;
  const mock = await startMockServer((req, res) => {
    attempts += 1;
    res.writeHead(404, { 'Content-Type': 'text/plain' });
    res.end('Not Found');
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'notfound.raw.part');
      await assert.rejects(
        () => downloadFile({
          url: `${mock.baseUrl}/movie/secretUser/secretPass/99.mkv`,
          partPath,
          retryBaseDelayMs: 10,
        }),
        (err) => {
          assert.strictEqual(err.statusCode, 404);
          assert.strictEqual(err.nonRetryable, true);
          assert.ok(!err.message.includes('secretUser'), `credential leaked: ${err.message}`);
          assert.ok(!err.message.includes('secretPass'), `credential leaked: ${err.message}`);
          assert.ok(err.message.includes('/movie/***/***/99.mkv'));
          return true;
        }
      );
      assert.strictEqual(attempts, 1);
    });
  } finally {
    await mock.close();
  }
});

test('downloadFile: aborts immediately on AbortController.abort() with AbortError', async () => {
  const sockets = new Set();
  let streamStartedResolve;
  const streamStarted = new Promise((r) => { streamStartedResolve = r; });

  const mock = await startMockServer((req, res) => {
    sockets.add(res.socket);
    res.socket.on('close', () => sockets.delete(res.socket));
    res.writeHead(200, { 'Content-Length': '1000000' });
    res.write(Buffer.alloc(256, 0x33));
    streamStartedResolve();
  });

  try {
    await withTempDir(async (dir) => {
      const partPath = path.join(dir, 'aborted.raw.part');
      const controller = new AbortController();

      const dlPromise = downloadFile({
        url: `${mock.baseUrl}/movie/u/p/55.mkv`,
        partPath,
        signal: controller.signal,
      });

      await streamStarted;
      const abortedAt = Date.now();
      controller.abort();

      await assert.rejects(
        () => dlPromise,
        (err) => err && err.name === 'AbortError'
      );
      assert.ok(Date.now() - abortedAt < 500, 'abort took too long');
    });
  } finally {
    for (const s of sockets) s.destroy();
    await mock.close();
  }
});

test('downloadFile: retries transient 503 and rejects non-retryable 401/403/410', async () => {
  let transientAttempts = 0;
  const payload = Buffer.from('recovered-after-503');
  const transientMock = await startMockServer((req, res) => {
    transientAttempts += 1;
    if (transientAttempts === 1) {
      res.writeHead(503);
      res.end('Service Unavailable');
      return;
    }
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    res.end(payload);
  });

  let nonRetryAttempts = 0;
  const forbiddenMock = await startMockServer((req, res) => {
    nonRetryAttempts += 1;
    res.writeHead(403);
    res.end('Forbidden');
  });

  try {
    await withTempDir(async (dir) => {
      const okPath = path.join(dir, 'ok.raw.part');
      const result = await downloadFile({
        url: `${transientMock.baseUrl}/stream.mkv`,
        partPath: okPath,
        retryBaseDelayMs: 10,
      });
      assert.strictEqual(transientAttempts, 2);
      assert.strictEqual(result.bytesWritten, payload.length);

      await assert.rejects(
        () => downloadFile({
          url: `${forbiddenMock.baseUrl}/stream.mkv`,
          partPath: path.join(dir, 'nope.raw.part'),
          retryBaseDelayMs: 10,
        }),
        (err) => err.statusCode === 403 && err.nonRetryable === true
      );
      assert.strictEqual(nonRetryAttempts, 1);
    });
  } finally {
    await transientMock.close();
    await forbiddenMock.close();
  }
});

test('downloadFile: aborts immediately during retry backoff and enforces requestTimeoutMs and maxRedirects', async () => {
  const sockets = new Set();
  let failAttempts = 0;
  const failMock = await startMockServer((req, res) => {
    failAttempts += 1;
    res.writeHead(500);
    res.end('err');
  });

  const stallMock = await startMockServer((req, res) => {
    sockets.add(res.socket);
    res.socket.on('close', () => sockets.delete(res.socket));
    res.writeHead(200, { 'Content-Length': '1000' });
    res.write(Buffer.from('hi'));
  });

  const loopMock = await startMockServer((req, res) => {
    res.writeHead(302, { Location: '/loop' });
    res.end();
  });

  try {
    await withTempDir(async (dir) => {
      // Abort during long retry backoff
      const controller = new AbortController();
      const started = Date.now();
      setTimeout(() => controller.abort(), 30);
      await assert.rejects(
        () => downloadFile({
          url: `${failMock.baseUrl}/fail`,
          partPath: path.join(dir, 'backoff-abort.raw.part'),
          signal: controller.signal,
          maxRetries: 3,
          retryBaseDelayMs: 5000,
        }),
        (err) => err.name === 'AbortError'
      );
      assert.strictEqual(failAttempts, 1);
      assert.ok(Date.now() - started < 500, 'abort during backoff took too long');

      // Request inactivity timeout
      await assert.rejects(
        () => downloadFile({
          url: `${stallMock.baseUrl}/movie/secretUser/secretPass/1.mkv`,
          partPath: path.join(dir, 'timeout.raw.part'),
          requestTimeoutMs: 40,
          maxRetries: 0,
        }),
        (err) => !err.message.includes('secretUser') && !err.message.includes('secretPass')
      );

      // Too many redirects
      await assert.rejects(
        () => downloadFile({
          url: `${loopMock.baseUrl}/loop`,
          partPath: path.join(dir, 'loop.raw.part'),
          maxRedirects: 3,
          maxRetries: 0,
        }),
        (err) => /redirect/i.test(err.message)
      );
    });
  } finally {
    for (const s of sockets) s.destroy();
    await failMock.close();
    await stallMock.close();
    await loopMock.close();
  }
});

test('downloadFile: handles non-retryable 401/410, relative Location redirects, and stalled 206 guard', async () => {
  const payload = Buffer.alloc(128 * 1024);
  for (let i = 0; i < payload.length; i++) payload[i] = (i * 13) & 0xff;

  const statusMock = await startMockServer((req, res) => {
    const code = Number(req.url.slice(1)) || 404;
    res.writeHead(code);
    res.end();
  });

  const relMock = await startMockServer((req, res) => {
    if (req.url === '/start') {
      res.writeHead(302, { Location: '/final/video.mkv' });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Length': String(payload.length) });
    let offset = 0;
    const pump = () => {
      while (offset < payload.length) {
        const end = Math.min(offset + 4096, payload.length);
        const ok = res.write(payload.subarray(offset, end));
        offset = end;
        if (!ok) {
          res.once('drain', pump);
          return;
        }
      }
      res.end();
    };
    pump();
  });

  let stuck206Count = 0;
  const stuck206Mock = await startMockServer((req, res) => {
    stuck206Count += 1;
    res.writeHead(206, {
      'Content-Range': 'bytes 0-255/1024',
      'Content-Length': '256',
    });
    res.end(Buffer.alloc(256, 0xaa));
  });

  try {
    await withTempDir(async (dir) => {
      for (const code of [401, 410]) {
        await assert.rejects(
          () => downloadFile({
            url: `${statusMock.baseUrl}/${code}`,
            partPath: path.join(dir, `err-${code}.raw.part`),
          }),
          (err) => err.statusCode === code && err.nonRetryable === true
        );
      }

      const relPath = path.join(dir, 'rel.raw.part');
      const res = await downloadFile({
        url: `${relMock.baseUrl}/start`,
        partPath: relPath,
      });
      assert.deepStrictEqual(res, { bytesWritten: payload.length, totalBytes: payload.length });
      assert.deepStrictEqual(await fs.promises.readFile(relPath), payload);

      await assert.rejects(
        () => downloadFile({
          url: `${stuck206Mock.baseUrl}/stuck`,
          partPath: path.join(dir, 'stuck.raw.part'),
          maxRetries: 1,
          retryBaseDelayMs: 5,
        }),
        (err) => /forward progress/i.test(err.message)
      );
      assert.strictEqual(stuck206Count, 3); // initial leg1 (0->256), leg2 (no progress), retry1 (no progress)
    });
  } finally {
    await statusMock.close();
    await relMock.close();
    await stuck206Mock.close();
  }
});
