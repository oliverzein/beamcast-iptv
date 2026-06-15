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
  if (streamInfoWindow && !streamInfoWindow.isDestroyed()) {
    streamInfoWindow.close();
  }
  streamInfoWindow = null;
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
      if (streamInfoWindow && !streamInfoWindow.isDestroyed()) {
        streamInfoWindow.webContents.send('stream-info-details', {
          loading: false,
          name: activeStream.name,
          url: activeStream.url,
          specs: specs
        });
      }
    }).catch(err => {
      if (streamInfoWindow && !streamInfoWindow.isDestroyed()) {
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
