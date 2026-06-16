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
