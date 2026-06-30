// ============================================
//   المحرر العربي للفيديو - Renderer Logic
// ============================================

// ===== الحالة العامة للتطبيق =====
const state = {
  mediaLibrary: [],         // قائمة الوسائط المستوردة
  timeline: {
    tracks: [
      { id: 'video1', type: 'video', name: 'فيديو 1', clips: [] },
      { id: 'video2', type: 'video', name: 'فيديو 2', clips: [] },
      { id: 'audio1', type: 'audio', name: 'صوت 1', clips: [] },
      { id: 'text1',  type: 'text',  name: 'نصوص', clips: [] }
    ],
    duration: 0,
    pixelsPerSecond: 50,    // التقريب (Zoom)
    currentTime: 0
  },
  selectedClip: null,
  selectedMedia: null,
  currentTool: 'select',
  isPlaying: false,
  project: {
    name: 'مشروع جديد',
    modified: false,
    path: null
  },
  history: [],
  historyIndex: -1
};

// ===== المراجع للعناصر =====
const elements = {
  mediaList: document.getElementById('mediaList'),
  previewVideo: document.getElementById('previewVideo'),
  previewPlaceholder: document.getElementById('previewPlaceholder'),
  timelineTracks: document.getElementById('timelineTracks'),
  timelineRuler: document.getElementById('timelineRuler'),
  timelinePlayhead: document.getElementById('timelinePlayhead'),
  currentTime: document.getElementById('currentTime'),
  totalTime: document.getElementById('totalTime'),
  totalDuration: document.getElementById('totalDuration'),
  zoomLevel: document.getElementById('zoomLevel'),
  timelineInfo: document.getElementById('timelineInfo'),
  statusMessage: document.getElementById('statusMessage'),
  propertiesPanel: document.getElementById('propertiesPanel'),
  exportModal: document.getElementById('exportModal'),
  toastContainer: document.getElementById('toastContainer')
};

// ============================================
//   إدارة النوافذ (عنوان التطبيق)
// ============================================
const { ipcRenderer } = require('electron');

document.getElementById('btnMinimize').addEventListener('click', () => {
  // محاكاة عبر IPC
});

document.getElementById('btnMaximize').addEventListener('click', () => {
});

document.getElementById('btnClose').addEventListener('click', () => {
  window.close();
});

// ============================================
//   التبويبات
// ============================================
document.querySelectorAll('.panel-tabs').forEach(tabs => {
  tabs.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      tabs.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');

      const tabName = btn.dataset.tab;
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      if (tabName) {
        const target = document.getElementById('tab' + tabName.charAt(0).toUpperCase() + tabName.slice(1));
        if (target) target.classList.add('active');
      }
    });
  });
});

// ============================================
//   أدوات التحرير
// ============================================
document.querySelectorAll('.tool-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('.tool-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    state.currentTool = btn.dataset.tool;
    showStatus(`الأداة النشطة: ${getToolName(state.currentTool)}`);
  });
});

function getToolName(tool) {
  const names = {
    select: 'التحديد',
    cut: 'القص',
    text: 'النص',
    hand: 'اليد'
  };
  return names[tool] || tool;
}

// ============================================
//   استيراد الوسائط
// ============================================
async function importMedia() {
  try {
    showStatus('جاري استيراد الوسائط...');
    const files = await window.api.openFiles();

    if (files.length === 0) {
      showStatus('جاهز');
      return;
    }

    for (const file of files) {
      // الحصول على معلومات الفيديو/الصوت
      let info = null;
      if (file.type === 'video' || file.type === 'audio') {
        const result = await window.api.getVideoInfo(file.path);
        if (result.success) {
          info = result;
          file.duration = result.duration;
          file.videoInfo = result.video;
          file.audioInfo = result.audio;
        }
      }

      // توليد صورة مصغرة للفيديو
      if (file.type === 'video') {
        const thumb = await window.api.generateThumbnail(file.path, 1);
        if (thumb.success) {
          file.thumbnail = thumb.path;
        }
      } else if (file.type === 'image') {
        file.thumbnail = file.path;
      }

      state.mediaLibrary.push(file);
    }

    renderMediaLibrary();
    showStatus(`تم استيراد ${files.length} ملف بنجاح`);
    showToast(`تم استيراد ${files.length} ملف`, 'success');
  } catch (err) {
    showStatus('خطأ في الاستيراد');
    showToast('حدث خطأ أثناء الاستيراد: ' + err.message, 'error');
  }
}

// ============================================
//   عرض مكتبة الوسائط
// ============================================
function renderMediaLibrary() {
  if (state.mediaLibrary.length === 0) {
    elements.mediaList.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">🎬</div>
        <p>لا توجد وسائط</p>
        <button class="btn-primary" id="btnEmptyImport">استيراد وسائط</button>
      </div>
    `;
    document.getElementById('btnEmptyImport')?.addEventListener('click', importMedia);
    return;
  }

  elements.mediaList.innerHTML = state.mediaLibrary.map(media => {
    const icon = getMediaIcon(media.type);
    const thumbnail = media.thumbnail
      ? `<img src="file://${media.thumbnail}" alt="">`
      : icon;

    const duration = media.duration
      ? formatTime(media.duration)
      : formatBytes(media.size);

    return `
      <div class="media-item" data-id="${media.id}" draggable="true">
        <div class="media-thumbnail">${thumbnail}</div>
        <div class="media-info">
          <div class="media-name">${escapeHtml(media.name)}</div>
          <div class="media-meta">${duration} • ${media.extension.toUpperCase()}</div>
        </div>
      </div>
    `;
  }).join('');

  // ربط الأحداث
  document.querySelectorAll('.media-item').forEach(item => {
    item.addEventListener('click', () => {
      document.querySelectorAll('.media-item').forEach(m => m.classList.remove('selected'));
      item.classList.add('selected');
      const id = item.dataset.id;
      state.selectedMedia = state.mediaLibrary.find(m => m.id === id);
      previewMedia(state.selectedMedia);
    });

    // السحب والإفلات
    item.addEventListener('dragstart', (e) => {
      const id = item.dataset.id;
      e.dataTransfer.setData('text/plain', id);
      e.dataTransfer.effectAllowed = 'copy';
    });
  });
}

function getMediaIcon(type) {
  const icons = {
    video: '🎥',
    audio: '🎵',
    image: '🖼️'
  };
  return icons[type] || '📄';
}

// ============================================
//   معاينة الوسائط
// ============================================
function previewMedia(media) {
  if (!media) return;

  elements.previewPlaceholder.style.display = 'none';
  elements.previewVideo.classList.add('active');

  if (media.type === 'video' || media.type === 'audio') {
    elements.previewVideo.src = 'file://' + media.path;
    elements.previewVideo.load();

    elements.previewVideo.onloadedmetadata = () => {
      elements.totalTime.textContent = formatTime(elements.previewVideo.duration);
    };
  } else if (media.type === 'image') {
    // عرض الصورة
    elements.previewVideo.style.display = 'none';
    const img = document.createElement('img');
    img.src = 'file://' + media.path;
    img.style.cssText = 'width:100%;height:100%;object-fit:contain;';
    img.id = 'previewImage';

    const oldImg = document.getElementById('previewImage');
    if (oldImg) oldImg.remove();

    document.getElementById('previewScreen').appendChild(img);
  }
}

// ============================================
//   التحكم في التشغيل
// ============================================
const playBtn = document.getElementById('btnPlay');
const volumeSlider = document.getElementById('volumeSlider');

playBtn.addEventListener('click', togglePlay);

function togglePlay() {
  if (state.isPlaying) {
    elements.previewVideo.pause();
    state.isPlaying = false;
    playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
  } else {
    if (elements.previewVideo.src) {
      elements.previewVideo.play();
      state.isPlaying = true;
      playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M6 19h4V5H6v14zm8-14v14h4V5h-4z"/></svg>';
    }
  }
}

elements.previewVideo.addEventListener('timeupdate', () => {
  elements.currentTime.textContent = formatTime(elements.previewVideo.currentTime);
});

elements.previewVideo.addEventListener('ended', () => {
  state.isPlaying = false;
  playBtn.innerHTML = '<svg viewBox="0 0 24 24" width="24" height="24"><path fill="currentColor" d="M8 5v14l11-7z"/></svg>';
});

volumeSlider.addEventListener('input', (e) => {
  elements.previewVideo.volume = e.target.value / 100;
});

// أزرار التنقل
document.getElementById('btnSkipStart').addEventListener('click', () => {
  elements.previewVideo.currentTime = 0;
});

document.getElementById('btnSkipEnd').addEventListener('click', () => {
  elements.previewVideo.currentTime = elements.previewVideo.duration || 0;
});

document.getElementById('btnPrevFrame').addEventListener('click', () => {
  elements.previewVideo.currentTime = Math.max(0, elements.previewVideo.currentTime - 0.033);
});

document.getElementById('btnNextFrame').addEventListener('click', () => {
  elements.previewVideo.currentTime = Math.min(
    elements.previewVideo.duration || 0,
    elements.previewVideo.currentTime + 0.033
  );
});

// ============================================
//   التايملاين
// ============================================
function renderTimeline() {
  // توليد المسطرة الزمنية
  renderRuler();

  // توليد المسارات
  renderTracks();

  // تحديث المعلومات
  updateTimelineInfo();
}

function renderRuler() {
  const pps = state.timeline.pixelsPerSecond; // بكسل لكل ثانية
  const totalSeconds = Math.max(state.timeline.duration + 10, 60);
  const widthPx = totalSeconds * pps;

  elements.timelineRuler.innerHTML = '';
  elements.timelineRuler.style.width = (widthPx + 100) + 'px';

  // تحديد الفاصل الزمني
  let interval = 1;
  if (pps < 20) interval = 10;
  else if (pps < 50) interval = 5;
  else if (pps < 100) interval = 2;
  else interval = 1;

  for (let i = 0; i <= totalSeconds; i += interval) {
    const x = i * pps;

    const mark = document.createElement('div');
    mark.className = 'ruler-mark major';
    mark.style.right = x + 'px';
    elements.timelineRuler.appendChild(mark);

    if (i % (interval * 5) === 0 || interval === 1) {
      const label = document.createElement('div');
      label.className = 'ruler-label';
      label.style.right = x + 'px';
      label.textContent = formatTime(i);
      elements.timelineRuler.appendChild(label);
    }
  }
}

function renderTracks() {
  const pps = state.timeline.pixelsPerSecond;
  const totalWidth = (Math.max(state.timeline.duration + 10, 60)) * pps;

  elements.timelineTracks.innerHTML = '';
  elements.timelineTracks.style.width = (totalWidth + 100) + 'px';

  state.timeline.tracks.forEach((track, trackIndex) => {
    const trackEl = document.createElement('div');
    trackEl.className = 'timeline-track';
    trackEl.dataset.trackId = track.id;

    // رأس المسار
    const header = document.createElement('div');
    header.className = 'timeline-track-header';
    header.innerHTML = `
      <div class="track-type-badge ${track.type}"></div>
      <span class="track-label">${track.name}</span>
    `;
    trackEl.appendChild(header);

    // المقاطع
    track.clips.forEach(clip => {
      const clipEl = document.createElement('div');
      clipEl.className = `timeline-clip ${track.type}`;
      clipEl.dataset.clipId = clip.id;
      clipEl.style.right = (clip.start * pps) + 'px';
      clipEl.style.width = (clip.duration * pps) + 'px';

      if (state.selectedClip && state.selectedClip.id === clip.id) {
        clipEl.classList.add('selected');
      }

      clipEl.innerHTML = `
        <div class="clip-name">${escapeHtml(clip.name)}</div>
        <div class="clip-handle left"></div>
        <div class="clip-handle right"></div>
      `;

      // النقر على المقطع
      clipEl.addEventListener('click', (e) => {
        e.stopPropagation();
        selectClip(clip);
      });

      // السحب
      clipEl.addEventListener('mousedown', (e) => {
        if (e.target.classList.contains('clip-handle')) {
          startResize(e, clip, track);
        } else {
          startDrag(e, clip, track);
        }
      });

      trackEl.appendChild(clipEl);
    });

    // السماح بالإفلات على المسار
    trackEl.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    });

    trackEl.addEventListener('drop', (e) => {
      e.preventDefault();
      const mediaId = e.dataTransfer.getData('text/plain');
      const media = state.mediaLibrary.find(m => m.id === mediaId);
      if (media) {
        const rect = trackEl.getBoundingClientRect();
        const x = rect.right - e.clientX;
        const startTime = x / pps;

        addClipToTrack(media, track, startTime);
      }
    });

    // النقر على المسار الفارغ = إلغاء التحديد
    trackEl.addEventListener('click', (e) => {
      if (e.target === trackEl || e.target.classList.contains('timeline-track-header')) {
        selectClip(null);
      }
    });

    elements.timelineTracks.appendChild(trackEl);
  });
}

function updateTimelineInfo() {
  let totalClips = 0;
  state.timeline.tracks.forEach(t => totalClips += t.clips.length);

  elements.timelineInfo.textContent = `${totalClips} مقطع`;
  elements.totalDuration.textContent = formatTime(state.timeline.duration);
  elements.zoomLevel.textContent = Math.round(state.timeline.pixelsPerSecond / 50 * 100) + '%';
}

// ============================================
//   إضافة مقطع لمسار
// ============================================
function addClipToTrack(media, track, startTime) {
  const duration = media.duration || 5;

  const clip = {
    id: 'clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    mediaId: media.id,
    name: media.name,
    type: track.type,
    start: Math.max(0, startTime),
    duration: duration,
    trimStart: 0,
    trimEnd: 0,
    media: media
  };

  track.clips.push(clip);

  // تحديث المدة الإجمالية
  const clipEnd = clip.start + clip.duration;
  if (clipEnd > state.timeline.duration) {
    state.timeline.duration = clipEnd;
  }

  renderTimeline();
  selectClip(clip);
  showToast(`تمت إضافة "${media.name}" إلى ${track.name}`, 'success');
  saveHistory();
}

// ============================================
//   تحديد مقطع
// ============================================
function selectClip(clip) {
  state.selectedClip = clip;
  document.querySelectorAll('.timeline-clip').forEach(c => c.classList.remove('selected'));

  if (clip) {
    const clipEl = document.querySelector(`[data-clip-id="${clip.id}"]`);
    if (clipEl) clipEl.classList.add('selected');
    renderProperties(clip);
  } else {
    renderProperties(null);
  }
}

// ============================================
//   سحب المقطع
// ============================================
function startDrag(e, clip, track) {
  if (state.currentTool === 'cut') return;

  const startX = e.clientX;
  const startClipStart = clip.start;

  const onMove = (moveE) => {
    const deltaX = startX - moveE.clientX;
    const deltaSeconds = deltaX / state.timeline.pixelsPerSecond;
    clip.start = Math.max(0, startClipStart + deltaSeconds);
    renderTimeline();
    selectClip(clip);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveHistory();
    updateTimelineDuration();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ============================================
//   تغيير حجم المقطع
// ============================================
function startResize(e, clip, track) {
  const isLeft = e.target.classList.contains('left');
  const startX = e.clientX;
  const startDuration = clip.duration;
  const startClipStart = clip.start;
  const startTrimStart = clip.trimStart;

  const onMove = (moveE) => {
    const deltaX = startX - moveE.clientX;
    const deltaSeconds = deltaX / state.timeline.pixelsPerSecond;

    if (isLeft) {
      const newStart = Math.max(0, startClipStart + deltaSeconds);
      const newDuration = startDuration - deltaSeconds;

      if (newDuration > 0.1 && newStart >= 0) {
        clip.start = newStart;
        clip.duration = newDuration;
        clip.trimStart = startTrimStart + deltaSeconds;
      }
    } else {
      const newDuration = Math.max(0.1, startDuration - deltaSeconds);
      clip.duration = newDuration;
    }

    renderTimeline();
    selectClip(clip);
  };

  const onUp = () => {
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    saveHistory();
    updateTimelineDuration();
  };

  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// ============================================
//   تحديث المدة الإجمالية
// ============================================
function updateTimelineDuration() {
  let maxDuration = 0;
  state.timeline.tracks.forEach(track => {
    track.clips.forEach(clip => {
      const end = clip.start + clip.duration;
      if (end > maxDuration) maxDuration = end;
    });
  });
  state.timeline.duration = maxDuration;
  updateTimelineInfo();
}

// ============================================
//   لوحة الخصائص
// ============================================
function renderProperties(clip) {
  if (!clip) {
    elements.propertiesPanel.innerHTML = `
      <div class="property-empty">
        <p>اختر عنصراً للتعديل</p>
      </div>
    `;
    return;
  }

  elements.propertiesPanel.innerHTML = `
    <div class="property-group">
      <div class="property-group-title">معلومات المقطع</div>
      <div class="property-row">
        <label>الاسم:</label>
        <input type="text" id="propName" value="${escapeHtml(clip.name)}">
      </div>
      <div class="property-row">
        <label>النوع:</label>
        <span style="color: var(--text-primary)">${getTypeName(clip.type)}</span>
      </div>
    </div>

    <div class="property-group">
      <div class="property-group-title">الوقت</div>
      <div class="property-row">
        <label>البداية:</label>
        <input type="number" id="propStart" value="${clip.start.toFixed(2)}" step="0.1" min="0">
      </div>
      <div class="property-row">
        <label>المدة:</label>
        <input type="number" id="propDuration" value="${clip.duration.toFixed(2)}" step="0.1" min="0.1">
      </div>
      <div class="property-row">
        <label>النهاية:</label>
        <span style="color: var(--text-primary)">${(clip.start + clip.duration).toFixed(2)}s</span>
      </div>
    </div>

    ${clip.type === 'video' ? `
    <div class="property-group">
      <div class="property-group-title">الفيديو</div>
      <div class="property-row">
        <label>الدقة:</label>
        <span style="color: var(--text-primary)">${clip.media?.videoInfo?.width || '?'}×${clip.media?.videoInfo?.height || '?'}</span>
      </div>
      <div class="property-row">
        <label>معدل الإطارات:</label>
        <span style="color: var(--text-primary)">${Math.round(clip.media?.videoInfo?.fps || 30)} FPS</span>
      </div>
    </div>
    ` : ''}

    ${clip.type === 'audio' ? `
    <div class="property-group">
      <div class="property-group-title">الصوت</div>
      <div class="property-row">
        <label>الترميز:</label>
        <span style="color: var(--text-primary)">${clip.media?.audioInfo?.codec || '?'}</span>
      </div>
      <div class="property-row">
        <label>القنوات:</label>
        <span style="color: var(--text-primary)">${clip.media?.audioInfo?.channels || 2}</span>
      </div>
    </div>
    ` : ''}

    <div class="property-group">
      <div class="property-group-title">إجراءات</div>
      <button class="btn-secondary" style="width:100%; margin-bottom:6px;" id="propDuplicate">نسخ المقطع</button>
      <button class="btn-secondary" style="width:100%; color: var(--accent-danger);" id="propDelete">حذف المقطع</button>
    </div>
  `;

  // ربط الأحداث
  document.getElementById('propName')?.addEventListener('input', (e) => {
    clip.name = e.target.value;
    renderTimeline();
  });

  document.getElementById('propStart')?.addEventListener('change', (e) => {
    clip.start = Math.max(0, parseFloat(e.target.value) || 0);
    renderTimeline();
    updateTimelineDuration();
    saveHistory();
  });

  document.getElementById('propDuration')?.addEventListener('change', (e) => {
    clip.duration = Math.max(0.1, parseFloat(e.target.value) || 0.1);
    renderTimeline();
    updateTimelineDuration();
    saveHistory();
  });

  document.getElementById('propDuplicate')?.addEventListener('click', () => {
    duplicateClip(clip);
  });

  document.getElementById('propDelete')?.addEventListener('click', () => {
    deleteClip(clip);
  });
}

function getTypeName(type) {
  const names = {
    video: 'فيديو',
    audio: 'صوت',
    text: 'نص',
    image: 'صورة'
  };
  return names[type] || type;
}

// ============================================
//   العمليات على المقاطع
// ============================================
function deleteClip(clip) {
  state.timeline.tracks.forEach(track => {
    track.clips = track.clips.filter(c => c.id !== clip.id);
  });
  state.selectedClip = null;
  renderTimeline();
  renderProperties(null);
  updateTimelineDuration();
  saveHistory();
  showToast('تم حذف المقطع', 'success');
}

function duplicateClip(clip) {
  state.timeline.tracks.forEach(track => {
    if (track.clips.some(c => c.id === clip.id)) {
      const newClip = {
        ...clip,
        id: 'clip_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
        start: clip.start + clip.duration
      };
      track.clips.push(newClip);
    }
  });
  renderTimeline();
  updateTimelineDuration();
  saveHistory();
  showToast('تم نسخ المقطع', 'success');
}

function splitClip() {
  if (!state.selectedClip) {
    showToast('اختر مقطعاً لتقسيمه', 'warning');
    return;
  }

  const clip = state.selectedClip;
  const splitTime = elements.previewVideo.currentTime - clip.start;

  if (splitTime <= 0 || splitTime >= clip.duration) {
    showToast('ضع مؤشر التشغيل في منتصف المقطع', 'warning');
    return;
  }

  state.timeline.tracks.forEach(track => {
    const idx = track.clips.findIndex(c => c.id === clip.id);
    if (idx !== -1) {
      const firstHalf = { ...clip, duration: splitTime };
      const secondHalf = {
        ...clip,
        id: 'clip_' + Date.now(),
        start: clip.start + splitTime,
        duration: clip.duration - splitTime,
        trimStart: clip.trimStart + splitTime
      };

      track.clips.splice(idx, 1, firstHalf, secondHalf);
    }
  });

  renderTimeline();
  saveHistory();
  showToast('تم تقسيم المقطع', 'success');
}

// ============================================
//   التحكم بالتقريب
// ============================================
document.getElementById('btnZoomIn').addEventListener('click', () => {
  state.timeline.pixelsPerSecond = Math.min(200, state.timeline.pixelsPerSecond * 1.5);
  renderTimeline();
});

document.getElementById('btnZoomOut').addEventListener('click', () => {
  state.timeline.pixelsPerSecond = Math.max(10, state.timeline.pixelsPerSecond / 1.5);
  renderTimeline();
});

document.getElementById('btnZoomFit').addEventListener('click', () => {
  state.timeline.pixelsPerSecond = 50;
  renderTimeline();
});

// ============================================
//   أزرار التايملاين
// ============================================
document.getElementById('btnSplit').addEventListener('click', splitClip);
document.getElementById('btnDelete').addEventListener('click', () => {
  if (state.selectedClip) deleteClip(state.selectedClip);
});
document.getElementById('btnDuplicate').addEventListener('click', () => {
  if (state.selectedClip) duplicateClip(state.selectedClip);
});

// ============================================
//   الحفظ والفتح
// ============================================
document.getElementById('btnNew').addEventListener('click', () => {
  if (state.timeline.tracks.some(t => t.clips.length > 0)) {
    if (!confirm('هل تريد بدء مشروع جديد؟ سيتم فقدان التغييرات غير المحفوظة.')) return;
  }
  newProject();
});

document.getElementById('btnOpen').addEventListener('click', openProject);
document.getElementById('btnSave').addEventListener('click', saveProject);

function newProject() {
  state.mediaLibrary = [];
  state.timeline.tracks.forEach(t => t.clips = []);
  state.timeline.duration = 0;
  state.selectedClip = null;
  state.project = { name: 'مشروع جديد', modified: false, path: null };
  document.getElementById('projectName').textContent = state.project.name;
  renderMediaLibrary();
  renderTimeline();
  renderProperties(null);
  showToast('تم بدء مشروع جديد', 'success');
}

async function saveProject() {
  try {
    const filePath = state.project.path || await window.api.saveFile(state.project.name + '.json');
    if (!filePath) return;

    const projectData = {
      version: '1.0',
      name: state.project.name,
      mediaLibrary: state.mediaLibrary,
      timeline: state.timeline,
      createdAt: new Date().toISOString()
    };

    const result = await window.api.writeFile(filePath, JSON.stringify(projectData, null, 2));
    if (result.success) {
      state.project.path = filePath;
      state.project.modified = false;
      document.getElementById('projectName').textContent = state.project.name;
      showToast('تم حفظ المشروع', 'success');
    } else {
      showToast('خطأ في الحفظ: ' + result.error, 'error');
    }
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

async function openProject() {
  try {
    const { dialog } = require('electron').remote || {};
    const files = await window.api.openFiles();
    if (files.length === 0) return;

    const filePath = files[0].path;
    const result = await window.api.readFile(filePath);
    if (!result.success) {
      showToast('خطأ في الفتح: ' + result.error, 'error');
      return;
    }

    const data = JSON.parse(result.data);
    state.mediaLibrary = data.mediaLibrary || [];
    state.timeline = data.timeline || state.timeline;
    state.project = { name: data.name || 'مشروع', path: filePath, modified: false };
    document.getElementById('projectName').textContent = state.project.name;

    renderMediaLibrary();
    renderTimeline();
    showToast('تم فتح المشروع', 'success');
  } catch (err) {
    showToast('خطأ: ' + err.message, 'error');
  }
}

// ============================================
//   التصدير
// ============================================
document.getElementById('btnExport').addEventListener('click', () => {
  if (state.timeline.tracks.every(t => t.clips.length === 0)) {
    showToast('لا يوجد محتوى للتصدير', 'warning');
    return;
  }
  elements.exportModal.classList.add('active');
});

document.getElementById('closeExportModal').addEventListener('click', () => {
  elements.exportModal.classList.remove('active');
});

document.getElementById('cancelExport').addEventListener('click', () => {
  elements.exportModal.classList.remove('active');
});

document.getElementById('confirmExport').addEventListener('click', async () => {
  const format = document.getElementById('exportFormat').value;
  const quality = document.getElementById('exportQuality').value;
  const fps = document.getElementById('exportFps').value;
  const fileName = document.getElementById('exportFileName').value || 'final_video';

  const outputPath = await window.api.exportVideo(`${fileName}.${format}`);
  if (!outputPath) return;

  // إظهار شريط التقدم
  document.getElementById('exportProgress').style.display = 'block';
  document.getElementById('confirmExport').disabled = true;

  // للتبسيط: نأخذ أول مقطع فيديو ونصدره
  // في النسخة الكاملة: يتم دمج كل المقاطع
  let firstVideoClip = null;
  for (const track of state.timeline.tracks) {
    const videoClip = track.clips.find(c => c.type === 'video');
    if (videoClip) {
      firstVideoClip = videoClip;
      break;
    }
  }

  if (!firstVideoClip) {
    showToast('لا يوجد فيديو للتصدير', 'error');
    document.getElementById('exportProgress').style.display = 'none';
    document.getElementById('confirmExport').disabled = false;
    return;
  }

  const options = {
    inputFile: firstVideoClip.media.path,
    outputFile: outputPath,
    startTime: firstVideoClip.trimStart,
    duration: firstVideoClip.duration,
    format: format,
    quality: quality
  };

  window.api.onExportProgress((percent) => {
    document.getElementById('progressFill').style.width = percent + '%';
    document.getElementById('progressPercent').textContent = Math.round(percent) + '%';
  });

  const result = await window.api.exportVideoFile(options);

  document.getElementById('exportProgress').style.display = 'none';
  document.getElementById('confirmExport').disabled = false;

  if (result.success) {
    elements.exportModal.classList.remove('active');
    showToast(`تم تصدير الفيديو بنجاح إلى: ${outputPath}`, 'success');
  } else {
    showToast('خطأ في التصدير: ' + result.error, 'error');
  }
});

// ============================================
//   السجل (History)
// ============================================
function saveHistory() {
  // قطع التاريخ بعد الموقع الحالي
  state.history = state.history.slice(0, state.historyIndex + 1);

  // حفظ نسخة
  state.history.push(JSON.parse(JSON.stringify({
    timeline: state.timeline,
    mediaLibrary: state.mediaLibrary
  })));

  state.historyIndex++;

  // الحد الأقصى 50 عملية
  if (state.history.length > 50) {
    state.history.shift();
    state.historyIndex--;
  }

  state.project.modified = true;
}

document.getElementById('btnUndo').addEventListener('click', undo);
document.getElementById('btnRedo').addEventListener('click', redo);

function undo() {
  if (state.historyIndex <= 0) {
    showToast('لا يوجد ما يمكن التراجع عنه', 'warning');
    return;
  }
  state.historyIndex--;
  const snapshot = state.history[state.historyIndex];
  state.timeline = JSON.parse(JSON.stringify(snapshot.timeline));
  state.mediaLibrary = JSON.parse(JSON.stringify(snapshot.mediaLibrary));
  renderTimeline();
  renderMediaLibrary();
  showToast('تم التراجع', 'success');
}

function redo() {
  if (state.historyIndex >= state.history.length - 1) {
    showToast('لا يوجد ما يمكن إعادته', 'warning');
    return;
  }
  state.historyIndex++;
  const snapshot = state.history[state.historyIndex];
  state.timeline = JSON.parse(JSON.stringify(snapshot.timeline));
  state.mediaLibrary = JSON.parse(JSON.stringify(snapshot.mediaLibrary));
  renderTimeline();
  renderMediaLibrary();
  showToast('تمت الإعادة', 'success');
}

// ============================================
//   اختصارات لوحة المفاتيح
// ============================================
document.addEventListener('keydown', (e) => {
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'z') {
      e.preventDefault();
      if (e.shiftKey) redo();
      else undo();
    } else if (e.key === 'y') {
      e.preventDefault();
      redo();
    } else if (e.key === 's') {
      e.preventDefault();
      saveProject();
    }
  } else {
    if (e.key === 'v' || e.key === 'V') {
      document.querySelector('[data-tool="select"]')?.click();
    } else if (e.key === 'c' || e.key === 'C') {
      document.querySelector('[data-tool="cut"]')?.click();
    } else if (e.key === 's' || e.key === 'S') {
      splitClip();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      if (state.selectedClip) deleteClip(state.selectedClip);
    } else if (e.key === ' ') {
      e.preventDefault();
      togglePlay();
    }
  }
});

// ============================================
//   الدوال المساعدة
// ============================================
function formatTime(seconds) {
  if (isNaN(seconds)) seconds = 0;
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const ms = Math.floor((seconds % 1) * 100);

  if (h > 0) {
    return `${pad(h)}:${pad(m)}:${pad(s)}.${pad(ms)}`;
  }
  return `${pad(m)}:${pad(s)}.${pad(ms)}`;
}

function pad(n) {
  return n.toString().padStart(2, '0');
}

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(2)) + ' ' + sizes[i];
}

function escapeHtml(text) {
  if (!text) return '';
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showStatus(message) {
  elements.statusMessage.textContent = message;
}

function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  elements.toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateX(-100%)';
    setTimeout(() => toast.remove(), 300);
  }, 3000);
}

// ============================================
//   التهيئة
// ============================================
document.getElementById('btnImport').addEventListener('click', importMedia);
document.getElementById('btnImportMedia').addEventListener('click', importMedia);

// التهيئة الأولية
renderTimeline();
saveHistory();
showStatus('جاهز للعمل');
showToast('مرحباً بك في المحرر العربي للفيديو', 'success');
