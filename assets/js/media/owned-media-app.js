(function () {
  'use strict';
  const app = document.getElementById('media-app');
  const channel = new BroadcastChannel('emberstage-media-v1');
  
  // State variables
  const items = [];
  const objectUrls = new Map();
  let selectedId = '';
  let outputState = 'waiting';
  let liveId = '';
  let storageError = '';
  let searchQuery = '';
  let lastStatusTime = Date.now();
  let isSeeking = false;
  let db = null;
  let isLoading = true;
  let appliedLayout = null;
  let cameraAbsent = false;

  // LocalStorage helper wrapper
  function safeSetItem(key, val) {
    try { localStorage.setItem(key, val); } catch (_) {}
  }
  function safeGetItem(key) {
    try { return localStorage.getItem(key); } catch (_) { return null; }
  }
  function safeRemoveItem(key) {
    try { localStorage.removeItem(key); } catch (_) {}
  }

  // LocalStorage keys
  const FIT_KEY = 'obs-bible:media:settings:fit';
  const MUTE_KEY = 'obs-bible:media:settings:mute';
  const LOOP_KEY = 'obs-bible:media:settings:loop';
  const TRANSITION_TYPE_KEY = 'obs-bible:media:settings:transition-type';
  const TRANSITION_DUR_KEY = 'obs-bible:media:settings:transition-duration';
  const ORDER_KEY = 'obs-bible:media:order';

  // IndexedDB configuration
  const DB_NAME = 'emberstage-media-db';
  const DB_VERSION = 1;
  const STORE_NAME = 'media-items';

  // Helper: create element
  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  // Helper: create button
  const button = (text, action, className = '') => {
    const node = el('button', className, text);
    node.type = 'button';
    node.addEventListener('click', action);
    return node;
  };

  function getObjectUrl(item) {
    if (!objectUrls.has(item.id)) {
      objectUrls.set(item.id, URL.createObjectURL(item.file));
    }
    return objectUrls.get(item.id);
  }

  function releaseObjectUrls() {
    for (const url of objectUrls.values()) {
      URL.revokeObjectURL(url);
    }
    objectUrls.clear();
  }

  // IndexedDB Methods
  function initDB() {
    return new Promise((resolve, reject) => {
      let resolved = false;
      const request = indexedDB.open(DB_NAME, DB_VERSION);
      
      request.onblocked = () => {
        if (!resolved) {
          resolved = true;
          reject(new Error('IndexedDB connection blocked by another tab or session.'));
        }
      };

      request.onupgradeneeded = event => {
        const dbInstance = event.target.result;
        if (!dbInstance.objectStoreNames.contains(STORE_NAME)) {
          dbInstance.createObjectStore(STORE_NAME, { keyPath: 'id' });
        }
      };

      request.onsuccess = event => {
        if (!resolved) {
          resolved = true;
          resolve(event.target.result);
        }
      };

      request.onerror = event => {
        if (!resolved) {
          resolved = true;
          reject(event.target.error || new Error('Failed to open database'));
        }
      };
    });
  }

  function saveToDB(item) {
    if (!db) return Promise.reject(new Error('Database not initialized'));
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
      
      store.put({
        id: item.id,
        name: item.name,
        kind: item.kind,
        file: item.file,
        layoutPreset: item.layoutPreset || 'full',
        layoutCorner: item.layoutCorner || 'bottom-right'
      });
    });
  }

  function deleteFromDB(id) {
    if (!db) return Promise.reject(new Error('Database not initialized'));
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
      
      store.delete(id);
    });
  }

  function clearDB() {
    if (!db) return Promise.reject(new Error('Database not initialized'));
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readwrite');
      const store = transaction.objectStore(STORE_NAME);
      
      transaction.oncomplete = () => resolve();
      transaction.onabort = () => reject(transaction.error || new Error('Transaction aborted'));
      transaction.onerror = () => reject(transaction.error || new Error('Transaction error'));
      
      store.clear();
    });
  }

  function getAllFromDB() {
    if (!db) return Promise.reject(new Error('Database not initialized'));
    return new Promise((resolve, reject) => {
      const transaction = db.transaction(STORE_NAME, 'readonly');
      const store = transaction.objectStore(STORE_NAME);
      const request = store.getAll();
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  // Load order helper
  function loadOrder() {
    try {
      const parsed = JSON.parse(safeGetItem(ORDER_KEY) || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch (_) {
      return [];
    }
  }

  function saveOrder() {
    const ids = items.map(item => item.id);
    safeSetItem(ORDER_KEY, JSON.stringify(ids));
  }

  // Disable Add button initially until DB loading finishes
  function setAddDisabled(disabled) {
    fileInput.disabled = disabled;
    if (disabled) {
      add.classList.add('disabled');
      add.style.pointerEvents = 'none';
      add.style.opacity = '0.42';
    } else {
      add.classList.remove('disabled');
      add.style.pointerEvents = '';
      add.style.opacity = '';
    }
  }

  // 1. Header & Brand
  const header = el('header', 'deckbar');
  const brand = el('div', 'dock-brand-lockup');
  const brandLogo = document.createElement('img');
  brandLogo.className = 'ember-brand-logo';
  brandLogo.src = 'assets/brand/emberstage-logo.svg';
  brandLogo.alt = '';
  
  const brandStack = el('div', 'dock-brand-stack');
  const brandWordmark = document.createElement('img');
  brandWordmark.className = 'ember-brand-wordmark';
  brandWordmark.src = 'assets/brand/emberstage-wordmark.svg';
  brandWordmark.alt = 'Emberstage for OBS';
  brandStack.append(brandWordmark, el('span', 'dock-brand-kicker', 'Media dock'));
  brand.append(brandLogo, brandStack);
  
  header.append(brand, el('h1', '', 'Media'));
  const stateBadge = el('span', 'badge', 'OUTPUT');
  header.append(stateBadge);
  
  const add = el('label', 'primary media-add', 'Add media');
  const fileInput = el('input');
  fileInput.type = 'file';
  fileInput.multiple = true;
  fileInput.hidden = true;
  add.append(fileInput);
  header.append(add);
  const layoutMenuButton = button('Layout', () => toggleLayoutMenu(), 'quiet layout-menu-toggle');
  layoutMenuButton.setAttribute('aria-label', 'Media layout settings');
  layoutMenuButton.setAttribute('aria-haspopup', 'menu');
  layoutMenuButton.setAttribute('aria-expanded', 'false');
  layoutMenuButton.disabled = true;
  header.append(layoutMenuButton);
  const sizeWrap = el('label', 'dock-ui-scale');
  sizeWrap.setAttribute('aria-label', 'Media dock size');
  sizeWrap.append(el('span', 'dock-ui-scale-label', 'Size'));
  const sizeSlider = el('input', 'dock-ui-scale-slider');
  sizeSlider.type = 'range';
  sizeSlider.id = 'media-dock-scale';
  sizeSlider.min = '80';
  sizeSlider.max = '120';
  sizeSlider.step = '1';
  sizeSlider.value = '100';
  sizeSlider.setAttribute('aria-label', 'Media dock size slider');
  const sizeValue = el('span', 'dock-ui-scale-readout', '100%');
  sizeValue.id = 'media-dock-scale-value';
  sizeWrap.append(sizeSlider, sizeValue);
  header.append(sizeWrap);
  app.append(header);

  if (window.EmberstageDockScale) {
    window.EmberstageDockScale.init({
      root: document.body,
      control: sizeSlider,
      output: sizeValue,
      storageKey: 'obs-bible:media:ui-scale',
      defaultValue: 100,
      min: 70,
      max: 120,
      step: 1
    });
  }

  setAddDisabled(true); // Default disabled until library is loaded

  // 2. Toolbar (Search, Clear All, Storage Info)
  const toolbar = el('div', 'toolbar');
  const searchInput = el('input');
  searchInput.type = 'search';
  searchInput.placeholder = 'Search media...';
  searchInput.className = 'search-input';
  searchInput.setAttribute('aria-label', 'Search media by filename');
  
  const clearAllBtn = button('Clear All', async () => {
    const isAnyLive = outputState === 'live' && liveId !== '';
    const confirmMsg = isAnyLive 
      ? 'Warning: Cleared media includes the currently live item. Clearing will hide the live output. Are you sure you want to clear all media files?'
      : 'Are you sure you want to clear all media files? This will delete them from the library.';
    
    if (confirm(confirmMsg)) {
      try {
        await clearDB();
        if (isAnyLive) {
          channel.postMessage({ version: 1, type: 'hide' });
        }
        releaseObjectUrls();
        items.length = 0;
        selectedId = '';
        safeRemoveItem('obs-bible:media:selectedId');
        saveOrder();
        render();
      } catch (err) {
        alert('Failed to clear library from storage: ' + err.message);
      }
    }
  }, 'quiet clear-btn');
  clearAllBtn.setAttribute('aria-label', 'Clear all media files');
  
  const storageInfo = el('span', 'storage-info muted', 'Loading storage...');
  toolbar.append(searchInput, clearAllBtn, storageInfo);
  app.append(toolbar);

  // 3. Notice area
  const notice = el('div', 'notice');
  notice.hidden = true;
  app.append(notice);

  // 4. Source list
  const list = el('div', 'source-list owned-library');
  list.setAttribute('aria-label', 'Emberstage media library');
  app.append(list);

  // 5. Video Live Controls Strip (Play/Pause, Seek Slider, Time, Loop)
  const videoControls = el('div', 'video-controls');
  videoControls.style.display = 'none'; // hidden by default unless video is live
  
  const playPauseBtn = button('Play', () => {
    const isPaused = playPauseBtn.dataset.paused === 'true';
    channel.postMessage({ version: 1, type: 'transport', action: isPaused ? 'play' : 'pause' });
  });
  playPauseBtn.setAttribute('aria-label', 'Toggle Play/Pause');
  
  const restartBtn = button('Restart', () => {
    channel.postMessage({ version: 1, type: 'transport', action: 'restart' });
  });
  restartBtn.setAttribute('aria-label', 'Restart Video');

  const progressContainer = el('div', 'progress-container');
  const progressBar = el('input');
  progressBar.type = 'range';
  progressBar.className = 'progress-bar';
  progressBar.min = 0;
  progressBar.max = 100;
  progressBar.value = 0;
  progressBar.setAttribute('aria-label', 'Video playback progress');

  const progressTime = el('span', 'progress-time', '0:00 / 0:00');
  progressContainer.append(progressBar, progressTime);
  videoControls.append(playPauseBtn, restartBtn, progressContainer);

  // Compact top-bar layout popup
  const layoutContainer = el('div', 'layout-menu-popover');
  layoutContainer.hidden = true;
  layoutContainer.setAttribute('role', 'menu');
  layoutContainer.setAttribute('aria-label', 'Media layout settings');

  const layoutContent = el('div', 'layout-menu-content');
  layoutContent.append(el('strong', 'layout-menu-title', 'Media layout'));
  const presetField = el('div', 'layout-menu-section');
  presetField.append(el('span', 'layout-menu-label', 'Preset'));
  const presetChoices = el('div', 'layout-menu-options');
  const presets = [
    { label: 'Full media', value: 'full' },
    { label: 'Media left', value: 'split-left' },
    { label: 'Media right', value: 'split-right' },
    { label: 'Camera inset', value: 'camera-inset' }
  ];
  const presetButtons = new Map();
  presets.forEach(p => {
    const choice = button(p.label, () => selectLayoutPreset(p.value), 'layout-menu-choice');
    choice.setAttribute('role', 'menuitemradio');
    choice.dataset.value = p.value;
    presetButtons.set(p.value, choice);
    presetChoices.append(choice);
  });
  presetField.append(presetChoices);

  const cornerField = el('div', 'layout-menu-section');
  cornerField.hidden = true;
  cornerField.append(el('span', 'layout-menu-label', 'Camera corner'));
  const cornerChoices = el('div', 'layout-menu-options layout-corner-options');
  const corners = [
    { label: 'Top Left', value: 'top-left' },
    { label: 'Top Right', value: 'top-right' },
    { label: 'Bottom Left', value: 'bottom-left' },
    { label: 'Bottom Right', value: 'bottom-right' }
  ];
  const cornerButtons = new Map();
  corners.forEach(c => {
    const choice = button(c.label, () => selectLayoutCorner(c.value), 'layout-menu-choice');
    choice.setAttribute('role', 'menuitemradio');
    choice.dataset.value = c.value;
    cornerButtons.set(c.value, choice);
    cornerChoices.append(choice);
  });
  cornerField.append(cornerChoices);

  const diagram = el('div', 'layout-miniature-diagram');
  const miniImg = el('div', 'layout-miniature-image', 'MEDIA');
  const miniCam = el('div', 'layout-miniature-camera');
  diagram.append(miniImg, miniCam);

  const applyLiveBtn = el('button', 'apply-layout-btn', 'Apply layout live');
  applyLiveBtn.type = 'button';

  const layoutMenuFooter = el('div', 'layout-menu-footer');
  layoutMenuFooter.append(diagram, applyLiveBtn);
  layoutContent.append(presetField, cornerField, layoutMenuFooter);
  layoutContainer.append(layoutContent);
  header.append(layoutContainer);

  function toggleLayoutMenu(force) {
    if (layoutMenuButton.disabled && force !== false) return;
    const shouldOpen = typeof force === 'boolean' ? force : layoutContainer.hidden;
    layoutContainer.hidden = !shouldOpen;
    layoutMenuButton.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) renderLayoutMenu();
  }

  function renderLayoutMenu() {
    const selectedItem = items.find(i => i.id === selectedId);
    if (!selectedItem) return;
    const preset = selectedItem.layoutPreset || 'full';
    const corner = selectedItem.layoutCorner || 'bottom-right';
    for (const [value, choice] of presetButtons) {
      const active = value === preset;
      choice.setAttribute('aria-checked', String(active));
      choice.classList.toggle('active', active);
    }
    for (const [value, choice] of cornerButtons) {
      const active = value === corner;
      choice.setAttribute('aria-checked', String(active));
      choice.classList.toggle('active', active);
    }
    cornerField.hidden = preset !== 'camera-inset';
    updateDiagram(preset, corner);
  }

  function selectLayoutPreset(value) {
    const selectedItem = items.find(i => i.id === selectedId);
    if (!selectedItem) return;
    selectedItem.layoutPreset = value;
    persistSelectedLayout(selectedItem);
  }

  function selectLayoutCorner(value) {
    const selectedItem = items.find(i => i.id === selectedId);
    if (!selectedItem) return;
    selectedItem.layoutCorner = value;
    persistSelectedLayout(selectedItem);
  }

  function persistSelectedLayout(selectedItem) {
    renderLayoutMenu();
    saveToDB(selectedItem).catch(() => { storageError = 'Layout could not be saved. Keep this dock open and try again.'; render(); });
    const isLive = liveId === selectedItem.id && outputState === 'live';
    const hasChanges = !appliedLayout || selectedItem.layoutPreset !== appliedLayout.preset || selectedItem.layoutCorner !== appliedLayout.corner;
    applyLiveBtn.style.display = isLive && hasChanges ? 'block' : 'none';
  }

  function updateDiagram(preset, corner) {
    if (preset === 'full') {
      miniCam.style.display = 'none';
    } else {
      miniCam.style.display = 'block';
      if (preset === 'split-left') {
        miniCam.style.left = '50%';
        miniCam.style.top = '0';
        miniCam.style.width = '50%';
        miniCam.style.height = '100%';
      } else if (preset === 'split-right') {
        miniCam.style.left = '0';
        miniCam.style.top = '0';
        miniCam.style.width = '50%';
        miniCam.style.height = '100%';
      } else if (preset === 'camera-inset') {
        miniCam.style.width = '30%';
        miniCam.style.height = '30%';
        if (corner === 'top-left') {
          miniCam.style.left = '2%';
          miniCam.style.top = '2%';
        } else if (corner === 'top-right') {
          miniCam.style.left = '68%';
          miniCam.style.top = '2%';
        } else if (corner === 'bottom-left') {
          miniCam.style.left = '2%';
          miniCam.style.top = '68%';
        } else if (corner === 'bottom-right') {
          miniCam.style.left = '68%';
          miniCam.style.top = '68%';
        }
      }
    }
  }

  applyLiveBtn.addEventListener('click', () => {
    const selectedItem = items.find(i => i.id === selectedId);
    if (!selectedItem) return;
    channel.postMessage({
      version: 1,
      type: 'apply-layout',
      id: selectedItem.id,
      layout: { preset: selectedItem.layoutPreset, corner: selectedItem.layoutCorner },
      transition: transitionTypeSelect.value,
      duration: parseInt(transitionDurationSelect.value, 10)
    });
    appliedLayout = { preset: selectedItem.layoutPreset, corner: selectedItem.layoutCorner };
    applyLiveBtn.style.display = 'none';
    toggleLayoutMenu(false);
  });

  document.addEventListener('pointerdown', event => {
    if (!layoutContainer.hidden && !layoutContainer.contains(event.target) && !layoutMenuButton.contains(event.target)) toggleLayoutMenu(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !layoutContainer.hidden) {
      toggleLayoutMenu(false);
      layoutMenuButton.focus();
    }
  });

  app.append(videoControls);

  // 6. Actionbar / Footer
  const footer = el('footer', 'actionbar');
  const selectionDisplay = el('div', 'selection', 'Choose media');

  const fitSelect = el('select', 'media-fit-select');
  fitSelect.setAttribute('aria-label', 'Media sizing');
  fitSelect.title = 'Fit: show the whole image or video. Fill: cover the area, cropping edges.';
  for (const [value, label] of [['contain', 'Fit'], ['cover', 'Fill']]) {
    const option = el('option', '', label);
    option.value = value;
    fitSelect.append(option);
  }
  fitSelect.value = safeGetItem(FIT_KEY) === 'true' ? 'cover' : 'contain';
  
  const muteLabel = el('label', 'check');
  const muteCheckbox = el('input');
  muteCheckbox.type = 'checkbox';
  muteCheckbox.checked = safeGetItem(MUTE_KEY) === 'true';
  muteLabel.append(muteCheckbox, document.createTextNode('Mute video'));

  const loopLabel = el('label', 'check');
  const loopCheckbox = el('input');
  loopCheckbox.type = 'checkbox';
  loopCheckbox.checked = safeGetItem(LOOP_KEY) !== 'false'; // default true
  loopLabel.append(loopCheckbox, document.createTextNode('Loop'));

  const transitionSettingsBtn = button('⚙️ Transitions', () => {
    transitionPopover.classList.toggle('hidden');
  }, 'quiet settings-toggle-btn');
  transitionSettingsBtn.setAttribute('aria-label', 'Configure Transition Settings');

  const take = button('Show media', () => {
    const item = items.find(i => i.id === selectedId);
    if (!item) return;
    if (outputState === 'live' && liveId === item.id) {
      channel.postMessage({
        version: 1,
        type: 'hide',
        transition: transitionTypeSelect.value,
        duration: parseInt(transitionDurationSelect.value, 10)
      });
      return;
    }
    appliedLayout = { preset: item.layoutPreset || 'full', corner: item.layoutCorner || 'bottom-right' };
    channel.postMessage({
      version: 1,
      type: 'show',
      id: item.id,
      kind: item.kind,
      blob: item.file,
      fit: fitSelect.value,
      muted: muteCheckbox.checked,
      loop: loopCheckbox.checked,
      transition: transitionTypeSelect.value,
      duration: parseInt(transitionDurationSelect.value, 10),
      layout: { preset: item.layoutPreset || 'full', corner: item.layoutCorner || 'bottom-right' }
    });
  }, 'primary');
  take.setAttribute('aria-label', 'Toggle Live Presentation');

  footer.append(selectionDisplay, fitSelect, muteLabel, loopLabel, transitionSettingsBtn, take);
  app.append(footer);

  // 7. Transition settings popover
  const transitionPopover = el('div', 'settings-popover hidden');
  const popoverTitle = el('h3', '', 'Transition Settings');
  
  const typeField = el('div', 'popover-field');
  const transitionTypeSelect = el('select');
  const types = [
    { label: 'Cut', value: 'cut' },
    { label: 'Crossfade', value: 'fade' },
    { label: 'Dip to Black', value: 'dip' }
  ];
  types.forEach(t => {
    const opt = el('option', '', t.label);
    opt.value = t.value;
    transitionTypeSelect.append(opt);
  });
  transitionTypeSelect.value = safeGetItem(TRANSITION_TYPE_KEY) || 'fade';
  transitionTypeSelect.setAttribute('aria-label', 'Transition Type');
  typeField.append(el('span', '', 'Type:'), transitionTypeSelect);

  const durField = el('div', 'popover-field');
  const transitionDurationSelect = el('select');
  const durs = [
    { label: '150ms', value: '150' },
    { label: '300ms', value: '300' },
    { label: '500ms', value: '500' }
  ];
  durs.forEach(d => {
    const opt = el('option', '', d.label);
    opt.value = d.value;
    transitionDurationSelect.append(opt);
  });
  transitionDurationSelect.value = safeGetItem(TRANSITION_DUR_KEY) || '300';
  transitionDurationSelect.setAttribute('aria-label', 'Transition Duration');
  durField.append(el('span', '', 'Duration:'), transitionDurationSelect);

  transitionPopover.append(popoverTitle, typeField, durField);
  app.append(transitionPopover);

  // Settings changes handlers
  fitSelect.addEventListener('change', () => {
    safeSetItem(FIT_KEY, fitSelect.value === 'cover');
    updateLiveSettings();
  });
  muteCheckbox.addEventListener('change', () => {
    safeSetItem(MUTE_KEY, muteCheckbox.checked);
    updateLiveSettings();
  });
  loopCheckbox.addEventListener('change', () => {
    safeSetItem(LOOP_KEY, loopCheckbox.checked);
    updateLiveSettings();
  });
  transitionTypeSelect.addEventListener('change', () => {
    safeSetItem(TRANSITION_TYPE_KEY, transitionTypeSelect.value);
  });
  transitionDurationSelect.addEventListener('change', () => {
    safeSetItem(TRANSITION_DUR_KEY, transitionDurationSelect.value);
  });

  function updateLiveSettings() {
    if (outputState === 'live' && liveId) {
      channel.postMessage({
        version: 1,
        type: 'update-settings',
        fit: fitSelect.value,
        muted: muteCheckbox.checked,
        loop: loopCheckbox.checked
      });
    }
  }

  progressBar.addEventListener('input', () => {
    isSeeking = true;
  });

  progressBar.addEventListener('change', () => {
    isSeeking = false;
    const seekTime = parseFloat(progressBar.value);
    channel.postMessage({ version: 1, type: 'seek', time: seekTime });
  });

  function formatTime(secs) {
    if (isNaN(secs) || !isFinite(secs)) return '0:00';
    const m = Math.floor(secs / 60);
    const s = Math.floor(secs % 60);
    return `${m}:${s.toString().padStart(2, '0')}`;
  }

  function updateLiveProgress(currentTime, duration, paused) {
    playPauseBtn.dataset.paused = String(paused);
    playPauseBtn.textContent = paused ? 'Play' : 'Pause';
    
    if (!isSeeking) {
      progressBar.max = duration;
      progressBar.value = currentTime;
    }
    progressTime.textContent = `${formatTime(currentTime)} / ${formatTime(duration)}`;
  }

  function normalizeAppliedLayout(layout) {
    if (!layout) return null;
    if (typeof layout === 'object') {
      return {
        preset: layout.preset || 'full',
        corner: layout.corner || 'bottom-right'
      };
    }
    return {
      preset: layout || 'full',
      corner: 'bottom-right'
    };
  }

  function previewFrame(item, index) {
    const frame = el('span', `source-preview source-preview-${item.kind}`);
    frame.setAttribute('aria-hidden', 'true');
    const indexChip = el('span', 'source-preview-index', String(index + 1).padStart(2, '0'));
    const noteText = item.kind === 'image' ? 'Picture' : (item.id === selectedId ? 'Playing' : 'Video');
    const note = el('span', 'source-preview-note', noteText);
    const url = getObjectUrl(item);

    if (item.kind === 'image') {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.src = url;
      frame.append(image, indexChip, note);
      return frame;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.disablePictureInPicture = true;
    video.src = url;
    video.setAttribute('aria-hidden', 'true');

    // Efficient preview: ONLY play selected video, unselected has preload metadata and seeks to 0.1s
    if (item.id === selectedId) {
      video.autoplay = true;
      video.loop = true;
      video.preload = 'auto';
      video.addEventListener('loadeddata', () => video.play().catch(() => {}), { once: true });
    } else {
      video.autoplay = false;
      video.loop = false;
      video.preload = 'metadata';
      video.addEventListener('loadedmetadata', () => {
        video.currentTime = 0.1;
      }, { once: true });
    }
    frame.append(video, indexChip, note);
    return frame;
  }

  // Prevent video decoder leaks before discarding DOM nodes
  function cleanupListVideos() {
    const listVideos = list.querySelectorAll('video');
    listVideos.forEach(video => {
      try {
        video.pause();
        video.src = '';
        video.load();
      } catch (_) {}
    });
  }

  function render() {
    const focusedId = document.activeElement?.closest?.('.source-row')?.dataset.mediaId || '';
    const focusedControlClass = document.activeElement?.className?.includes('card-btn') ? document.activeElement.className : '';
    
    cleanupListVideos();
    list.replaceChildren();

    // Filter items based on search query
    const filteredItems = items.filter(item => item.name.toLowerCase().includes(searchQuery));

    if (!filteredItems.length) {
      const empty = el('div', 'empty');
      empty.append(
        el('strong', '', searchQuery ? 'No search results' : 'Add pictures or videos'),
        el('small', '', searchQuery ? 'Try adjusting your search terms.' : 'Files stay local and play through Emberstage Media Output.')
      );
      list.append(empty);
    }

    filteredItems.forEach((item, index) => {
      const overallIndex = items.findIndex(i => i.id === item.id);
      const isSelected = item.id === selectedId;

      const row = el('div', 'source-row');
      row.dataset.mediaId = item.id;

      // Inner select button for HTML compliance
      const selectBtn = el('button', 'source-row-select-btn');
      selectBtn.type = 'button';
      selectBtn.setAttribute('aria-pressed', String(isSelected));
      selectBtn.setAttribute('aria-label', `Select ${item.name}`);
      selectBtn.append(previewFrame(item, overallIndex));

      const copy = el('span', 'source-copy');
      const metaText = item.persisted === false ? 'Session-only' : (item.kind === 'image' ? 'Picture' : 'Video');
      copy.append(el('span', 'source-name', item.name), el('span', 'source-meta', metaText));
      selectBtn.append(copy);

      // Select row action
      selectBtn.addEventListener('click', () => {
        if (selectedId !== item.id) {
          selectedId = item.id;
          safeSetItem('obs-bible:media:selectedId', selectedId);
          render();
        }
      });

      // Keydown handlers preserving Enter/Space toggle
      selectBtn.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault();
        event.stopPropagation();
        if (selectedId !== item.id) {
          selectedId = item.id;
          safeSetItem('obs-bible:media:selectedId', selectedId);
          render();
          requestAnimationFrame(() => list.querySelector(`[data-media-id="${item.id}"] .source-row-select-btn`)?.focus());
          return;
        }
        take.click();
      });

      row.append(selectBtn);

      // Reorder & Delete Sibling Controls
      const controls = el('div', 'card-controls');
      
      const upBtn = button('▲', (e) => {
        e.stopPropagation();
        moveUp(overallIndex);
      }, 'card-btn up');
      upBtn.title = 'Move Up';
      upBtn.setAttribute('aria-label', `Move ${item.name} up`);
      if (overallIndex === 0 || searchQuery !== '') upBtn.disabled = true;

      const downBtn = button('▼', (e) => {
        e.stopPropagation();
        moveDown(overallIndex);
      }, 'card-btn down');
      downBtn.title = 'Move Down';
      downBtn.setAttribute('aria-label', `Move ${item.name} down`);
      if (overallIndex === items.length - 1 || searchQuery !== '') downBtn.disabled = true;

      const removeBtn = button('×', (e) => {
        e.stopPropagation();
        removeEntry(overallIndex);
      }, 'card-btn remove');
      removeBtn.title = 'Remove';
      removeBtn.setAttribute('aria-label', `Remove ${item.name}`);

      controls.append(upBtn, downBtn, removeBtn);
      row.append(controls);

      // Status Badge
      const rowState = liveId === item.id && outputState === 'live' ? 'LIVE' : isSelected ? 'SELECTED' : item.kind.toUpperCase();
      const badge = el('span', `badge${rowState === 'LIVE' ? ' on' : ''}`, rowState);
      row.append(badge);

      list.append(row);
    });

    const selectedItem = items.find(i => i.id === selectedId);
    selectionDisplay.textContent = selectedItem?.name || 'Choose media';

    if (selectedItem && (selectedItem.kind === 'image' || selectedItem.kind === 'video')) {
      layoutMenuButton.disabled = false;
      renderLayoutMenu();
      
      const isLive = liveId === selectedItem.id && outputState === 'live';
      const hasChanges = !appliedLayout || selectedItem.layoutPreset !== appliedLayout.preset || selectedItem.layoutCorner !== appliedLayout.corner;
      applyLiveBtn.style.display = (isLive && hasChanges) ? 'block' : 'none';
    } else {
      layoutMenuButton.disabled = true;
      toggleLayoutMenu(false);
    }
    
    take.disabled = !selectedItem || outputState === 'waiting';
    take.textContent = outputState === 'live' && selectedItem?.id === liveId ? 'Hide media' : 'Show media';

    const isLiveVideo = outputState === 'live' && liveId && items.find(i => i.id === liveId)?.kind === 'video';
    videoControls.style.display = isLiveVideo ? 'flex' : 'none';

    stateBadge.textContent = outputState === 'live' ? 'LIVE' : outputState === 'hidden' ? 'HIDDEN' : outputState === 'switching' ? 'LOADING' : outputState === 'error' ? 'MEDIA ERROR' : 'WAITING';
    stateBadge.classList.toggle('on', outputState === 'live');

    // Restore stable focus targeting select button or exact sibling card-control button
    if (focusedId) {
      if (focusedControlClass) {
        const cls = focusedControlClass.split(' ').join('.');
        requestAnimationFrame(() => list.querySelector(`[data-media-id="${focusedId}"] .${cls}`)?.focus({ preventScroll: true }));
      } else {
        requestAnimationFrame(() => list.querySelector(`[data-media-id="${focusedId}"] .source-row-select-btn`)?.focus({ preventScroll: true }));
      }
    }

    updateNotices();
    updateStorageInfo();
  }

  function moveUp(index) {
    if (index <= 0 || index >= items.length) return;
    const temp = items[index];
    items[index] = items[index - 1];
    items[index - 1] = temp;
    
    saveOrder();
    render();
    
    requestAnimationFrame(() => list.querySelector(`[data-media-id="${temp.id}"] .source-row-select-btn`)?.focus());
  }

  function moveDown(index) {
    if (index < 0 || index >= items.length - 1) return;
    const temp = items[index];
    items[index] = items[index + 1];
    items[index + 1] = temp;
    
    saveOrder();
    render();

    requestAnimationFrame(() => list.querySelector(`[data-media-id="${temp.id}"] .source-row-select-btn`)?.focus());
  }

  async function removeEntry(index) {
    const item = items[index];
    if (!item) return;

    const isLiveItem = liveId === item.id && outputState === 'live';
    if (isLiveItem) {
      if (!confirm('This item is currently live on air. Removing it will hide the live output. Are you sure?')) {
        return;
      }
    }

    try {
      await deleteFromDB(item.id);
      
      if (isLiveItem) {
        channel.postMessage({ version: 1, type: 'hide' });
      }

      if (objectUrls.has(item.id)) {
        URL.revokeObjectURL(objectUrls.get(item.id));
        objectUrls.delete(item.id);
      }

      items.splice(index, 1);
      
      if (selectedId === item.id) {
        selectedId = items.length ? items[Math.min(index, items.length - 1)].id : '';
        safeSetItem('obs-bible:media:selectedId', selectedId);
      }

      saveOrder();
      render();

      if (selectedId) {
        requestAnimationFrame(() => list.querySelector(`[data-media-id="${selectedId}"] .source-row-select-btn`)?.focus());
      } else {
        requestAnimationFrame(() => add.focus());
      }
    } catch (err) {
      alert('Failed to delete media from storage: ' + err.message);
    }
  }

  async function updateStorageInfo() {
    let totalBytes = 0;
    items.forEach(item => {
      if (item.file && item.file.size) {
        totalBytes += item.file.size;
      }
    });

    const mbsUsed = (totalBytes / (1024 * 1024)).toFixed(1);
    let text = `${mbsUsed} MB used`;

    if (navigator.storage && navigator.storage.estimate) {
      try {
        const estimate = await navigator.storage.estimate();
        const percent = ((estimate.usage || totalBytes) / estimate.quota * 100).toFixed(1);
        text = `${mbsUsed} MB of ${(estimate.quota / (1024 * 1024)).toFixed(0)} MB (${percent}%)`;
        
        if (percent > 80) {
          storageError = `Storage warning: ${percent}% used. Consider cleaning up.`;
          updateNotices();
        }
      } catch (_) {}
    }
    storageInfo.textContent = text;
  }

  function updateNotices() {
    if (outputState === 'waiting') {
      notice.textContent = 'Enable Emberstage Output (emberstage_output.html) in OBS at the same installed path. Its media layer is not replying. Avoid opening another output window alongside OBS.';
      notice.className = 'notice';
      notice.hidden = false;
    } else if (cameraAbsent) {
      notice.textContent = 'Show a camera in Cameras to use this layout';
      notice.className = 'notice warning';
      notice.hidden = false;
    } else if (outputState === 'error') {
      notice.textContent = "This video codec cannot play in the OBS browser. Convert it to MP4 with H.264 video and AAC audio, then add it again.";
      notice.className = 'notice warning';
      notice.hidden = false;
    } else if (storageError) {
      notice.textContent = storageError;
      notice.className = 'notice warning';
      notice.hidden = false;
    } else {
      notice.textContent = '';
      notice.hidden = true;
    }
  }

  fileInput.addEventListener('change', async () => {
    const skipped = [];
    const importPromises = [];

    for (const file of fileInput.files) {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const isImage = ['jpg', 'jpeg', 'png', 'gif', 'webp'].includes(extension);
      const isVideo = ['mp4', 'webm'].includes(extension);
      const kind = isImage ? 'image' : isVideo ? 'video' : '';
      
      if (kind) {
        const item = {
          id: crypto.randomUUID(),
          name: file.name,
          kind,
          file,
          persisted: true,
          layoutPreset: 'full',
          layoutCorner: 'bottom-right'
        };
        items.push(item);
        
        const p = saveToDB(item).catch(err => {
          item.persisted = false; // Mark session-only on write error
          storageError = 'Storage write failed: ' + err.message;
        });
        importPromises.push(p);
      } else {
        skipped.push(file.name);
      }
    }

    if (skipped.length) {
      storageError = `Could not add ${skipped.join(', ')}. Only standard image (jpg, jpeg, png, gif, webp) and video (mp4, webm) are supported.`;
    } else {
      storageError = '';
    }

    if (!selectedId && items.length) {
      selectedId = items[0].id;
      safeSetItem('obs-bible:media:selectedId', selectedId);
    }

    await Promise.all(importPromises);
    saveOrder();
    fileInput.value = '';
    render();
  });

  searchInput.addEventListener('input', () => {
    searchQuery = searchInput.value.toLowerCase().trim();
    render();
  });

  async function loadLibrary() {
    try {
      db = await initDB();
      const savedItems = await getAllFromDB();
      const order = loadOrder();

      items.length = 0;

      const sorted = [];
      order.forEach(id => {
        const match = savedItems.find(item => item.id === id);
        if (match) {
          match.persisted = true;
          match.layoutPreset = match.layoutPreset || 'full';
          match.layoutCorner = match.layoutCorner || 'bottom-right';
          sorted.push(match);
        }
      });

      savedItems.forEach(item => {
        if (!sorted.some(s => s.id === item.id)) {
          item.persisted = true;
          item.layoutPreset = item.layoutPreset || 'full';
          item.layoutCorner = item.layoutCorner || 'bottom-right';
          sorted.push(item);
        }
      });

      items.push(...sorted);

      selectedId = safeGetItem('obs-bible:media:selectedId') || '';
      if (!items.some(item => item.id === selectedId)) {
        selectedId = items.length ? items[0].id : '';
      }
    } catch (err) {
      db = null; // Mark db null so we fallback to in-memory session-only
      storageError = 'Using session-only library storage: ' + err.message;
    } finally {
      isLoading = false;
      setAddDisabled(false);
      render();
    }
  }

  channel.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    
    lastStatusTime = Date.now();

    if (data.type === 'ready') {
      if (outputState !== 'hidden') {
        outputState = 'hidden';
        render();
      }
    } else if (data.type === 'status') {
      const incomingId = data.id || '';
      const incomingCameraAbsent = !!data.cameraAbsent;
      const nextAppliedLayout = data.state === 'live' ? normalizeAppliedLayout(data.layout) : null;
      const appliedLayoutChanged =
        (appliedLayout?.preset || '') !== (nextAppliedLayout?.preset || '') ||
        (appliedLayout?.corner || '') !== (nextAppliedLayout?.corner || '');
      if (outputState !== data.state || liveId !== incomingId || cameraAbsent !== incomingCameraAbsent || appliedLayoutChanged) {
        outputState = data.state;
        liveId = incomingId;
        cameraAbsent = incomingCameraAbsent;
        appliedLayout = nextAppliedLayout;
        render();
      }
    } else if (data.type === 'progress') {
      if (data.id === liveId && outputState === 'live') {
        updateLiveProgress(data.currentTime, data.duration, data.paused);
      }
    }
  };

  // Heartbeat loop: ping output every 2s
  setInterval(() => {
    channel.postMessage({ version: 1, type: 'ping' });
    if (Date.now() - lastStatusTime > 4000) {
      if (outputState !== 'waiting') {
        outputState = 'waiting';
        render();
      }
    }
  }, 2000);

  add.tabIndex = 0;
  add.addEventListener('keydown', event => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      fileInput.click();
    }
  });

  document.addEventListener('keydown', event => {
    if (event.key === 'Escape') {
      transitionPopover.classList.add('hidden');
    }
  });

  window.addEventListener('pagehide', () => {
    releaseObjectUrls();
    channel.close();
  });

  // Initial load
  loadLibrary();
})();
