const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getProxyUrl: (streamUrl, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  getProxySeekUrl: (streamUrl, startSeconds, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}&start=${startSeconds}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  showContextMenu: (name, url) => {
    ipcRenderer.send('show-context-menu', { name, url });
  },
  onStopPlayback: (callback) => {
    ipcRenderer.on('stop-playback', () => callback());
  },
  openInMpv: (streamUrl, streamName) => {
    ipcRenderer.send('open-in-mpv', { url: streamUrl, name: streamName });
  },
  stopMpv: () => {
    ipcRenderer.send('stop-mpv');
  },
  onMpvStatusChanged: (callback) => {
    ipcRenderer.on('mpv-status-changed', (event, data) => callback(data));
  },
  onShowAccountsModal: (callback) => {
    ipcRenderer.on('show-accounts-modal', () => callback());
  },
  onShowM3uModal: (callback) => {
    ipcRenderer.on('show-m3u-modal', () => callback());
  },
  onTranscodeStatus: (callback) => {
    ipcRenderer.on('transcode-status', (event, data) => callback(data));
  },
  setPlaybackActive: (streamName, streamUrl) => {
    ipcRenderer.send('set-playback-active', { name: streamName, url: streamUrl });
  },
  setPlaybackInactive: () => {
    ipcRenderer.send('set-playback-inactive');
  },
  requestStreamInfo: () => {
    ipcRenderer.send('request-stream-info');
  },
  onStreamInfoDetails: (callback) => {
    ipcRenderer.on('stream-info-details', (event, data) => callback(data));
  }
});
