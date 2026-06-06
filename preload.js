const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getProxyUrl: (streamUrl, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  getProxySeekUrl: (streamUrl, startSeconds, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}&start=${startSeconds}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  openInMpv: (streamUrl) => {
    ipcRenderer.send('open-in-mpv', streamUrl);
  },
  onShowAccountsModal: (callback) => {
    ipcRenderer.on('show-accounts-modal', () => callback());
  },
  onTranscodeStatus: (callback) => {
    ipcRenderer.on('transcode-status', (event, data) => callback(data));
  }
});
