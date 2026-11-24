const fs = require('fs');
const { spawn } = require('child_process');
const { ipcMain, Menu, BrowserWindow, dialog } = require('electron');

let activeExternalProcess = null;
let getMainWindowRef = null;
let killActiveFfmpegRef = null;
let isIntentionalKill = false;

function extractMpvErrorMessage(lines) {
  if (!lines || lines.length === 0) return 'MPV beendet mit Fehler (keine Details verfügbar).';

  const meaningful = lines.filter(l =>
    !l.includes('ytdl_hook') &&
    !l.includes('youtube-dl failed') &&
    !l.includes('Subprocess failed: init')
  );

  const relevant = meaningful.length > 0 ? meaningful : lines;

  const errorLines = relevant.filter(l =>
    l.includes('[curl]') ||
    l.toLowerCase().includes('failed to open') ||
    l.toLowerCase().includes('http error') ||
    l.toLowerCase().includes('connection refused') ||
    l.toLowerCase().includes('server error') ||
    l.toLowerCase().includes('error')
  );

  if (errorLines.length > 0) {
    return errorLines.slice(-4).join('\n');
  }

  return relevant.slice(-4).join('\n');
}

const DEFAULT_MPV_OPTIONS = {
  mpvCachePauseInitial: 'yes',
  mpvCachePauseWait: 5,
  mpvForceSeekable: 'yes',
  mpvExtraArgs: ''
};

let currentMpvOptions = { ...DEFAULT_MPV_OPTIONS };

function setMpvOptions(options) {
  if (options && typeof options === 'object') {
    currentMpvOptions = {
      ...currentMpvOptions,
      ...options
    };
  }
}

function parseCommandLineArgs(str) {
  if (!str || typeof str !== 'string') return [];
  const matches = str.match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g);
  if (!matches) return [];
  return matches.map(arg => {
    return arg
      .replace(/^"([^"]*)"$/, '$1')
      .replace(/^'([^']*)'$/, '$1')
      .replace(/=(["'])(.*?)\1$/, '=$2');
  });
}

function buildMpvArgs(streamUrl, customOptions = {}) {
  const opts = { ...currentMpvOptions, ...customOptions };
  const args = [];

  if (opts.mpvCachePauseInitial === 'yes' || opts.mpvCachePauseInitial === true) {
    args.push('--cache-pause-initial=yes');
  } else if (opts.mpvCachePauseInitial === 'no' || opts.mpvCachePauseInitial === false) {
    args.push('--cache-pause-initial=no');
  }

  const pauseWait = Number(opts.mpvCachePauseWait);
  if (!Number.isNaN(pauseWait) && pauseWait >= 0) {
    args.push(`--cache-pause-wait=${pauseWait}`);
  }

  if (opts.mpvForceSeekable === 'yes' || opts.mpvForceSeekable === true) {
    args.push('--force-seekable=yes');
  }

  if (typeof opts.mpvExtraArgs === 'string' && opts.mpvExtraArgs.trim()) {
    const extra = parseCommandLineArgs(opts.mpvExtraArgs.trim());
    if (extra.length > 0) {
      args.push(...extra);
    }
  }

  args.push(streamUrl);
  return args;
}

function launchExternalPlayer(streamUrl, streamName = 'Stream', options = {}) {
  if (activeExternalProcess) {
    console.log('Killing previous external player process');
    isIntentionalKill = true;
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
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('stop-playback');
    mainWindow.webContents.send('mpv-status-changed', { active: true, name: streamName });
  }

  const args = buildMpvArgs(streamUrl, options);
  console.log(`Launching external player (mpv) for stream: ${streamUrl}`);
  console.log(`[MPV Command] mpv ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);

  isIntentionalKill = false;
  let errorBuffer = [];
  const collectOutput = (chunk) => {
    if (!chunk) return;
    const lines = chunk.toString().split(/\r?\n/).map(l => l.trim()).filter(Boolean);
    errorBuffer.push(...lines);
    if (errorBuffer.length > 50) {
      errorBuffer = errorBuffer.slice(-50);
    }
  };

  const externalProcess = spawn('mpv', args, {
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  if (externalProcess.stdout) externalProcess.stdout.on('data', collectOutput);
  if (externalProcess.stderr) externalProcess.stderr.on('data', collectOutput);

  externalProcess.unref();
  activeExternalProcess = externalProcess;

  externalProcess.on('exit', (code, signal) => {
    const wasIntentional = isIntentionalKill;
    isIntentionalKill = false;

    if (activeExternalProcess === externalProcess) {
      activeExternalProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        if (code !== 0 && !wasIntentional && signal !== 'SIGKILL' && signal !== 'SIGTERM') {
          const errorMsg = extractMpvErrorMessage(errorBuffer);
          console.error(`[MPV Exit Error] Code ${code}, Signal ${signal}:\n${errorMsg}`);
          mainWindow.webContents.send('mpv-status-changed', {
            active: false,
            error: errorMsg,
            name: streamName,
            code
          });
        } else {
          mainWindow.webContents.send('mpv-status-changed', { active: false });
        }
      }
    }
  });

  externalProcess.on('error', (err) => {
    console.error('Failed to start external player (mpv):', err);
    if (activeExternalProcess === externalProcess) {
      activeExternalProcess = null;
      if (mainWindow && !mainWindow.isDestroyed()) {
        mainWindow.webContents.send('mpv-status-changed', {
          active: false,
          error: `MPV konnte nicht gestartet werden: ${err.message}`,
          name: streamName
        });
      }
    }
    dialog.showErrorBox(
      'External Player Error',
      `Failed to start mpv player. Please make sure mpv is installed and available in your system PATH.\n\nError details: ${err.message}`
    );
  });
}

function killActiveExternal() {
  if (activeExternalProcess) {
    console.log('Killing active external player process');
    isIntentionalKill = true;
    try {
      activeExternalProcess.kill('SIGKILL');
    } catch (e) {}
  }
}

function openLocalFileInMpv(filePath) {
  if (!filePath || typeof filePath !== 'string') {
    return { ok: false, error: 'Datei nicht gefunden.' };
  }

  try {
    if (!fs.statSync(filePath).isFile()) {
      return { ok: false, error: 'Datei nicht gefunden.' };
    }
  } catch {
    return { ok: false, error: 'Datei nicht gefunden.' };
  }

  try {
    console.log(`Launching local player (mpv) for file: ${filePath}`);
    const localProcess = spawn('mpv', [filePath], {
      detached: true,
      stdio: 'ignore'
    });

    localProcess.on('error', (err) => {
      console.error('Failed to start local player (mpv):', err);
      if (dialog && typeof dialog.showErrorBox === 'function') {
        dialog.showErrorBox(
          'External Player Error',
          `Failed to start mpv player. Please make sure mpv is installed and available in your system PATH.\n\nError details: ${err.message}`
        );
      }
    });

    localProcess.unref();
    return { ok: true };
  } catch (err) {
    console.error('Failed to start local player (mpv):', err);
    return { ok: false, error: err.message };
  }
}

function init(getMainWindow, killActiveFfmpeg) {
  getMainWindowRef = getMainWindow;
  killActiveFfmpegRef = killActiveFfmpeg;

  ipcMain.on('open-in-mpv', (event, data) => {
    const url = typeof data === 'string' ? data : data?.url;
    const name = typeof data === 'object' && data?.name ? data.name : 'Stream';
    const options = typeof data === 'object' && data?.options ? data.options : {};
    launchExternalPlayer(url, name, options);
  });

  ipcMain.on('update-mpv-options', (event, options) => {
    setMpvOptions(options);
  });

  ipcMain.on('stop-mpv', () => {
    killActiveExternal();
  });

  ipcMain.on('show-context-menu', (event, { name, url, meta } = {}) => {
    const template = [
      {
        label: `Open "${name}" in MPV`,
        click: () => {
          launchExternalPlayer(url, name);
        }
      }
    ];
    if (meta && meta.downloadable) {
      template.push(
        { type: 'separator' },
        {
          label: '⬇ Herunterladen (Standard)',
          click: () => {
            if (!event.sender?.isDestroyed?.()) {
              event.sender.send('context-menu-download', { item: meta, mode: 'default' });
            }
          }
        },
        {
          label: '⚙ Herunterladen mit Optionen...',
          click: () => {
            if (!event.sender?.isDestroyed?.()) {
              event.sender.send('context-menu-download', { item: meta, mode: 'options' });
            }
          }
        }
      );
    }
    const menu = Menu.buildFromTemplate(template);
    const win = BrowserWindow.fromWebContents(event.sender);
    menu.popup({ window: win });
  });
}

module.exports = {
  init,
  killActiveExternal,
  openLocalFileInMpv,
  buildMpvArgs,
  setMpvOptions,
  extractMpvErrorMessage,
  DEFAULT_MPV_OPTIONS
};
