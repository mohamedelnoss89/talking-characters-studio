// ============================================
//   المحرر العربي للفيديو - Main Process
// ============================================

const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');

let mainWindow;

// الحصول على مسار FFmpeg (يعمل في التطوير وبعد التثبيت)
function getFfmpegPath() {
  // في النسخة المثبتة: ffmpeg.exe في مجلد resources
  if (process.env.NODE_ENV === 'production' || app.isPackaged) {
    return path.join(process.resourcesPath, 'ffmpeg.exe');
  }
  // في التطوير: من node_modules
  try {
    return require('ffmpeg-static');
  } catch {
    return null;
  }
}

// تهيئة FFmpeg
function setupFfmpeg() {
  try {
    const ffmpeg = require('fluent-ffmpeg');
    const ffmpegPath = getFfmpegPath();
    if (ffmpegPath && fs.existsSync(ffmpegPath)) {
      ffmpeg.setFfmpegPath(ffmpegPath);
    }
    return ffmpeg;
  } catch (err) {
    console.error('FFmpeg setup error:', err);
    return null;
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1280,
    minHeight: 720,
    title: 'المحرر العربي للفيديو - Studio Pro',
    backgroundColor: '#0d0e12',
    icon: path.join(__dirname, 'assets', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      webSecurity: true
    },
    autoHideMenuBar: true,
    frame: true,
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0d0e12',
      symbolColor: '#e8e9ee',
      height: 40
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));

  // منع فتح DevTools في الإنتاج
  // mainWindow.webContents.openDevTools();
}

// ===== معالجة IPC =====

// فتح نافذة اختيار الملفات
ipcMain.handle('dialog:openFiles', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    title: 'اختر ملفات الوسائط',
    properties: ['openFile', 'multiSelections'],
    filters: [
      { name: 'كل الملفات المدعومة', extensions: [
        'mp4', 'avi', 'mov', 'mkv', 'webm', 'flv',
        'mp3', 'wav', 'aac', 'flac', 'ogg',
        'png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'
      ]},
      { name: 'فيديو', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'flv'] },
      { name: 'صوت', extensions: ['mp3', 'wav', 'aac', 'flac', 'ogg'] },
      { name: 'صور', extensions: ['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'] }
    ]
  });

  if (result.canceled) return [];

  return result.filePaths.map(filePath => {
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const stats = fs.statSync(filePath);
    let type = 'video';
    if (['mp3', 'wav', 'aac', 'flac', 'ogg'].includes(ext)) type = 'audio';
    else if (['png', 'jpg', 'jpeg', 'bmp', 'webp', 'gif'].includes(ext)) type = 'image';

    return {
      id: `media_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`,
      path: filePath,
      name: path.basename(filePath),
      type,
      extension: ext,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size)
    };
  });
});

// فتح نافذة حفظ الملف
ipcMain.handle('dialog:saveFile', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'حفظ الفيديو',
    defaultPath: defaultName || 'project.json',
    filters: [
      { name: 'ملف مشروع', extensions: ['json'] }
    ]
  });
  return result.canceled ? null : result.filePath;
});

// فتح نافذة حفظ الفيديو النهائي
ipcMain.handle('dialog:exportVideo', async (event, defaultName) => {
  const result = await dialog.showSaveDialog(mainWindow, {
    title: 'تصدير الفيديو النهائي',
    defaultPath: defaultName || 'final_video.mp4',
    filters: [
      { name: 'MP4 فيديو', extensions: ['mp4'] },
      { name: 'MOV فيديو', extensions: ['mov'] },
      { name: 'WebM فيديو', extensions: ['webm'] },
      { name: 'GIF متحرك', extensions: ['gif'] }
    ]
  });
  return result.canceled ? null : result.filePath;
});

// قراءة ملف
ipcMain.handle('fs:readFile', async (event, filePath) => {
  try {
    const data = await fs.promises.readFile(filePath, 'utf-8');
    return { success: true, data };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// كتابة ملف
ipcMain.handle('fs:writeFile', async (event, filePath, content) => {
  try {
    await fs.promises.writeFile(filePath, content, 'utf-8');
    return { success: true };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// الحصول على معلومات الفيديو عبر FFmpeg
ipcMain.handle('ffmpeg:getInfo', async (event, filePath) => {
  try {
    const ffmpeg = setupFfmpeg();
    if (!ffmpeg) return { success: false, error: 'FFmpeg not available' };

    return new Promise((resolve) => {
      ffmpeg.ffprobe(filePath, (err, metadata) => {
        if (err) {
          resolve({ success: false, error: err.message });
        } else {
          const videoStream = metadata.streams.find(s => s.codec_type === 'video');
          const audioStream = metadata.streams.find(s => s.codec_type === 'audio');
          resolve({
            success: true,
            duration: metadata.format.duration,
            video: videoStream ? {
              width: videoStream.width,
              height: videoStream.height,
              fps: eval(videoStream.r_frame_rate) || 30,
              codec: videoStream.codec_name
            } : null,
            audio: audioStream ? {
              codec: audioStream.codec_name,
              sampleRate: audioStream.sample_rate,
              channels: audioStream.channels
            } : null
          });
        }
      });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// الحصول على مسار FFmpeg
ipcMain.handle('ffmpeg:getPath', async () => {
  return getFfmpegPath();
});

// توليد صورة مصغرة للفيديو
ipcMain.handle('ffmpeg:generateThumbnail', async (event, filePath, time) => {
  try {
    const ffmpeg = setupFfmpeg();
    if (!ffmpeg) return { success: false, error: 'FFmpeg not available' };

    const thumbnailsDir = path.join(app.getPath('userData'), 'thumbnails');
    if (!fs.existsSync(thumbnailsDir)) {
      fs.mkdirSync(thumbnailsDir, { recursive: true });
    }

    const thumbName = `thumb_${Date.now()}.jpg`;
    const thumbPath = path.join(thumbnailsDir, thumbName);

    return new Promise((resolve) => {
      ffmpeg(filePath)
        .screenshots({
          timestamps: [time || 1],
          filename: thumbName,
          folder: thumbnailsDir,
          size: '320x?'
        })
        .on('end', () => {
          resolve({ success: true, path: thumbPath });
        })
        .on('error', (err) => {
          resolve({ success: false, error: err.message });
        });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// تصدير الفيديو النهائي
ipcMain.handle('ffmpeg:export', async (event, options) => {
  try {
    const ffmpeg = setupFfmpeg();
    if (!ffmpeg) return { success: false, error: 'FFmpeg not available' };

    const { inputFile, outputFile, startTime, duration, format, quality } = options;

    return new Promise((resolve) => {
      let command = ffmpeg(inputFile);

      if (startTime) command.setStartTime(startTime);
      if (duration) command.setDuration(duration);

      const crf = quality === 'high' ? '18' : quality === 'medium' ? '23' : '28';
      const preset = quality === 'high' ? 'slow' : quality === 'medium' ? 'medium' : 'fast';

      command
        .outputOptions([
          '-c:v libx264',
          `-crf ${crf}`,
          `-preset ${preset}`,
          '-c:a aac',
          '-b:a 192k',
          '-movflags +faststart'
        ])
        .toFormat(format === 'mp4' ? 'mp4' : format)
        .save(outputFile)
        .on('end', () => resolve({ success: true }))
        .on('error', (err) => resolve({ success: false, error: err.message }))
        .on('progress', (progress) => {
          if (mainWindow) {
            mainWindow.webContents.send('export:progress', progress.percent);
          }
        });
    });
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// التحقق من وجود ملف
ipcMain.handle('fs:exists', async (event, filePath) => {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
});

// الحصول على معلومات الملف
ipcMain.handle('fs:getStats', async (event, filePath) => {
  try {
    const stats = fs.statSync(filePath);
    return {
      success: true,
      size: stats.size,
      sizeFormatted: formatBytes(stats.size),
      modified: stats.mtime
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
});

// مساعد لتنسيق حجم الملف
function formatBytes(bytes) {
  if (bytes === 0) return '0 بايت';
  const k = 1024;
  const sizes = ['بايت', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

// ===== تشغيل التطبيق =====
app.whenReady().then(() => {
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
