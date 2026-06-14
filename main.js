const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const url = require('url');
const fs = require('fs');

// Enable HEVC hardware decoding switches in Electron/Chromium
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

let mainWindow;
let activeFfmpegProcess = null;
let activeExternalProcess = null;
const metadataCache = new Map();

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    icon: path.join(__dirname, 'assets/logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    title: "Beamcast IPTV"
  });

  mainWindow.webContents.on('console-message', (event, level, message, line, sourceId) => {
    console.log(`[Renderer Console] [Level ${level}] ${message} (${path.basename(sourceId)}:${line})`);
  });

  mainWindow.loadFile('index.html');
}

function createMenu() {
  const template = [
    {
      label: 'File',
      submenu: [
        { role: 'quit' }
      ]
    },
    {
      label: 'Playlists',
      submenu: [
        {
          label: 'Manage Xtream Codes Accounts...',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('show-accounts-modal');
            }
          }
        },
        {
          label: 'M3U Playlist...',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('show-m3u-modal');
            }
          }
        }
      ]
    },
    {
      label: 'Playback',
      submenu: [
        {
          label: 'Stream Info...',
          click: () => {
            showStreamInfoWindow();
          }
        }
      ]
    },
    {
      label: 'View',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    }
  ];

  const menu = Menu.buildFromTemplate(template);
  Menu.setApplicationMenu(menu);
}

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

// Execute ffprobe command with a fallback timeout
function runFfprobeCommand(ffprobeArgs, timeoutMs) {
  return new Promise((resolve, reject) => {
    const ffprobe = spawn('ffprobe', ffprobeArgs);
    let output = '';
    let stderr = '';

    ffprobe.stdout.on('data', (data) => {
      output += data.toString();
    });

    ffprobe.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    ffprobe.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe failed with code ${code}. ${stderr.trim()}`));
        return;
      }
      resolve(output.trim());
    });

    ffprobe.on('error', (err) => {
      reject(err);
    });

    setTimeout(() => {
      try {
        ffprobe.kill('SIGKILL');
      } catch (e) {}
      reject(new Error('ffprobe timed out'));
    }, timeoutMs);
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
    '-timeout', '3000000', // 3 seconds timeout for socket connection
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

// Write CORS and Private Network Access headers
function setCorsHeaders(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');
}

// Build the arguments for the FFmpeg process
function buildFfmpegArgs(targetStreamUrl, isLive, codec, start, clientSupportsHEVC) {
  const ffmpegArgs = ['-loglevel', 'warning'];

  const isTimeshift = targetStreamUrl.toLowerCase().includes('/timeshift/');

  // Add network stream optimization parameters BEFORE -i
  ffmpegArgs.push('-timeout', '5000000'); // 5 seconds connection timeout
  if (isTimeshift) {
    // Timeshift archives are finite: EOF means end of program.
    // Reconnecting at EOF makes the server restart the archive from the
    // beginning, which resets timestamps and makes the player jump back.
    ffmpegArgs.push(
      '-reconnect', '1',
      '-reconnect_delay_max', '2'
    );
  } else {
    ffmpegArgs.push(
      '-reconnect', '1',              // Reconnect on disconnect
      '-reconnect_at_eof', '1',       // Reconnect at EOF
      '-reconnect_streamed', '1',     // Reconnect streamed data
      '-reconnect_delay_max', '5'     // Max delay before reconnecting (5s)
    );
  }

  if (isLive || isTimeshift) {
    ffmpegArgs.push(
      '-probesize', '1000000',        // Limit probe size to 1MB for instant start on live TV/Timeshift
      '-analyzeduration', '1000000'   // Limit analyze duration to 1s for instant start on live TV/Timeshift
    );
    if (isTimeshift) {
      ffmpegArgs.push('-correct_ts_overflow', '1');
      // Allow a fast initial burst (10s worth of content) so the first canplay
      // event fires quickly (especially important after a seek), then throttle
      // to 1.5x realtime to prevent MSE buffer overflow.
      ffmpegArgs.push('-readrate_initial_burst', '10');
      ffmpegArgs.push('-readrate', '1.5');
    }
  } else {
    // For VOD, use larger values to correctly probe Matroska/MKV with multiple tracks/subtitles
    ffmpegArgs.push(
      '-probesize', '15000000',       // 15MB probesize for VOD
      '-analyzeduration', '5000000'   // 5s analyzeduration for VOD
    );
  }

  // Always generate PTS and discard corrupt packets to handle stream discontinuities/sync issues
  if (isTimeshift) {
    ffmpegArgs.push('-fflags', '+genpts+igndts+discardcorrupt');
  } else {
    ffmpegArgs.push('-fflags', '+genpts+discardcorrupt');
  }

  if (start) {
    ffmpegArgs.push('-ss', start.toString()); // Seek input (must be before -i)
  }
  ffmpegArgs.push(
    '-i', targetStreamUrl,
    '-map', '0:v?',          // Map first video stream optionally
    '-map', '0:a?',          // Map first audio stream optionally
    '-sn',                   // Disable subtitle streams to prevent parsing failures
    '-dn'                    // Disable data streams
  );

  if (isLive || isTimeshift) {
    ffmpegArgs.push('-avoid_negative_ts', 'make_zero');
  }

  // Check if video needs transcoding
  const unsupportedCodecs = ['hevc', 'h265', 'mpeg2video', 'vc1', 'mpeg4', 'msmpeg4v3', 'wmv3'];
  let needTranscoding = unsupportedCodecs.includes(codec.toLowerCase());
  
  // If codec detection failed but it's an MKV file on VOD, default to H.264 transcode for safety
  if (codec === 'unknown' && !isLive && targetStreamUrl.toLowerCase().split('?')[0].endsWith('.mkv')) {
    console.warn(`[Proxy] Codec detection failed on VOD MKV stream, defaulting to H.264 transcode for safety.`);
    needTranscoding = true;
  }

  // Force transcoding for timeshift streams to resolve timeline/DTS/PTS discontinuities
  if (isTimeshift) {
    console.log('[Proxy] Timeshift stream detected: forcing H.264 transcode to fix timeline discontinuities.');
    needTranscoding = true;
  }

  // If client supports HEVC natively, we don't need to transcode it
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
      '-pix_fmt', 'yuv420p'  // Force browser-friendly pixel format
    );
  } else {
    console.log(`Copying video stream (codec: ${codec})`);
    ffmpegArgs.push('-c:v', 'copy');
  }

  ffmpegArgs.push(
    '-c:a', 'aac',           // Transcode audio to AAC
    '-b:a', '192k',          // Audio bitrate
    '-ac', '2'               // Downmix to stereo
  );

  if (isLive || isTimeshift) {
    ffmpegArgs.push('-af', 'aresample=async=1'); // Force audio resampling to sync with video frames
  }

  ffmpegArgs.push(
    '-f', 'mpegts',          // MPEG-TS container
    'pipe:1'                 // Output to stdout
  );

  return { ffmpegArgs, needTranscoding };
}

// Handle transcoder / stream requests
function handleStreamRequest(req, res, reqUrl) {
  const targetStreamUrl = reqUrl.query.url;
  const start = reqUrl.query.start; // optional seek start time in seconds

  if (!targetStreamUrl) {
    res.writeHead(400);
    return res.end('Missing stream URL');
  }

  // Terminate any existing transcoding process to save resources
  if (activeFfmpegProcess) {
    console.log('Killing previous FFmpeg process');
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing previous process:', e);
    }
    activeFfmpegProcess = null;
  }

  const isLive = isLiveUrl(targetStreamUrl);

  // Get codec and duration info if VOD, then build ffmpeg command
  getVideoMetadata(targetStreamUrl, isLive).then(({ codec, duration }) => {
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

    // Send transcode status back to the renderer process
    if (mainWindow) {
      mainWindow.webContents.send('transcode-status', {
        url: targetStreamUrl,
        transcoding: needTranscoding,
        codec: codec,
        duration: duration
      });
    }

    console.log(`[FFmpeg Command] ffmpeg ${ffmpegArgs.join(' ')}`);
    
    // Write start header to log file
    const logFilePath = path.join(app.getPath('userData'), 'ffmpeg.log');
    fs.writeFileSync(logFilePath, `--- Playback session started at ${new Date().toISOString()} ---\nURL: ${targetStreamUrl}\nCommand: ffmpeg ${ffmpegArgs.join(' ')}\n\n`);

    // Spawn FFmpeg
    const ffmpeg = spawn('ffmpeg', ffmpegArgs);

    activeFfmpegProcess = ffmpeg;

    ffmpeg.stdout.pipe(res);

    ffmpeg.stderr.on('data', (data) => {
      const msg = data.toString();
      console.error(`FFmpeg stderr: ${msg}`);
      fs.appendFileSync(logFilePath, msg);
    });

    // Track if this response is the one that owns the process
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

// Handle Xtream Codes API requests forwarding
function handleXtreamApiRequest(req, res, reqUrl) {
  const { host, username, password, action, ...extraParams } = reqUrl.query;

  if (!host || !username || !password || !action) {
    res.writeHead(400, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ error: 'Missing required parameters' }));
  }

  // Format target host URL (ensure protocol)
  let targetHost = host.startsWith('http://') || host.startsWith('https://') ? host : `http://${host}`;
  
  // Construct Xtream Codes player_api URL query
  const apiQuery = new URLSearchParams({ username, password, action });
  for (const [key, val] of Object.entries(extraParams)) {
    apiQuery.append(key, val);
  }
  const targetUrl = `${targetHost}/player_api.php?${apiQuery.toString()}`;

  console.log(`Forwarding Xtream Codes API request: ${targetUrl}`);

  fetch(targetUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response.text();
    })
    .then(body => {
      res.writeHead(200, { 
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    })
    .catch(err => {
      console.error('Xtream API Proxy Error:', err);
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch from Xtream server', details: err.message }));
    });
}

// Handle Xtream Codes XMLTV (full EPG dump) forwarding
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

  fetch(targetUrl)
    .then(response => {
      if (!response.ok) throw new Error(`HTTP error! status: ${response.status}`);
      return response.text();
    })
    .then(body => {
      res.writeHead(200, {
        'Content-Type': 'application/xml',
        'Access-Control-Allow-Origin': '*'
      });
      res.end(body);
    })
    .catch(err => {
      console.error('Xtream XMLTV Proxy Error:', err);
      res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to fetch XMLTV from Xtream server', details: err.message }));
    });
}

// Start local HTTP transcoding proxy server
const proxyServer = http.createServer((req, res) => {
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

function launchExternalPlayer(streamUrl, streamName = 'Stream') {
  // 1. Kill active external player process if running
  if (activeExternalProcess) {
    console.log('Killing previous external player process');
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing previous external process:', e);
    }
    activeExternalProcess = null;
  }

  // 2. Kill active internal FFmpeg transcode process if running
  if (activeFfmpegProcess) {
    console.log('Killing active FFmpeg transcode process due to external player launch');
    try {
      activeFfmpegProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing FFmpeg transcode process:', e);
    }
    activeFfmpegProcess = null;
  }

  // 3. Inform renderer that MPV is launching
  if (mainWindow) {
    mainWindow.webContents.send('stop-playback');
    mainWindow.webContents.send('mpv-status-changed', { active: true, name: streamName });
  }

  // 4. Launch MPV
  console.log(`Launching external player (mpv) for stream: ${streamUrl}`);
  const externalProcess = spawn('mpv', [streamUrl], {
    detached: true,
    stdio: 'ignore'
  });
  externalProcess.unref();

  activeExternalProcess = externalProcess;

  externalProcess.on('exit', () => {
    if (activeExternalProcess === externalProcess) {
      activeExternalProcess = null;
      if (mainWindow) {
        mainWindow.webContents.send('mpv-status-changed', { active: false });
      }
    }
  });
}

ipcMain.on('open-in-mpv', (event, data) => {
  launchExternalPlayer(data.url, data.name);
});

ipcMain.on('stop-mpv', () => {
  if (activeExternalProcess) {
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {}
  }
});

ipcMain.on('show-context-menu', (event, { name, url }) => {
  const template = [
    {
      label: `Open "${name}" in MPV`,
      click: () => {
        launchExternalPlayer(url, name);
      }
    }
  ];
  const menu = Menu.buildFromTemplate(template);
  const win = BrowserWindow.fromWebContents(event.sender);
  menu.popup({ window: win });
});

let activeStream = null;
let streamInfoWindow = null;

ipcMain.on('set-playback-active', (event, data) => {
  console.log(`Playback active: ${data.name} (${data.url})`);
  activeStream = data;
  if (activeExternalProcess) {
    console.log('Killing active external player process because internal playback started');
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing external process:', e);
    }
    activeExternalProcess = null;
  }
});

ipcMain.on('set-playback-inactive', () => {
  console.log('Playback inactive');
  activeStream = null;
});

function runFfprobeSpecs(streamUrl) {
  const ffprobeArgs = [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    '-timeout', '5000000', // 5 seconds connection timeout
    streamUrl
  ];

  console.log(`Running full ffprobe on stream: ${streamUrl}`);
  return runFfprobeCommand(ffprobeArgs, 6000).then((output) => {
    return JSON.parse(output);
  });
}

function showStreamInfoWindow() {
  if (streamInfoWindow) {
    streamInfoWindow.focus();
    return;
  }

  streamInfoWindow = new BrowserWindow({
    width: 600,
    height: 500,
    title: "Stream Specifications",
    icon: path.join(__dirname, 'assets/logo.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    parent: mainWindow,
    modal: false,
    resizable: true,
    backgroundColor: '#0a0b10'
  });

  streamInfoWindow.setMenu(null);
  streamInfoWindow.loadFile('stream_info.html');

  streamInfoWindow.on('closed', () => {
    streamInfoWindow = null;
  });
}

ipcMain.on('request-stream-info', (event) => {
  if (!activeStream) {
    event.reply('stream-info-details', { error: 'No active stream playing.' });
    return;
  }

  event.reply('stream-info-details', { 
    loading: true, 
    name: activeStream.name, 
    url: activeStream.url 
  });

  runFfprobeSpecs(activeStream.url).then(specs => {
    if (streamInfoWindow) {
      streamInfoWindow.webContents.send('stream-info-details', {
        loading: false,
        name: activeStream.name,
        url: activeStream.url,
        specs: specs
      });
    }
  }).catch(err => {
    if (streamInfoWindow) {
      streamInfoWindow.webContents.send('stream-info-details', {
        loading: false,
        name: activeStream.name,
        url: activeStream.url,
        error: `Failed to probe stream: ${err.message}`
      });
    }
  });
});

const PORT = 18080;
proxyServer.listen(PORT, '127.0.0.1', () => {
  console.log(`Transcoding proxy server running on http://127.0.0.1:${PORT}`);
});

app.whenReady().then(() => {
  createWindow();
  createMenu();
});

app.on('window-all-closed', () => {
  if (activeFfmpegProcess) {
    activeFfmpegProcess.kill('SIGKILL');
  }
  if (activeExternalProcess) {
    activeExternalProcess.kill('SIGKILL');
  }
  proxyServer.close();
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
