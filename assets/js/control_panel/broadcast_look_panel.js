(function () {
  const branding = window.OBSBibleBroadcastBranding;
  if (!branding) return;
  const panelRefreshers = [];

  function initializePanel(target) {
  const field = (id) => document.getElementById((target === 'text' ? 'text-' : '') + 'broadcast-look-' + id);
  const elements = {
    panel: field('panel'),
    layout: field('layout'),
    churchName: field('church-name'),
    logoUpload: field('logo-upload'),
    logoRemove: field('logo-remove'),
    logoStatus: field('logo-status'),
    accentColor: field('accent'),
    logoPosition: field('logo-position'),
    entranceStyle: field('entrance-style'),
    entranceDuration: field('entrance-duration'),
    exitStyle: field('exit-style'),
    exitDuration: field('exit-duration'),
    safeMargin: field('safe-margin'),
    applyButton: field('apply'),
    restoreButton: field('restore-legacy'),
    applyStatus: field('apply-status'),
    preview: field('preview'),
    previewBadge: field('preview-badge'),
    previewCard: field('preview-card'),
    previewCorner: field('preview-corner'),
    previewInline: field('preview-inline-brand'),
    previewLogo: field('preview-logo'),
    previewCornerLogo: field('preview-corner-logo'),
    previewChurchName: field('preview-church-name'),
    previewCornerName: field('preview-corner-name'),
    previewReference: field('preview-reference'),
    previewVerse: field('preview-verse'),
  };

  if (!elements.panel) return;

  const sampleVerse = {
    reference: 'Psalm 121:1',
    verseText: 'I will lift up mine eyes unto the hills, from whence cometh my help.',
  };

  const storageKeys = target === 'text' ? branding.TEXT_STORAGE_KEYS : branding.STORAGE_KEYS;
  let draftSettings = readStoredSettings(storageKeys.draft)
    || readStoredSettings(storageKeys.applied)
    || branding.sanitizeBroadcastSettings();
  let appliedSettings = readStoredSettings(storageKeys.applied)
    || branding.sanitizeBroadcastSettings();
  let logoRequest = 0;

  function readStoredSettings(key) {
    try {
      const value = localStorage.getItem(key);
      return value ? branding.sanitizeBroadcastSettings(JSON.parse(value)) : null;
    } catch (_) {
      return null;
    }
  }

  function writeStoredSettings(key, value) {
    try {
      localStorage.setItem(key, JSON.stringify(branding.sanitizeBroadcastSettings(value)));
      return true;
    } catch (_) { return false; }
  }

  function updateLogoStatus(message, tone) {
    elements.logoStatus.textContent = message;
    elements.logoStatus.dataset.tone = tone || 'muted';
  }

  function updateApplyStatus() {
    const pending = JSON.stringify(draftSettings) !== JSON.stringify(appliedSettings);
    elements.applyStatus.textContent = pending
      ? `Draft only · live ${target} stays unchanged until Apply.`
      : draftSettings.layout === 'legacy'
        ? `Applied · ${target} uses the legacy look.`
        : `Applied · live and future ${target} cues use this broadcast look.`;
    elements.panel.classList.toggle('broadcast-look-pending', pending);
  }

  function renderPreview() {
    const settings = draftSettings;
    const hasBrand = Boolean(settings.logoDataUrl || settings.churchName);
    elements.preview.dataset.layout = settings.layout;
    elements.preview.dataset.logoPosition = settings.logoPosition;
    elements.preview.style.setProperty('--broadcast-preview-accent', settings.accentColor);
    elements.previewBadge.textContent = settings.layout === 'legacy'
      ? 'Legacy preview'
      : settings.layout === 'lower-third'
        ? 'Lower third preview'
        : 'Full-screen preview';
    const text = document.getElementById('messageInput')?.value || 'Welcome!\nWe are glad you are here.';
    elements.preview.dataset.target = target;
    elements.previewReference.hidden = target === 'text';
    elements.previewReference.textContent = target === 'text' ? '' : sampleVerse.reference.toUpperCase();
    elements.previewVerse.textContent = target === 'text' ? parseMessageInput(text).text : sampleVerse.verseText;
    elements.previewChurchName.textContent = settings.churchName;
    elements.previewCornerName.textContent = settings.churchName;

    [elements.previewLogo, elements.previewCornerLogo].forEach((img) => {
      if (settings.logoDataUrl) {
        if (img.getAttribute('src') !== settings.logoDataUrl) img.src = settings.logoDataUrl;
        img.hidden = false;
      } else {
        img.removeAttribute('src');
        img.hidden = true;
      }
    });

    elements.previewInline.hidden = !(settings.logoPosition === 'in-card' && hasBrand);
    elements.previewCorner.hidden = settings.logoPosition === 'in-card' || !hasBrand;
    elements.previewCard.classList.toggle('has-inline-brand', !elements.previewInline.hidden);
  }

  function syncFormFromDraft() {
    elements.layout.value = draftSettings.layout;
    elements.churchName.value = draftSettings.churchName;
    elements.accentColor.value = draftSettings.accentColor;
    elements.logoPosition.value = draftSettings.logoPosition;
    elements.entranceStyle.value = draftSettings.entranceStyle;
    elements.entranceDuration.value = String(draftSettings.entranceDuration);
    elements.exitStyle.value = draftSettings.exitStyle;
    elements.exitDuration.value = String(draftSettings.exitDuration);
    if (elements.safeMargin) elements.safeMargin.value = String(draftSettings.safeMarginPercent);
    updateLogoStatus(draftSettings.logoDataUrl ? 'Logo ready' : 'PNG, JPG, WebP, or GIF · up to 1 MB.', draftSettings.logoDataUrl ? 'ok' : 'muted');
    updateApplyStatus();
    renderPreview();
  }

  function syncDraftFromForm() {
    draftSettings = branding.sanitizeBroadcastSettings({
      layout: elements.layout.value,
      churchName: elements.churchName.value,
      logoDataUrl: draftSettings.logoDataUrl,
      accentColor: elements.accentColor.value,
      logoPosition: elements.logoPosition.value,
      entranceStyle: elements.entranceStyle.value,
      entranceDuration: Number(elements.entranceDuration.value),
      exitStyle: elements.exitStyle.value,
      exitDuration: Number(elements.exitDuration.value),
      safeMarginPercent: elements.safeMargin ? Number(elements.safeMargin.value) : draftSettings.safeMarginPercent,
    }, draftSettings);
    writeStoredSettings(storageKeys.draft, draftSettings);
    updateApplyStatus();
    renderPreview();
  }

  async function readLogoFile(file) {
    if (!file) throw new Error('Choose a logo file first.');
    if (!branding.isAllowedLogoMimeType(file.type)) throw new Error('Only PNG, JPG, WebP, and GIF logos are allowed.');
    if (file.size > branding.MAX_LOGO_FILE_BYTES) throw new Error('Logo is too large. Keep it under 1 MB.');

    const dataUrl = await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onerror = () => reject(new Error('Logo upload could not be read.'));
      reader.onload = () => resolve(String(reader.result || ''));
      reader.readAsDataURL(file);
    });

    if (!branding.isSafeLogoDataUrl(dataUrl)) throw new Error('Logo format was rejected after reading.');

    const dimensions = await new Promise((resolve, reject) => {
      const image = new Image();
      image.onerror = () => reject(new Error('Logo could not be decoded.'));
      image.onload = () => resolve({ width: image.naturalWidth, height: image.naturalHeight });
      image.src = dataUrl;
    });

    if (dimensions.width < branding.MIN_LOGO_DIMENSION || dimensions.height < branding.MIN_LOGO_DIMENSION) {
      throw new Error('Logo is too small. Use at least 24 × 24 pixels.');
    }
    if (dimensions.width > branding.MAX_LOGO_DIMENSION || dimensions.height > branding.MAX_LOGO_DIMENSION) {
      throw new Error('Logo is too large. Keep each side at or below 4096 pixels.');
    }
    if ((dimensions.width * dimensions.height) > branding.MAX_LOGO_PIXELS) {
      throw new Error('Logo has too many pixels for local storage.');
    }

    return dataUrl;
  }

  function broadcastAppliedSettings() {
    const channel = new BroadcastChannel('settings');
    channel.postMessage({ protocol: branding.PROTOCOL, target, broadcastLook: appliedSettings });
    channel.close();
  }

  function applyDraftSettings() {
    const nextSettings = branding.sanitizeBroadcastSettings(draftSettings);
    if (!writeStoredSettings(storageKeys.applied, nextSettings)) {
      elements.applyStatus.textContent = 'Not applied: local storage is full. Try a smaller logo.';
      return;
    }
    appliedSettings = nextSettings;
    draftSettings = branding.sanitizeBroadcastSettings(draftSettings);
    writeStoredSettings(storageKeys.draft, draftSettings);
    updateApplyStatus();
    broadcastAppliedSettings();
  }

  function restoreLegacy() {
    ++logoRequest;
    draftSettings = branding.sanitizeBroadcastSettings(branding.DEFAULT_BROADCAST_SETTINGS);
    appliedSettings = branding.sanitizeBroadcastSettings(branding.DEFAULT_BROADCAST_SETTINGS);
    writeStoredSettings(storageKeys.draft, draftSettings);
    writeStoredSettings(storageKeys.applied, appliedSettings);
    if (elements.logoUpload) elements.logoUpload.value = '';
    syncFormFromDraft();
    broadcastAppliedSettings();
  }

  ['change', 'input'].forEach((eventName) => {
    [
      elements.layout,
      elements.churchName,
      elements.accentColor,
      elements.logoPosition,
      elements.entranceStyle,
      elements.entranceDuration,
      elements.exitStyle,
      elements.exitDuration,
      elements.safeMargin,
    ].forEach((field) => field?.addEventListener(eventName, syncDraftFromForm));
  });

  elements.logoUpload?.addEventListener('change', async () => {
    const request = ++logoRequest;
    const previousLogo = draftSettings.logoDataUrl;
    const file = elements.logoUpload.files && elements.logoUpload.files[0];
    if (!file) return;

    updateLogoStatus('Checking logo…', 'muted');
    try {
      const dataUrl = await readLogoFile(file);
      if (request !== logoRequest) return;
      draftSettings = branding.sanitizeBroadcastSettings(Object.assign({}, draftSettings, { logoDataUrl: dataUrl }));
      writeStoredSettings(storageKeys.draft, draftSettings);
      updateLogoStatus('Logo ready', 'ok');
    } catch (error) {
      if (request !== logoRequest) return;
      draftSettings = branding.sanitizeBroadcastSettings(Object.assign({}, draftSettings, { logoDataUrl: previousLogo }));
      writeStoredSettings(storageKeys.draft, draftSettings);
      updateLogoStatus(error.message || 'Logo upload failed.', 'error');
    }
    updateApplyStatus();
    renderPreview();
  });

  elements.logoRemove?.addEventListener('click', () => {
    ++logoRequest;
    draftSettings = branding.sanitizeBroadcastSettings(Object.assign({}, draftSettings, { logoDataUrl: '' }));
    if (elements.logoUpload) elements.logoUpload.value = '';
    writeStoredSettings(storageKeys.draft, draftSettings);
    updateLogoStatus('Logo removed from draft.', 'muted');
    updateApplyStatus();
    renderPreview();
  });

  elements.applyButton?.addEventListener('click', applyDraftSettings);
  elements.restoreButton?.addEventListener('click', restoreLegacy);
  document.getElementById('messageInput')?.addEventListener('input', () => {
    if (target === 'text') renderPreview();
  });

  function reloadFromStorage(nextDraft, nextApplied) {
    draftSettings = branding.sanitizeBroadcastSettings(nextDraft);
    appliedSettings = branding.sanitizeBroadcastSettings(nextApplied);
    writeStoredSettings(storageKeys.draft, draftSettings);
    writeStoredSettings(storageKeys.applied, appliedSettings);
    syncFormFromDraft();
    broadcastAppliedSettings();
  }
  panelRefreshers.push({ target, readDraft: () => draftSettings, reloadFromStorage });

  syncFormFromDraft();
  elements.panel.dataset.ready = 'true';
  }

  // Reuse the form markup, but keep each editor's IDs, draft and applied state independent.
  const scripturePanel = document.getElementById('broadcast-look-panel');
  if (!scripturePanel) return;
  const textPanel = scripturePanel.cloneNode(true);
  for (const element of [textPanel, ...textPanel.querySelectorAll('[id]')]) {
    element.id = 'text-' + element.id;
  }
  textPanel.querySelectorAll('[for]').forEach((label) => {
    label.htmlFor = 'text-' + label.htmlFor;
  });
  textPanel.querySelector('#text-broadcast-look-library')?.remove();
  textPanel.querySelector('.broadcast-look-title').textContent = 'Text broadcast look';
  textPanel.querySelector('.broadcast-look-copy').textContent = 'Preview Text changes, then Apply. Scripture styling stays unchanged.';
  textPanel.querySelector('option[value="in-card"]').textContent = 'Left of text';
  document.getElementById('text-style-content').appendChild(textPanel);
  initializePanel('scripture');
  initializePanel('text');

  function readLooks() {
    try {
      return branding.sanitizeChurchLooks(JSON.parse(localStorage.getItem(branding.LOOKS_KEY) || '[]'));
    } catch (error) {
      return [];
    }
  }

  function writeLooks(looks) {
    localStorage.setItem(branding.LOOKS_KEY, JSON.stringify(branding.sanitizeChurchLooks(looks)));
  }

  function setLookStatus(message) {
    const status = document.getElementById('broadcast-look-library-status');
    if (status) status.textContent = message;
  }

  function renderLooks(selectedName) {
    const select = document.getElementById('broadcast-look-library-select');
    if (!select) return;
    const looks = readLooks();
    const current = selectedName || select.value;
    select.replaceChildren();
    const empty = document.createElement('option');
    empty.value = '';
    empty.textContent = looks.length ? 'Saved looks' : 'No saved looks';
    select.appendChild(empty);
    for (const look of looks) {
      const option = document.createElement('option');
      option.value = look.name;
      option.textContent = look.name;
      select.appendChild(option);
    }
    select.value = looks.some(look => look.name === current) ? current : '';
  }

  function currentDraft(target) {
    return panelRefreshers.find(panel => panel.target === target)?.readDraft() || branding.sanitizeBroadcastSettings();
  }

  document.getElementById('broadcast-look-library-save')?.addEventListener('click', () => {
    const name = document.getElementById('broadcast-look-library-name').value;
    const look = branding.sanitizeChurchLook({
      name,
      scripture: currentDraft('scripture'),
      text: currentDraft('text'),
    });
    if (!look) {
      setLookStatus('Name the look first.');
      return;
    }
    writeLooks(branding.upsertChurchLook(readLooks(), look));
    document.getElementById('broadcast-look-library-name').value = look.name;
    renderLooks(look.name);
    setLookStatus('Saved ' + look.name + '.');
  });

  document.getElementById('broadcast-look-library-use')?.addEventListener('click', () => {
    const name = document.getElementById('broadcast-look-library-select').value;
    const look = readLooks().find(item => item.name === name);
    if (!look) {
      setLookStatus('Choose a saved look.');
      return;
    }
    for (const panel of panelRefreshers) {
      const settings = panel.target === 'text' ? look.text : look.scripture;
      panel.reloadFromStorage(settings, settings);
    }
    document.getElementById('broadcast-look-library-name').value = look.name;
    setLookStatus('Using ' + look.name + '.');
  });

  document.getElementById('broadcast-look-library-delete')?.addEventListener('click', () => {
    const name = document.getElementById('broadcast-look-library-select').value;
    if (!name) {
      setLookStatus('Choose a look to delete.');
      return;
    }
    writeLooks(branding.removeChurchLook(readLooks(), name));
    renderLooks('');
    setLookStatus('Deleted ' + name + '.');
  });

  document.getElementById('broadcast-look-library-select')?.addEventListener('change', (event) => {
    document.getElementById('broadcast-look-library-name').value = event.target.value;
  });
  renderLooks('');


  const textDialog = document.getElementById('text-style-dialog');
  document.getElementById('text-style-open').addEventListener('click', () => textDialog.showModal());
  document.getElementById('text-style-close').addEventListener('click', () => textDialog.close());

  window.__obsBibleBroadcastLookPanelReady = true;
  window.dispatchEvent(new CustomEvent('obs-bible:broadcast-look-panel-ready', {
    detail: {
      protocol: branding.PROTOCOL,
      controls: {
        layout: 'broadcast-look-layout',
        churchName: 'broadcast-look-church-name',
        logoUpload: 'broadcast-look-logo-upload',
        logoRemove: 'broadcast-look-logo-remove',
        accentColor: 'broadcast-look-accent',
        logoPosition: 'broadcast-look-logo-position',
        entranceStyle: 'broadcast-look-entrance-style',
        entranceDuration: 'broadcast-look-entrance-duration',
        exitStyle: 'broadcast-look-exit-style',
        exitDuration: 'broadcast-look-exit-duration',
        applyButton: 'broadcast-look-apply',
        restoreButton: 'broadcast-look-restore-legacy',
        preview: 'broadcast-look-preview',
      },
    },
  }));
})();
