const { app, BrowserWindow, dialog, ipcMain, Menu } = require('electron');
const path = require('path');

// Set application name and userData path to ensure consistency across all environments
app.name = 'beamcast-iptv';
app.setPath('userData', path.join(app.getPath('appData'), 'beamcast-iptv'));

// Import modular services
const proxy = require('./lib/proxy');
const externalPlayer = require('./lib/external-player');
const streamInfo = require('./lib/stream-info');
const help = require('./lib/help');
const downloadManager = require('./lib/download-manager');

// Enable HEVC hardware decoding switches in Electron/Chromium
app.commandLine.appendSwitch('enable-features', 'PlatformHEVCDecoderSupport');
app.commandLine.appendSwitch('enable-accelerated-video-decode');

let mainWindow;
let activeStream = null;
let isClosingConfirmed = false;
let isClosePromptOpen = false;

function createWindow() {
  isClosingConfirmed = false;
  isClosePromptOpen = false;
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

  mainWindow.on('close', async (e) => {
    if (isClosingConfirmed || !downloadManager.hasActiveJobs()) {
      return;
    }

    e.preventDefault();
    if (isClosePromptOpen) {
      return;
    }

    isClosePromptOpen = true;
    try {
      const { response } = await dialog.showMessageBox(mainWindow, {
        type: 'warning',
        title: 'Downloads laufen noch',
        message: 'Downloads laufen noch',
        detail:
          'Es laufen noch aktive Downloads oder Transcodings. Beim Beenden werden laufende Vorgänge abgebrochen und temporäre Dateien gelöscht.',
        buttons: ['Abbrechen (weiterlaufen)', 'Beenden & abbrechen'],
        defaultId: 0,
        cancelId: 0,
      });

      if (response === 1) {
        isClosingConfirmed = true;
        await downloadManager.shutdown();
        if (mainWindow && !mainWindow.isDestroyed()) {
          mainWindow.destroy();
        }
      }
    } finally {
      isClosePromptOpen = false;
    }
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
      label: 'Settings',
      submenu: [
        {
          label: 'Preferences...',
          accelerator: 'CmdOrCtrl+,',
          click: () => {
            if (mainWindow) {
              mainWindow.webContents.send('open-settings');
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
    },
    {
      label: 'Help',
      submenu: [
        {
          label: 'Help & Optimization...',
          accelerator: 'F1',
          click: () => {
            help.showHelpWindow();
          }
        }
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

  const getMainWindow = () => {
    return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  };
  const getActiveStream = () => activeStream;

  // Initialize helper modules
  proxy.init(getMainWindow, app.getPath('userData'));
  externalPlayer.init(getMainWindow, () => proxy.killActiveFfmpeg());
  streamInfo.init(getMainWindow, proxy.runFfprobeCommand, getActiveStream);
  help.init(getMainWindow);
  downloadManager.init(getMainWindow, app);

  ipcMain.handle('download:open-in-mpv', (_e, filePath) => externalPlayer.openLocalFileInMpv(filePath));
});

app.on('window-all-closed', () => {
  proxy.killActiveFfmpeg();
  externalPlayer.killActiveExternal();
  streamInfo.closeWindow();
  help.closeWindow();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  proxy.stop();
  downloadManager.shutdown().catch((err) => {
    console.error('Error shutting down download manager:', err);
  });
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
