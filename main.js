const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const http = require('http');
const { spawn } = require('child_process');
const path = require('path');
const url = require('url');

// Enable HEVC hardware decoding switches in Electron/Chromium
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

let mainWindow;
let activeFfmpegProcess = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
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

function getVideoCodec(streamUrl, isLive) {
  if (isLive) {
    return Promise.resolve('h264'); // skip detection for live streams for fast zapping
  }
  return new Promise((resolve) => {
    const ffprobeArgs = [
      '-v', 'error',
      '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name',
      '-of', 'default=noprint_wrappers=1:nokey=1',
      '-timeout', '3000000', // 3 seconds timeout for socket connection
      streamUrl
    ];
    
    console.log(`Running ffprobe on stream: ${streamUrl}`);
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
      const codec = output.trim();
      if (code !== 0) {
        console.error(`[ffprobe] failed with code ${code}. Stderr: ${stderr.trim()}`);
      } else {
        console.log(`[ffprobe] detected codec: ${codec || 'unknown'}`);
      }
      resolve(codec || 'unknown');
    });
    
    ffprobe.on('error', (err) => {
      console.error('ffprobe error:', err);
      resolve('unknown');
    });
    
    // Set a fallback timeout of 4 seconds just in case ffprobe hangs
    setTimeout(() => {
      try {
        ffprobe.kill('SIGKILL');
      } catch (e) {}
      resolve('unknown');
    }, 4000);
  });
}

// Start local HTTP transcoding proxy server
const proxyServer = http.createServer((req, res) => {
  // Add CORS and Private Network Access headers
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', '*');
  res.setHeader('Access-Control-Allow-Private-Network', 'true');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const reqUrl = url.parse(req.url, true);
  
  if (reqUrl.pathname === '/stream') {
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

    // Get codec info if VOD, then build ffmpeg command
    getVideoCodec(targetStreamUrl, isLive).then((codec) => {
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

      // Build FFmpeg arguments
      const ffmpegArgs = ['-loglevel', 'warning'];
      
      // Add network stream optimization parameters BEFORE -i
      ffmpegArgs.push(
        '-timeout', '5000000',          // 5 seconds connection timeout
        '-reconnect', '1',              // Reconnect on disconnect
        '-reconnect_at_eof', '1',       // Reconnect at EOF
        '-reconnect_streamed', '1',     // Reconnect streamed data
        '-reconnect_delay_max', '5'     // Max delay before reconnecting (5s)
      );

      if (isLive) {
        ffmpegArgs.push(
          '-probesize', '1000000',        // Limit probe size to 1MB for instant start on live TV
          '-analyzeduration', '1000000'   // Limit analyze duration to 1s for instant start on live TV
        );
      } else {
        // For VOD, use larger values to correctly probe Matroska/MKV with multiple tracks/subtitles
        ffmpegArgs.push(
          '-probesize', '15000000',       // 15MB probesize for VOD
          '-analyzeduration', '5000000'   // 5s analyzeduration for VOD
        );
      }

      if (start) {
        ffmpegArgs.push('-ss', start); // Seek input (must be before -i)
      }
      ffmpegArgs.push(
        '-i', targetStreamUrl,
        '-map', '0:v?',          // Map first video stream optionally
        '-map', '0:a?',          // Map first audio stream optionally
        '-sn',                   // Disable subtitle streams to prevent parsing failures
        '-dn'                    // Disable data streams
      );

      // Check if video needs transcoding
      const unsupportedCodecs = ['hevc', 'h265', 'mpeg2video', 'vc1', 'mpeg4', 'msmpeg4v3', 'wmv3'];
      let needTranscoding = unsupportedCodecs.includes(codec.toLowerCase());
      
      // If codec detection failed but it's an MKV file on VOD, default to H.264 transcode for safety
      if (codec === 'unknown' && !isLive && targetStreamUrl.toLowerCase().split('?')[0].endsWith('.mkv')) {
        console.warn(`[Proxy] Codec detection failed on VOD MKV stream, defaulting to H.264 transcode for safety.`);
        needTranscoding = true;
      }

      // If client supports HEVC natively, we don't need to transcode it
      const clientSupportsHEVC = reqUrl.query.hevc === 'true';
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

      // Send transcode status back to the renderer process
      if (mainWindow) {
        mainWindow.webContents.send('transcode-status', {
          url: targetStreamUrl,
          transcoding: needTranscoding,
          codec: codec
        });
      }

      ffmpegArgs.push(
        '-c:a', 'aac',           // Transcode audio to AAC
        '-b:a', '192k',          // Audio bitrate
        '-ac', '2',              // Downmix to stereo
        '-f', 'mpegts',          // MPEG-TS container
        'pipe:1'                 // Output to stdout
      );

      console.log(`[FFmpeg Command] ffmpeg ${ffmpegArgs.join(' ')}`);
      // Spawn FFmpeg
      const ffmpeg = spawn('ffmpeg', ffmpegArgs);

      activeFfmpegProcess = ffmpeg;

      ffmpeg.stdout.pipe(res);

      ffmpeg.stderr.on('data', (data) => {
        console.error(`FFmpeg stderr: ${data.toString()}`);
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
        if (isCurrentProcess && activeFfmpegProcess === ffmpeg) {
          activeFfmpegProcess = null;
        }
      });
    });

  } else if (reqUrl.pathname === '/xtream/api') {
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

  } else {
    res.writeHead(404);
    res.end('Not Found');
  }
});

ipcMain.on('open-in-mpv', (event, streamUrl) => {
  console.log(`Launching MPV for stream: ${streamUrl}`);
  const mpvProcess = spawn('mpv', [streamUrl], {
    detached: true,
    stdio: 'ignore'
  });
  mpvProcess.unref();
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
