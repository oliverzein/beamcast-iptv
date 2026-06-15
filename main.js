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

  const getMainWindow = () => {
    return (mainWindow && !mainWindow.isDestroyed()) ? mainWindow : null;
  };
  const getActiveStream = () => activeStream;

  // Initialize helper modules
  proxy.init(getMainWindow, app.getPath('userData'));
  externalPlayer.init(getMainWindow, () => proxy.killActiveFfmpeg());
  streamInfo.init(getMainWindow, proxy.runFfprobeCommand, getActiveStream);
});

app.on('window-all-closed', () => {
  proxy.killActiveFfmpeg();
  externalPlayer.killActiveExternal();
  streamInfo.closeWindow();
  
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

app.on('will-quit', () => {
  proxy.stop();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow();
  }
});
