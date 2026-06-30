// ============================================
//   Preload - جسر آمن بين Main و Renderer
// ============================================

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  // الحوار (Dialogs)
  openFiles: () => ipcRenderer.invoke('dialog:openFiles'),
  saveFile: (defaultName) => ipcRenderer.invoke('dialog:saveFile', defaultName),
  exportVideo: (defaultName) => ipcRenderer.invoke('dialog:exportVideo', defaultName),

  // نظام الملفات
  readFile: (path) => ipcRenderer.invoke('fs:readFile', path),
  writeFile: (path, content) => ipcRenderer.invoke('fs:writeFile', path, content),
  fileExists: (path) => ipcRenderer.invoke('fs:exists', path),
  getStats: (path) => ipcRenderer.invoke('fs:getStats', path),

  // FFmpeg
  getVideoInfo: (path) => ipcRenderer.invoke('ffmpeg:getInfo', path),
  getFfmpegPath: () => ipcRenderer.invoke('ffmpeg:getPath'),
  generateThumbnail: (path, time) => ipcRenderer.invoke('ffmpeg:generateThumbnail', path, time),
  exportVideoFile: (options) => ipcRenderer.invoke('ffmpeg:export', options),

  // أحداث
  onExportProgress: (callback) => {
    ipcRenderer.on('export:progress', (event, percent) => callback(percent));
  }
});
