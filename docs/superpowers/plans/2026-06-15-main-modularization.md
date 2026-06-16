# main.js Modularization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Clean up monolithic `main.js` by refactoring code into modular helpers in a dedicated `lib/` directory.

**Architecture:** Create three distinct modules (`proxy.js`, `external-player.js`, `stream-info.js`) under a new `lib/` directory, exposing initialization APIs to register IPC event listeners and share functions cleanly. Maintain only basic app lifecycle, window management, and playback state coordination in `main.js`.

**Tech Stack:** Node.js (Child Process, HTTP, Path, URL, FS), Electron (BrowserWindow, ipcMain, Menu).

---

### Task 1: Create HTTP Proxy & Transcoder Module

**Files:**
- Create: `lib/proxy.js`

- [ ] **Step 1: Write `lib/proxy.js`**

Create `lib/proxy.js` containing HTTP Server initialization, Xtream Codes API/XMLTV proxy, FFmpeg/FFprobe subprocess spawning, argument building, and log writing:

```javascript
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
      fs.appendFileSync(logFilePath, msg);
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
      res.writeHead(200, { 'Access-Control-Allow-Origin': '*', ...successHeaders });
      res.end(body);
    })
    .catch(err => {
      console.error(`[proxyFetch] ${targetUrl}: ${err.message}`);
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
```

- [ ] **Step 2: Run syntax verification**

Run: `node -c lib/proxy.js`
Expected: No errors

---

### Task 2: Create External Player Module

**Files:**
- Create: `lib/external-player.js`

- [ ] **Step 1: Write `lib/external-player.js`**

Create `lib/external-player.js` containing MPV spawning, IPC listening (`open-in-mpv`, `stop-mpv`), and external player context menu building:

```javascript
const { spawn } = require('child_process');
const { ipcMain, Menu, BrowserWindow } = require('electron');

let activeExternalProcess = null;
let getMainWindowRef = null;
let killActiveFfmpegRef = null;

function launchExternalPlayer(streamUrl, streamName = 'Stream') {
  if (activeExternalProcess) {
    console.log('Killing previous external player process');
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {
      console.error('Error killing previous external process:', e);
    }
    activeExternalProcess = null;
  }

  if (killActiveFfmpegRef) {
    console.log('Killing active FFmpeg transcode process due to external player launch');
    killActiveFfmpegRef();
  }

  const mainWindow = getMainWindowRef ? getMainWindowRef() : null;
  if (mainWindow) {
    mainWindow.webContents.send('stop-playback');
    mainWindow.webContents.send('mpv-status-changed', { active: true, name: streamName });
  }

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

function killActiveExternal() {
  if (activeExternalProcess) {
    console.log('Killing active external player process');
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {}
    activeExternalProcess = null;
  }
}

function init(getMainWindow, killActiveFfmpeg) {
  getMainWindowRef = getMainWindow;
  killActiveFfmpegRef = killActiveFfmpeg;

  ipcMain.on('open-in-mpv', (event, data) => {
    launchExternalPlayer(data.url, data.name);
  });

  ipcMain.on('stop-mpv', () => {
    killActiveExternal();
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
}

module.exports = {
  init,
  killActiveExternal
};
```

- [ ] **Step 2: Run syntax verification**

Run: `node -c lib/external-player.js`
Expected: No errors

---

### Task 3: Create Stream Specs Info Window Module

**Files:**
- Create: `lib/stream-info.js`

- [ ] **Step 1: Write `lib/stream-info.js`**

Create `lib/stream-info.js` containing Stream Specifications window management, querying full specifications via ffprobe, and answering the `request-stream-info` IPC trigger:

```javascript
const { BrowserWindow, ipcMain } = require('electron');
const path = require('path');

let streamInfoWindow = null;
let getMainWindowRef = null;
let runFfprobeCommandRef = null;

function runFfprobeSpecs(streamUrl) {
  const ffprobeArgs = [
    '-v', 'error',
    '-show_format',
    '-show_streams',
    '-of', 'json',
    '-timeout', '5000000',
    streamUrl
  ];

  console.log(`Running full ffprobe on stream: ${streamUrl}`);
  if (runFfprobeCommandRef) {
    return runFfprobeCommandRef(ffprobeArgs, 6000).then((output) => {
      return JSON.parse(output);
    });
  }
  return Promise.reject(new Error('ffprobe utility not initialized'));
}

function showStreamInfoWindow() {
  if (streamInfoWindow) {
    streamInfoWindow.focus();
    return;
  }

  const mainWindow = getMainWindowRef ? getMainWindowRef() : null;

  streamInfoWindow = new BrowserWindow({
    width: 600,
    height: 500,
    title: "Stream Specifications",
    icon: path.join(__dirname, '..', 'assets/logo.png'),
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
    parent: mainWindow,
    modal: false,
    resizable: true,
    backgroundColor: '#0a0b10'
  });

  streamInfoWindow.setMenu(null);
  streamInfoWindow.loadFile(path.join(__dirname, '..', 'stream_info.html'));

  streamInfoWindow.on('closed', () => {
    streamInfoWindow = null;
  });
}

function closeWindow() {
  if (streamInfoWindow) {
    streamInfoWindow.close();
    streamInfoWindow = null;
  }
}

function init(getMainWindow, runFfprobeCommand, getActiveStream) {
  getMainWindowRef = getMainWindow;
  runFfprobeCommandRef = runFfprobeCommand;

  ipcMain.on('request-stream-info', (event) => {
    const activeStream = getActiveStream();
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
}

module.exports = {
  init,
  showStreamInfoWindow,
  closeWindow
};
```

- [ ] **Step 2: Run syntax verification**

Run: `node -c lib/stream-info.js`
Expected: No errors

---

### Task 4: Refactor main.js Entrypoint

**Files:**
- Modify: `main.js`

- [ ] **Step 1: Update `main.js`**

Rewrite `main.js` to clear out all refactored logic, load the modularized files from `lib/`, and coordinate events:

```javascript
const { app, BrowserWindow, ipcMain, Menu } = require('electron');
const path = require('path');

// Import modular services
const proxy = require('./lib/proxy');
const externalPlayer = require('./lib/external-player');
const streamInfo = require('./lib/stream-info');

// Enable HEVC hardware decoding switches in Electron/Chromium
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

let mainWindow;
let activeStream = null;

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
            streamInfo.showStreamInfoWindow();
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

// Coordinate playback states
ipcMain.on('set-playback-active', (event, data) => {
  console.log(`Playback active: ${data.name} (${data.url})`);
  activeStream = data;
  externalPlayer.killActiveExternal();
});

ipcMain.on('set-playback-inactive', () => {
  console.log('Playback inactive');
  activeStream = null;
});

// App Startup & Lifecycle
app.whenReady().then(() => {
  createWindow();
  createMenu();

  const getMainWindow = () => mainWindow;
  const getActiveStream = () => activeStream;

  // Initialize helper modules
  proxy.init(getMainWindow, app.getPath('userData'));
  externalPlayer.init(getMainWindow, () => proxy.killActiveFfmpeg());
  streamInfo.init(getMainWindow, proxy.runFfprobeCommand, getActiveStream);
});

app.on('window-all-closed', () => {
  proxy.stop();
  externalPlayer.killActiveExternal();
  streamInfo.closeWindow();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
```

- [ ] **Step 2: Run syntax verification on all files**

Run: `node -c main.js && node -c lib/proxy.js && node -c lib/external-player.js && node -c lib/stream-info.js`
Expected: Exits clean (no output)

---

### Task 5: Integration Testing & Verification

- [ ] **Step 1: Launch dev build**

Run: `npm start`
Expected: App starts, main window opens, menu builds successfully.

- [ ] **Step 2: Test internal stream playback (Transcoder Proxy)**
1. Open active IPTV playlist.
2. Select and play a channel.
3. Verify stream plays correctly.
4. Verify console logs indicate active transcoding status / bypass.

- [ ] **Step 3: Test external playback (MPV integration)**
1. Right click on a channel.
2. Select "Open in MPV".
3. Verify MPV starts and plays.
4. Verify internal video playback shuts down.
5. In app menu, click Playback -> Stream Info...
6. Verify "No active stream playing" message is shown (since play is external).
7. Select play inside the app again.
8. Verify MPV process is automatically killed.

- [ ] **Step 4: Test Stream Specifications window**
1. Play a channel inside the app.
2. In app menu, click Playback -> Stream Info...
3. Verify the details window opens and correctly queries/shows the codecs and formats.

- [ ] **Step 5: Code quality analysis check**
Run: `npx fallow health --file-scores`
Verify all scores look correct.
