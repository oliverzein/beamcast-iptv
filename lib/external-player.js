const fs = require('fs');
const { spawn } = require('child_process');
const { ipcMain, Menu, BrowserWindow, dialog } = require('electron');

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
  console.log(`[MPV Command] mpv "${streamUrl}"`);
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
    launchExternalPlayer(data.url, data.name);
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
  openLocalFileInMpv
};
