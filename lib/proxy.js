const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const url = require('url');
const fs = require('fs');

let activeFfmpegProcess = null;
const metadataCache = new Map();
let getMainWindowRef = null;
let userDataPathRef = null;
let proxyServer = null;
let latestRequestId = 0;

function isLiveUrl(streamUrl) {
  try {
    const parsed = url.parse(streamUrl);
    const pathname = (parsed.pathname || '').toLowerCase();
    
    if (pathname.includes('/timeshift/')) {
      return false;
    }
    
    // Check Xtream Codes paths
    if (pathname.includes('/live/')) {
      return true;
    }
    if (pathname.includes('/series/') || pathname.includes('/movie/')) {
      return false;
    }
    
    // Check extension
    const ext = path.extname(pathname);
    if (['.mkv', '.mp4', '.avi', '.mov', '.m4v'].includes(ext)) {
      return false;
    }
    
    return true; // default to true for live zapping
  } catch (e) {
    return true;
  }
}

function runFfprobeCommand(ffprobeArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ffprobeArgs);
    let output = '';
    let stderr = '';
    let finished = false;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try {
        ffprobe.kill('SIGKILL');
      } catch (e) {}
      reject(new Error('ffprobe timed out'));
    }, timeoutMs);

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}. ${stderr.trim()}`));
        return;
      }
      resolve(output.trim());
    });

    ffprobe.on('error', (err) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      reject(err);
    });
  });
}

function getVideoMetadata(streamUrl, isLive) {
  if (isLive || streamUrl.toLowerCase().includes('/timeshift/')) {
    return Promise.resolve({ codec: 'h264', duration: 0 });
  }
  if (metadataCache.has(streamUrl)) {
    console.log(`[Proxy Cache] Hit for metadata of stream: ${streamUrl}`);
    return Promise.resolve(metadataCache.get(streamUrl));
  }
  const ffprobeArgs = [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=codec_name:format=duration',
    '-of', 'json',
    '-timeout', '3000000',
    streamUrl
  ];
  
  console.log(`Running ffprobe on stream: ${streamUrl}`);
  return runFfprobeCommand(ffprobeArgs, 4000)
    .then((output) => {
      try {
        const data = JSON.parse(output);
        const codec = data.streams && data.streams[0] && data.streams[0].codec_name ? data.streams[0].codec_name : 'unknown';
        const duration = data.format && data.format.duration ? parseFloat(data.format.duration) : 0;
        console.log(`[ffprobe] detected codec: ${codec}, duration: ${duration}`);
        const result = { codec, duration };
        metadataCache.set(streamUrl, result);
        return result;
      } catch (e) {
        console.error('[ffprobe] failed to parse JSON output:', e);
        return { codec: 'unknown', duration: 0 };
      }
    })
    .catch((err) => {
      console.error('[ffprobe] error detecting video metadata:', err);
      return { codec: 'unknown', duration: 0 };
    });
}

function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

function buildReconnectArgs(ffmpegArgs, isTimeshift) {
  ffmpegArgs.push('-timeout', '5000000');
  if (isTimeshift) {
    ffmpegArgs.push(
      '-reconnect', '1',
      '-reconnect_delay_max', '2'
    );
  } else {
    ffmpegArgs.push(
      '-reconnect', '1',
      '-reconnect_at_eof', '1',
      '-reconnect_streamed', '1',
      '-reconnect_delay_max', '5'
    );
  }
}

function buildProbeArgs(ffmpegArgs, isLive, isTimeshift) {
  if (isLive || isTimeshift) {
    ffmpegArgs.push(
      '-probesize', '1000000',
      '-analyzeduration', '1000000'
    );
    if (isTimeshift) {
      ffmpegArgs.push('-correct_ts_overflow', '1');
      ffmpegArgs.push('-readrate_initial_burst', '10');
      ffmpegArgs.push('-readrate', '1.5');
    }
  } else {
    ffmpegArgs.push(
      '-probesize', '15000000',
      '-analyzeduration', '5000000'
    );
  }
}

function buildVideoArgs(ffmpegArgs, codec, isLive, isTimeshift, targetStreamUrl, clientSupportsHEVC) {
  const unsupportedCodecs = ['hevc', 'h265', 'mpeg2video', 'vc1', 'mpeg4', 'msmpeg4v3', 'wmv3'];
  let needTranscoding = unsupportedCodecs.includes(codec.toLowerCase());

  if (codec === 'unknown' && !isLive && targetStreamUrl.toLowerCase().split('?')[0].endsWith('.mkv')) {
    console.warn(`[Proxy] Codec detection failed on VOD MKV stream, defaulting to H.264 transcode for safety.`);
    needTranscoding = true;
  }

  if (isTimeshift) {
    console.log('[Proxy] Timeshift stream detected: forcing H.264 transcode to fix timeline discontinuities.');
    needTranscoding = true;
  }

  if (needTranscoding && (codec.toLowerCase() === 'hevc' || codec.toLowerCase() === 'h265') && clientSupportsHEVC) {
    console.log('[Proxy] Client supports HEVC natively, bypassing transcoding and using copy mode.');
    needTranscoding = false;
  }

  if (needTranscoding) {
    console.log(`Transcoding video from ${codec} to h264`);
    ffmpegArgs.push(
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-crf', '26',
      '-tune', 'zerolatency',
      '-pix_fmt', 'yuv420p'
    );
  } else {
    console.log(`Copying video stream (codec: ${codec})`);
    ffmpegArgs.push('-c:v', 'copy');
  }
  return needTranscoding;
}

function buildAudioArgs(ffmpegArgs, isLive, isTimeshift) {
  ffmpegArgs.push(
    '-c:a', 'aac',
    '-b:a', '192k',
    '-ac', '2'
  );
  if (isLive || isTimeshift) {
    ffmpegArgs.push('-af', 'aresample=async=1');
  }
}

function buildFfmpegArgs(targetStreamUrl, isLive, codec, start, clientSupportsHEVC) {
  const ffmpegArgs = ['-loglevel', 'warning'];
  const isTimeshift = targetStreamUrl.toLowerCase().includes('/timeshift/');

  buildReconnectArgs(ffmpegArgs, isTimeshift);
  buildProbeArgs(ffmpegArgs, isLive, isTimeshift);

  if (isTimeshift) {
    ffmpegArgs.push('-fflags', '+genpts+igndts+discardcorrupt');
  } else {
    ffmpegArgs.push('-fflags', '+genpts+discardcorrupt');
  }

  if (start) {
    ffmpegArgs.push('-ss', start.toString());
  }
  ffmpegArgs.push(
    '-i', targetStreamUrl,
    '-map', '0:v?',
    '-map', '0:a?',
    '-sn',
    '-dn'
  );

  if (isLive || isTimeshift) {
    ffmpegArgs.push('-avoid_negative_ts', 'make_zero');
  }

  const needTranscoding = buildVideoArgs(ffmpegArgs, codec, isLive, isTimeshift, targetStreamUrl, clientSupportsHEVC);
  buildAudioArgs(ffmpegArgs, isLive, isTimeshift);

  ffmpegArgs.push(
    '-f', 'mpegts',
    'pipe:1'
  );

  return { ffmpegArgs, needTranscoding };
}

function handleStreamRequest(req, res, reqUrl) {
  const targetStreamUrl = reqUrl.query.url;
  const start = reqUrl.query.start;

  if (!targetStreamUrl) {
    res.writeHead(400);
    return res.end('Missing stream URL');
  }

  killActiveFfmpeg();

  const isLive = isLiveUrl(targetStreamUrl);

  latestRequestId++;
  const currentRequestId = latestRequestId;

  getVideoMetadata(targetStreamUrl, isLive).then(({ codec, duration }) => {
    if (currentRequestId !== latestRequestId) {
      console.log('Discarding outdated stream request');
      res.end();
      return;
    }

    if (req.destroyed) {
      console.log('Client closed connection during codec detection');
      return;
    }

    res.writeHead(200, {
      'Content-Type': 'video/mp2t',
      'Connection': 'keep-alive',
      'Transfer-Encoding': 'chunked'
    });

    console.log(`Transcoding stream (${codec}): ${targetStreamUrl}${start ? ` starting at ${start}s` : ''}`);

    const clientSupportsHEVC = reqUrl.query.hevc === 'true';
    const { ffmpegArgs, needTranscoding } = buildFfmpegArgs(targetStreamUrl, isLive, codec, start, clientSupportsHEVC);

    const mainWindow = getMainWindowRef ? getMainWindowRef() : null;
    if (mainWindow) {
      mainWindow.webContents.send('transcode-status', {
        url: targetStreamUrl,
        transcoding: needTranscoding,
        codec: codec,
        duration: duration
      });
    }

    console.log(`[FFmpeg Command] ffmpeg ${ffmpegArgs.join(' ')}`);
    
    const logFilePath = path.join(userDataPathRef || '', 'ffmpeg.log');
    fs.writeFileSync(logFilePath, `--- Playback session started at ${new Date().toISOString()} ---\nURL: ${targetStreamUrl}\nCommand: ffmpeg ${ffmpegArgs.join(' ')}\n\n`);

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    activeFfmpegProcess = ffmpeg;

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      console.error(`FFmpeg stderr: ${msg}`);
      fs.appendFile(logFilePath, msg, () => {});
    });

    let isCurrentProcess = true;

    req.on('close', () => {
      console.log('Client closed connection');
      if (isCurrentProcess && activeFfmpegProcess === ffmpeg) {
        console.log('Killing FFmpeg process for closed connection');
        try {
          ffmpeg.kill('SIGKILL');
        } catch (e) {}
        activeFfmpegProcess = null;
      }
      isCurrentProcess = false;
    });

    ffmpeg.on('error', (err) => {
      console.error('FFmpeg process error:', err);
      res.end();
    });

    ffmpeg.on('exit', (code) => {
      console.log(`FFmpeg exited with code ${code}`);
      fs.appendFileSync(logFilePath, `\n--- FFmpeg exited with code ${code} ---\n`);
      if (isCurrentProcess && activeFfmpegProcess === ffmpeg) {
        activeFfmpegProcess = null;
      }
    });
  });
}

function proxyFetch(targetUrl, res, successHeaders, errCode) {
  fetch(targetUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response.text();
    })
    .then(body => {
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', ...successHeaders });
      res.end(body);
    })
    .catch(err => {
      console.error(`[proxyFetch] ${targetUrl}: ${err.message}`);
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(errCode, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Proxy fetch failed', details: err.message }));
    });
}

function handleXtreamApiRequest(req, res, reqUrl) {
  const { host, username, password, action, ...extraParams } = reqUrl.query;

  if (!host || !username || !password || !action) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required parameters' }));
  }

  let targetHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
  
  const apiQuery = new URLSearchParams({ username, password, action });
  for (const [key, val] of Object.entries(extraParams)) {
    apiQuery.append(key, val);
  }
  const targetUrl = `${targetHost}/player_api.php?${apiQuery.toString()}`;

  console.log(`Forwarding Xtream Codes API request: ${targetUrl}`);
  proxyFetch(targetUrl, res, { 'Content-Type': 'application/json' }, 500);
}

function handleXtreamXmltvRequest(req, res, reqUrl) {
  const { host, username, password } = reqUrl.query;

  if (!host || !username || !password) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required parameters' }));
  }

  const targetHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
  const query = new URLSearchParams({ username, password });
  const targetUrl = `${targetHost}/xmltv.php?${query.toString()}`;

  console.log(`Forwarding Xtream XMLTV request: ${targetUrl}`);
  proxyFetch(targetUrl, res, { 'Content-Type': 'application/xml' }, 502);
}

function killActiveFfmpeg() {
  if (activeFfmpegProcess) {
    console.log('Killing active FFmpeg process');
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing active FFmpeg process:', e);
    }
    activeFfmpegProcess = null;
  }
}

function init(getMainWindow, userDataPath) {
  getMainWindowRef = getMainWindow;
  userDataPathRef = userDataPath;

  proxyServer = http.createServer((req, res) => {
    setCorsHeaders(res);

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return;
    }

    const reqUrl = url.parse(req.url, true);
    
    if (reqUrl.pathname === '/stream') {
      handleStreamRequest(req, res, reqUrl);
    } else if (reqUrl.pathname === '/xtream/api') {
      handleXtreamApiRequest(req, res, reqUrl);
    } else if (reqUrl.pathname === '/xtream/xmltv') {
      handleXtreamXmltvRequest(req, res, reqUrl);
    } else {
      res.writeHead(404);
      res.end('Not Found');
    }
  });

  const PORT = 18080;
  proxyServer.listen(PORT, '127.0.0.1', () => {
    console.log(`Transcoding proxy server running on http://127.0.0.1:${PORT}`);
  });
}

function stop() {
  killActiveFfmpeg();
  if (proxyServer) {
    proxyServer.close();
    proxyServer = null;
  }
}

module.exports = {
  init,
  killActiveFfmpeg,
  stop,
  runFfprobeCommand
};
