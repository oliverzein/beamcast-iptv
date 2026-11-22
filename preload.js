const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getProxyUrl: (streamUrl, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  getProxySeekUrl: (streamUrl, startSeconds, supportsHEVC) => {
    return `http://127.0.0.1:18080/stream?url=${encodeURIComponent(streamUrl)}&start=${startSeconds}${supportsHEVC ? '&hevc=true' : ''}`;
  },
  showContextMenu: (name, url, meta = null) => {
    ipcRenderer.send('show-context-menu', { name, url, meta });
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
  onOpenSettings: (callback) => {
    ipcRenderer.on('open-settings', () => callback());
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
  },
  getDefaultDownloadDir: () => ipcRenderer.invoke('download:get-default-dir'),
  selectDownloadDir: (currentDir) => ipcRenderer.invoke('download:select-dir', currentDir),
  listVaapiDevices: () => ipcRenderer.invoke('download:list-vaapi-devices'),
  checkDownloadConflicts: (items, options) => ipcRenderer.invoke('download:check-conflicts', { items, options }),
  enqueueDownloads: (items, options) => ipcRenderer.invoke('download:enqueue', { items, options }),
  getDownloadState: () => ipcRenderer.invoke('download:get-state'),
  cancelDownload: (jobId) => ipcRenderer.invoke('download:cancel', jobId),
  cancelAllDownloads: () => ipcRenderer.invoke('download:cancel-all'),
  retryDownload: (jobId) => ipcRenderer.invoke('download:retry', jobId),
  removeDownload: (jobId) => ipcRenderer.invoke('download:remove', jobId),
  clearCompletedDownloads: () => ipcRenderer.invoke('download:clear-completed'),
  openDownloadFolder: (targetPath) => ipcRenderer.invoke('download:open-folder', targetPath),
  openDownloadedInMpv: (filePath) => ipcRenderer.invoke('download:open-in-mpv', filePath),
  onDownloadStateUpdate: (callback) => {
    ipcRenderer.on('download-state-update', (event, data) => callback(data));
  },
  onContextMenuDownload: (callback) => {
    ipcRenderer.on('context-menu-download', (event, data) => callback(data));
  }
});
