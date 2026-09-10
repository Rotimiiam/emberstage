(function () {
  'use strict';
  const app = document.getElementById('media-app');
  const channel = new BroadcastChannel('emberstage-camera-v1');
  let devices = [], selected = '', outputState = 'waiting', liveDeviceId = '';
  let previewStream = null, previewDeviceId = '', previewVersion = 0, previewEnabled = false;
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, className = '') => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; };

  function selectorValue(value) {
    return typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(value) : value.replace(/(["\\])/g, '\\$1');
  }

  function previewMonogram(device, index) {
    const label = (device.label || `Camera ${index + 1}`).replace(/[^a-z0-9 ]/gi, ' ').trim();
    const letters = label.split(/\s+/).filter(Boolean).slice(0, 2).map(part => part[0].toUpperCase()).join('');
    return letters || String(index + 1).padStart(2, '0');
  }

  function stopPreview(invalidate = true) {
    if (invalidate) previewVersion++;
    if (previewStream) previewStream.getTracks().forEach(track => track.stop());
    previewStream = null;
    previewDeviceId = '';
  }

  function previewFrame(device, index, note = 'Select') {
    const frame = el('span', 'source-preview source-preview-camera');
    frame.setAttribute('aria-hidden', 'true');
    frame.append(
      el('span', 'source-preview-placeholder', previewMonogram(device, index)),
      el('span', 'source-preview-index', String(index + 1).padStart(2, '0')),
      el('span', 'source-preview-note', note)
    );
    return frame;
  }

  function setPreviewState(deviceId, note, live = false) {
    if (!deviceId) return;
    const frame = list.querySelector(`.source-row[data-device-id="${selectorValue(deviceId)}"] .source-preview`);
    if (!frame) return;
    const index = devices.findIndex(device => device.deviceId === deviceId);
    const device = devices[index];
    if (!device) return;
    frame.replaceChildren(
      el('span', 'source-preview-placeholder', previewMonogram(device, index)),
      el('span', 'source-preview-index', String(index + 1).padStart(2, '0')),
      el('span', 'source-preview-note', note)
    );
    frame.classList.toggle('source-preview-live', live);
    const row = frame.closest('.source-row');
    row?.setAttribute('data-preview-state', live ? 'live' : note === 'Opening…' ? 'loading' : note === 'Preview unavailable' ? 'unavailable' : 'idle');
  }

  function mountPreview(stream, deviceId) {
    const frame = list.querySelector(`.source-row[data-device-id="${selectorValue(deviceId)}"] .source-preview`);
    if (!frame) return;
    const index = devices.findIndex(device => device.deviceId === deviceId);
    const video = document.createElement('video');
    video.autoplay = true;
    video.muted = true;
    video.defaultMuted = true;
    video.playsInline = true;
    video.srcObject = stream;
    video.setAttribute('aria-hidden', 'true');
    video.addEventListener('loadedmetadata', () => video.play().catch(() => {}), { once: true });
    frame.replaceChildren(video, el('span', 'source-preview-index', String(index + 1).padStart(2, '0')), el('span', 'source-preview-note', 'Local preview'));
    frame.classList.add('source-preview-live');
    frame.closest('.source-row')?.setAttribute('data-preview-state', 'live');
  }

  async function syncPreview() {
    if (!selected || !previewEnabled) {
      stopPreview();
      return;
    }
    if (outputState === 'live' && liveDeviceId === selected) {
      stopPreview();
      setPreviewState(selected, 'On air');
      return;
    }
    if (!navigator.mediaDevices?.getUserMedia) {
      stopPreview(false);
      setPreviewState(selected, 'Preview off');
      return;
    }
    if (previewStream && previewDeviceId === selected) {
      mountPreview(previewStream, selected);
      return;
    }
    stopPreview();
    setPreviewState(selected, 'Opening…');
    const version = previewVersion;
    try {
      const nextStream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { deviceId: { exact: selected }, width: { ideal: 320 }, height: { ideal: 180 } }
      });
      if (version !== previewVersion) {
        nextStream.getTracks().forEach(track => track.stop());
        return;
      }
      previewStream = nextStream;
      previewDeviceId = selected;
      mountPreview(nextStream, selected);
    } catch (_) {
      if (version === previewVersion) setPreviewState(selected, 'Preview unavailable');
    }
  }

  const header = el('header', 'deckbar');
  const brand = el('div', 'dock-brand-lockup');
  const brandLogo = document.createElement('img'); brandLogo.className = 'ember-brand-logo'; brandLogo.src = 'assets/brand/emberstage-logo.svg'; brandLogo.alt = '';
  const brandStack = el('div', 'dock-brand-stack');
  const brandWordmark = document.createElement('img'); brandWordmark.className = 'ember-brand-wordmark'; brandWordmark.src = 'assets/brand/emberstage-wordmark.svg'; brandWordmark.alt = 'Emberstage for OBS';
  brandStack.append(brandWordmark, el('span', 'dock-brand-kicker', 'Camera dock'));
  brand.append(brandLogo, brandStack);
  header.append(brand, el('h1', '', 'Cameras'));
  const state = el('span', 'badge', 'OUTPUT'); header.append(state); const scan = button('Scan cameras', discover, 'primary'); header.append(scan); app.append(header);
  const notice = el('div', 'notice'); notice.hidden = true; app.append(notice);
  const list = el('div', 'source-list owned-library'); list.setAttribute('aria-label', 'Available camera devices'); app.append(list);
  const footer = el('footer', 'actionbar'); const selection = el('div', 'selection', 'Choose camera');
  const fitLabel = el('label', 'check'); const fit = el('input'); fit.type = 'checkbox'; fit.checked = true; fitLabel.append(fit, document.createTextNode('Fill'));
  const turnOff = button('Turn camera off', () => {
    previewEnabled = false;
    stopPreview();
    channel.postMessage({ version: 1, type: 'hide' });
    render();
  });
  const take = button('Show camera', () => {
    if (!selected) return;
    stopPreview();
    if (outputState === 'live' && liveDeviceId === selected) {
      previewEnabled = false;
      channel.postMessage({ version: 1, type: 'hide' });
    }
    else channel.postMessage({ version: 1, type: 'take', deviceId: selected, fit: fit.checked ? 'cover' : 'contain' });
  }, 'primary');
  footer.append(selection, fitLabel, turnOff, take); app.append(footer);

  async function discover() {
    notice.hidden = true; scan.disabled = true;
    try {
      if (!navigator.mediaDevices?.enumerateDevices) {
        throw new DOMException('Camera APIs are disabled in this OBS browser session.', 'NotAllowedError');
      }
      devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      if (!devices.length || devices.every(device => !device.label)) {
        const permission = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
        permission.getTracks().forEach(track => track.stop());
        devices = (await navigator.mediaDevices.enumerateDevices()).filter(device => device.kind === 'videoinput');
      }
      if (!selected && devices.length) selected = devices[0].deviceId;
      if (!devices.length) throw new Error('No browser-visible cameras were found.');
    } catch (error) {
      try { devices = (await navigator.mediaDevices?.enumerateDevices?.() || []).filter(device => device.kind === 'videoinput'); } catch (_) { devices = []; }
      const denied = error?.name === 'NotAllowedError' || error?.name === 'SecurityError';
      const unavailable = !navigator.mediaDevices?.enumerateDevices;
      notice.textContent = denied
        ? unavailable
          ? 'Camera access is disabled for this OBS session. Fully quit OBS, then start it with --enable-media-stream. On macOS, use scripts/start-obs-camera-mode-macos.command.'
          : 'Camera access was denied. Allow OBS under System Settings → Privacy & Security → Camera, then fully restart OBS with --enable-media-stream.'
        : `${error?.message || 'No browser-visible cameras were found.'} If Iriun is already active as an OBS Video Capture Device, disable that source first so the browser output can open it.`;
      notice.hidden = false;
    } finally { scan.disabled = false; render(); }
  }
  function render() {
    list.replaceChildren();
    if (!devices.length) {
      const empty = el('div', 'empty'); empty.append(el('strong', '', 'Scan connected cameras'), el('small', '', 'OBS must be started in camera mode; a camera already active in another OBS source may be unavailable.')); list.append(empty);
    }
    devices.forEach((device, index) => {
      const row = button('', () => { selected = device.deviceId; previewEnabled = true; render(); }, 'source-row'); row.setAttribute('aria-pressed', String(device.deviceId === selected));
      row.dataset.deviceId = device.deviceId;
      row.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation();
        if (selected !== device.deviceId) {
          selected = device.deviceId; previewEnabled = true; render();
          requestAnimationFrame(() => Array.from(list.querySelectorAll('.source-row')).find(item => item.dataset.deviceId === device.deviceId)?.focus());
          return;
        }
        take.click();
      });
      row.append(previewFrame(device, index, device.deviceId === selected ? 'Select' : 'Ready'));
      const copy = el('span', 'source-copy'); copy.append(el('span', 'source-name', device.label || `Camera ${index + 1}`), el('span', 'source-meta', 'Local video device'));
      const rowState = liveDeviceId === device.deviceId && outputState === 'live' ? 'LIVE' : device.deviceId === selected ? 'SELECTED' : 'CAMERA';
      row.append(copy, el('span', `badge${rowState === 'LIVE' ? ' on' : ''}`, rowState)); list.append(row);
    });
    const index = devices.findIndex(device => device.deviceId === selected);
    selection.textContent = index < 0 ? 'Choose camera' : devices[index].label || `Camera ${index + 1}`;
    turnOff.hidden = outputState !== 'live' && !previewEnabled;
    take.disabled = !selected || outputState === 'waiting';
    take.textContent = outputState === 'live' && liveDeviceId === selected ? 'Hide camera' : 'Show camera';
    state.textContent = outputState === 'live' ? 'LIVE' : outputState === 'error' ? 'CAMERA ERROR' : outputState === 'hidden' ? 'HIDDEN' : 'WAITING'; state.classList.toggle('on', outputState === 'live');
    queueMicrotask(syncPreview);
  }
  channel.onmessage = ({ data }) => {
    if (data?.version !== 1) return;
    if (data.type === 'ready') { outputState = 'hidden'; render(); }
    if (data.type === 'status') { outputState = data.state; liveDeviceId = data.deviceId || liveDeviceId; render(); }
  };
  channel.postMessage({ version: 1, type: 'ping' });
  addEventListener('pagehide', () => { stopPreview(); channel.close(); });
  render();
})();
