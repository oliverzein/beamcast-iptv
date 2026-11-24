const fs = require('fs');
const { spawn } = require('child_process');
const { ipcMain, Menu, BrowserWindow, dialog } = require('electron');

let activeExternalProcess = null;
let getMainWindowRef = null;
let killActiveFfmpegRef = null;

const DEFAULT_MPV_OPTIONS = {
  mpvDemuxerMaxBytes: 500,
  mpvDemuxerReadaheadSecs: 30,
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
  const args = ['--cache=yes'];

  const maxBytes = Number(opts.mpvDemuxerMaxBytes);
  if (!Number.isNaN(maxBytes) && maxBytes > 0) {
    args.push(`--demuxer-max-bytes=${maxBytes}M`);
  }

  const readaheadSecs = Number(opts.mpvDemuxerReadaheadSecs);
  if (!Number.isNaN(readaheadSecs) && readaheadSecs > 0) {
    args.push(`--demuxer-readahead-secs=${readaheadSecs}`);
  }

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

  const args = buildMpvArgs(streamUrl, options);
  console.log(`Launching external player (mpv) for stream: ${streamUrl}`);
  console.log(`[MPV Command] mpv ${args.map(a => a.includes(' ') ? `"${a}"` : a).join(' ')}`);
  const externalProcess = spawn('mpv', args, {
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

  externalProcess.on('error', (err) => {
    console.error('Failed to start external player (mpv):', err);
    if (activeExternalProcess === externalProcess) {
      activeExternalProcess = null;
      if (mainWindow) {
        mainWindow.webContents.send('mpv-status-changed', { active: false });
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
  DEFAULT_MPV_OPTIONS
};
