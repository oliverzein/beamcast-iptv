const { BrowserWindow } = require('electron');
const path = require('path');

let helpWindow = null;
let getMainWindowRef = null;

function showHelpWindow() {
  if (helpWindow) {
    helpWindow.focus();
    return;
  }

  const mainWindow = getMainWindowRef ? getMainWindowRef() : null;

  helpWindow = new BrowserWindow({
    width: 750,
    height: 650,
    title: "Beamcast IPTV Help & Optimization",
    icon: path.join(__dirname, '..', 'assets/logo.png'),
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
    },
    parent: mainWindow,
    modal: false,
    resizable: true,
    backgroundColor: '#0a0b10'
  });

  helpWindow.setMenu(null);
  helpWindow.loadFile(path.join(__dirname, '..', 'help.html'));

  helpWindow.on('closed', () => {
    helpWindow = null;
  });
}

function closeWindow() {
  if (helpWindow && !helpWindow.isDestroyed()) {
    helpWindow.close();
  }
  helpWindow = null;
}

function init(getMainWindow) {
  getMainWindowRef = getMainWindow;
}

module.exports = {
  init,
  showHelpWindow,
  closeWindow
};
