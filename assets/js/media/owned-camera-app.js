(function () {
  'use strict';
  // OBS owns all capture. The dock sends explicit scene-item commands and uses
  // OBS screenshots for previews; it never requests browser camera permission.
  const app = document.getElementById('media-app');
  const client = new OBSClient();
  const native = new EmberstageNativeCamera(client);
  const stage = new BroadcastChannel('emberstage-visual-v1');
  const camera = new BroadcastChannel('emberstage-camera-v1');
  const KEY = 'emberstage-native-camera-ui-v1';
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (_) { /* Defaults. */ }
  let selected = '', connected = false, busy = false, refreshTimer = 0, previewVersion = 0;
  let pendingLayout = null, stageTimer = 0, closing = false;
  let reconnectTimer = 0, reconnectDelay = 500;
  let previewTimer = 0, previewCursor = 0;
  let previewTargets = [];
  const previewImages = new Map();
  const previewRetryAfter = new Map();
  const PREVIEW_REFRESH_MS = 1200;
  const PREVIEW_FAILURE_BACKOFF_MS = 5000;
  let currentLayout = { preset: 'full', corner: 'bottom-right' };
  let preDualCameraUuid = saved.preDualCameraUuid || '';
  let preDualFit = saved.preDualFit || '';
  let mediaLive = false;
  const labels = saved.labels && typeof saved.labels === 'object' ? saved.labels : {};
  const el = (tag, cls = '', text) => { const node = document.createElement(tag); node.className = cls; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, cls = '') => { const node = el('button', cls, text); node.type = 'button'; node.addEventListener('click', action); return node; };
  const field = (title, input) => { const label = el('label', 'camera-settings-field'); label.append(el('span', '', title), input); return label; };
  const options = (items, value) => { const node = el('select'); for (const [id, label] of items) { const opt = el('option', '', label); opt.value = id; node.append(opt); } node.value = value; return node; };
  const uuid = input => input.inputUuid;
  const inputName = input => input ? labels[uuid(input)] || input.inputName : 'Choose camera';
  const captureKinds = new Set(['dshow_input', 'av_capture_input', 'macos-avcapture', 'v4l2_input', 'decklink-input', 'aja_source']);
  const available = () => (native.allInputs || []).filter(input => sourceView.value === 'all' || captureKinds.has(input.unversionedInputKind || input.inputKind));
  const current = () => available().find(input => uuid(input) === selected);
  const activeId = () => native.activeInputUuid || '';

  const header = el('header', 'deckbar');
  const logo = el('img', 'ember-brand-logo'); logo.src = 'assets/brand/emberstage-logo.svg'; logo.alt = '';
  const state = el('span', 'badge', 'NOT CONNECTED');
  const scan = button('Rescan', () => void refresh(), 'camera-rescan');
  header.append(logo, el('h1', '', 'Cameras'), state, scan); app.append(header);
  const sourceView = options([['capture', 'Video Capture'], ['all', 'All sources']], saved.sourceView === 'all' ? 'all' : 'capture');
  sourceView.setAttribute('aria-label', 'Source types');
  header.append(field('Sources', sourceView));
  sourceView.addEventListener('change', () => { selected = ''; save(); render(); });
  const dualMenuButton = button('Dual', () => toggleDualMenu(), 'quiet camera-dual-toggle');
  dualMenuButton.setAttribute('aria-label', 'Dual camera settings');
  dualMenuButton.setAttribute('aria-haspopup', 'dialog');
  dualMenuButton.setAttribute('aria-expanded', 'false');
  header.append(dualMenuButton);
  const sizeWrap = el('label', 'dock-ui-scale');
  sizeWrap.setAttribute('aria-label', 'Cameras dock size');
  sizeWrap.append(el('span', 'dock-ui-scale-label', 'Size'));
  const sizeSlider = el('input', 'dock-ui-scale-slider');
  sizeSlider.type = 'range';
  sizeSlider.id = 'camera-dock-scale';
  sizeSlider.min = '80';
  sizeSlider.max = '120';
  sizeSlider.step = '1';
  sizeSlider.value = '100';
  sizeSlider.setAttribute('aria-label', 'Cameras dock size slider');
  const sizeValue = el('span', 'dock-ui-scale-readout', '100%');
  sizeValue.id = 'camera-dock-scale-value';
  sizeWrap.append(sizeSlider, sizeValue); header.append(sizeWrap);
  if (window.EmberstageDockScale) {
    window.EmberstageDockScale.init({
      root: document.body,
      control: sizeSlider,
      output: sizeValue,
      storageKey: 'obs-bible:cameras:ui-scale',
      defaultValue: 100,
      min: 70,
      max: 120,
      step: 1
    });
  }
  const notice = el('div', 'notice'); notice.setAttribute('role', 'status'); notice.hidden = true; app.append(notice);

  const dualSection = el('div', 'camera-dual-popover');
  dualSection.hidden = true;
  dualSection.setAttribute('role', 'dialog');
  dualSection.setAttribute('aria-label', 'Dual camera settings');
  const dualTitle = el('strong', 'dual-title', 'Dual cameras');
  const dualLayout = options([['split', '50/50'], ['inset', 'Big + small']], saved.dualLayout === 'inset' ? 'inset' : 'split');
  const corners = ['top-left', 'top-right', 'bottom-left', 'bottom-right'];
  const dualCorner = options(corners.map(corner => [corner, corner.replace('-', ' ')]), corners.includes(saved.dualCorner) ? saved.dualCorner : 'bottom-right');
  const dualTransition = options([['fade', 'Fade'], ['dip', 'Dip to black'], ['cut', 'Cut']], ['cut', 'fade', 'dip'].includes(saved.dualTransition) ? saved.dualTransition : 'fade');
  const dualDuration = options([['150', '150 ms'], ['300', '300 ms'], ['500', '500 ms']], ['150', '300', '500'].includes(String(saved.dualDuration)) ? String(saved.dualDuration) : '300');
  const dualField = (title, input) => { const node = field(title, input); node.className = 'dual-label'; input.className = 'dual-select'; input.setAttribute('aria-label', title); return node; };
  const dualLeftSelect = el('select', 'dual-select');
  const dualRightSelect = el('select', 'dual-select');
  const fit = options([['cover', 'Fill'], ['contain', 'Fit']], saved.fit === 'contain' ? 'contain' : 'cover');

  function isDualUnchangedActive() {
    if (!connected || !native.live || !native.dual) return false;
    const leftUuid = dualLeftSelect.value;
    const rightUuid = dualRightSelect.value;
    if (!leftUuid || !rightUuid || leftUuid === rightUuid) return false;
    return native.dualLayout === dualLayout.value &&
      (dualLayout.value === 'split' || native.dualCorner === dualCorner.value) &&
      native.activeLeftUuid === leftUuid &&
      native.activeRightUuid === rightUuid &&
      native.currentFit === fit.value;
  }

  const dualApplyBtn = button('Apply 50/50', () => void run(async () => {
    const leftUuid = dualLeftSelect.value;
    const rightUuid = dualRightSelect.value;
    if (!leftUuid || !rightUuid) {
      throw new Error('Please select both cameras.');
    }
    if (leftUuid === rightUuid) {
      throw new Error('Choose two different cameras.');
    }
    if (isDualUnchangedActive()) {
      let targetUuid = preDualCameraUuid;
      let isPriorValid = targetUuid && native.allInputs.some(input => uuid(input) === targetUuid);
      
      if (!targetUuid) {
        targetUuid = leftUuid;
        isPriorValid = targetUuid && available().some(input => uuid(input) === targetUuid);
      } else if (!isPriorValid) {
        throw new Error('The prior single camera is no longer available.');
      }

      if (!isPriorValid) {
        throw new Error('No available camera to restore.');
      }
      
      const targetPreset = mediaLive ? currentLayout.preset : 'full';
      const targetCorner = mediaLive ? currentLayout.corner : 'bottom-right';

      native.currentPreset = targetPreset;
      native.currentCorner = targetCorner;
      currentLayout.preset = targetPreset;
      currentLayout.corner = targetCorner;

      if (preDualFit) {
        fit.value = preDualFit;
      }

      await native.take(targetUuid, { fit: fit.value, transition: dualTransition.value, duration: Number(dualDuration.value) });
      selected = targetUuid;

      preDualCameraUuid = '';
      preDualFit = '';
      save();

      announce('active');
    } else {
      if (!native.dual) {
        preDualCameraUuid = native.activeInputUuid || selected;
        preDualFit = native.currentFit || fit.value;
        save();
      }
      await native.takeDual(leftUuid, rightUuid, { fit: fit.value, layout: dualLayout.value, corner: dualCorner.value, transition: dualTransition.value, duration: Number(dualDuration.value) });
      announce('active');
    }
  }), 'primary');
  
  const dualLeftField = el('label', 'dual-label');
  dualLeftField.append(el('span', '', 'Left Camera'), dualLeftSelect);
  const dualRightField = el('label', 'dual-label');
  dualRightField.append(el('span', '', 'Right Camera'), dualRightSelect);
  const dualCornerField = dualField('Small camera corner', dualCorner);
  const dualSwap = button('Swap cameras', () => {
    [dualLeftSelect.value, dualRightSelect.value] = [dualRightSelect.value, dualLeftSelect.value];
    updateDualControls();
  });

  const dualControls = el('div', 'dual-controls-row');
  dualControls.append(dualField('Dual layout', dualLayout), dualCornerField, dualLeftField, dualRightField, dualField('Dual transition', dualTransition), dualField('Dual speed', dualDuration), dualSwap, dualApplyBtn);
  dualSection.append(dualTitle, dualControls, el('small', 'dual-note', 'Choose cameras and layout, then Apply. Swap changes the selection only. Click Apply again on the active layout to unapply it.'));
  header.append(dualSection);

  function toggleDualMenu(force) {
    if (dualMenuButton.disabled && force !== false) return;
    const shouldOpen = typeof force === 'boolean' ? force : dualSection.hidden;
    dualSection.hidden = !shouldOpen;
    dualMenuButton.setAttribute('aria-expanded', String(shouldOpen));
    if (shouldOpen) updateDualControls();
  }

  const list = el('div', 'source-list owned-library camera-library'); list.setAttribute('aria-label', 'OBS camera sources'); app.append(list);
  const footer = el('footer', 'actionbar');
  const selection = el('div', 'selection selection-stack');
  const selectionName = el('strong', 'selection-name', 'Choose camera');
  const selectionDetail = el('small', 'selection-detail', 'Add a Video Capture Device in OBS.');
  selection.append(selectionName, selectionDetail);
  const settings = el('details', 'camera-settings'); settings.append(el('summary', '', 'Settings'));
  const panel = el('div', 'camera-settings-panel');
  const label = el('input'); label.maxLength = 48;
  const transition = options([['cut', 'Cut'], ['fade', 'Crossfade'], ['dip', 'Dip to black']], ['cut', 'fade', 'dip'].includes(saved.transition) ? saved.transition : 'cut');
  const duration = options([['150', '150 ms'], ['300', '300 ms'], ['500', '500 ms']], ['150', '300', '500'].includes(String(saved.duration)) ? String(saved.duration) : '300');
  panel.append(field('Camera label', label), field('Transition', transition), field('Speed', duration), field('Framing', fit), el('p', 'camera-settings-note', 'Video Capture shows cameras and capture cards. Choose All sources for plugin, network, browser and media inputs. Audio-only inputs have no picture. Emberstage internal sources are excluded.'));
  settings.append(panel);
  const take = button('Show camera', () => void run(async () => {
    if (!native.dual && native.live && activeId() === selected) {
      await native.hide({ transition: transition.value, duration: Number(duration.value) }); announce('inactive');
    } else {
      if (!current()) throw new Error('The selected source is no longer available. Rescan and choose again.');
      
      const targetPreset = mediaLive ? currentLayout.preset : 'full';
      const targetCorner = mediaLive ? currentLayout.corner : 'bottom-right';

      native.currentPreset = targetPreset;
      native.currentCorner = targetCorner;
      currentLayout.preset = targetPreset;
      currentLayout.corner = targetCorner;

      await native.take(selected, { fit: fit.value, transition: transition.value, duration: Number(duration.value) });
      
      preDualCameraUuid = '';
      preDualFit = '';
      save();

      announce('active');
    }
  }), 'primary');
  const hide = button('Hide all', () => void run(async () => { await native.hide({ transition: native.dual ? dualTransition.value : transition.value, duration: Number(native.dual ? dualDuration.value : duration.value) }); announce('inactive'); }));
  footer.append(selection, settings, hide, take); app.append(footer);

  function save() {
    // Explicit allowlist: passwords and authentication responses never persist.
    const value = { labels, transition: transition.value, duration: Number(duration.value), fit: fit.value, sourceView: sourceView.value, dualLayout: dualLayout.value, dualCorner: dualCorner.value, dualTransition: dualTransition.value, dualDuration: Number(dualDuration.value), preDualCameraUuid, preDualFit };
    try { localStorage.setItem(KEY, JSON.stringify(value)); } catch (_) { message('Settings could not be saved. Current controls still work.'); }
  }
  for (const input of [transition, duration]) input.addEventListener('change', save);
  for (const input of [fit, dualLayout, dualCorner, dualTransition, dualDuration]) input.addEventListener('change', () => { save(); updateDualControls(); });
  for (const input of [dualLeftSelect, dualRightSelect]) input.addEventListener('change', updateDualControls);
  function updateDualControls() {
    const inset = dualLayout.value === 'inset';
    dualLeftField.firstChild.textContent = inset ? 'Big camera' : 'Left Camera';
    dualRightField.firstChild.textContent = inset ? 'Small camera' : 'Right Camera';
    dualLeftSelect.setAttribute('aria-label', dualLeftField.firstChild.textContent);
    dualRightSelect.setAttribute('aria-label', dualRightField.firstChild.textContent);
    dualCornerField.hidden = !inset;
    const isUnchanged = isDualUnchangedActive();
    if (isUnchanged) {
      dualApplyBtn.textContent = inset ? 'Unapply big + small' : 'Unapply 50/50';
      dualApplyBtn.setAttribute('aria-pressed', 'true');
    } else {
      dualApplyBtn.textContent = inset ? 'Apply big + small' : 'Apply 50/50';
      dualApplyBtn.setAttribute('aria-pressed', 'false');
    }
    dualApplyBtn.disabled = busy || !connected || !dualLeftSelect.value || !dualRightSelect.value || dualLeftSelect.value === dualRightSelect.value;
    dualSwap.disabled = busy || !connected || !dualLeftSelect.value || !dualRightSelect.value;
    for (const input of [dualLayout, dualCorner, dualLeftSelect, dualRightSelect, dualTransition, dualDuration]) input.disabled = busy || !connected;
  }
  label.addEventListener('change', () => { if (!selected) return; labels[selected] = label.value.trim(); save(); render(); });
  function message(text = '') { notice.textContent = text; notice.hidden = !text; }
  function announce(action = 'status') {
    if (!connected) return;
    const status = native.live ? 'live' : 'hidden';
    stage.postMessage({ version: 1, output: 'camera', action, state: status });
    camera.postMessage({ version: 1, type: 'status', state: status, deviceId: activeId(), native: true });
  }
  function syncLayoutFromNative() {
    currentLayout = {
      preset: native.currentPreset || 'full',
      corner: native.currentCorner || 'bottom-right'
    };
  }
  async function connect() {
    if (busy || connected || closing) return;
    clearTimeout(reconnectTimer);
    busy = true; render(); message('');
    try {
      if (!window.EmberstageNativeInstall) throw new Error('Install the current Emberstage update while OBS is closed to create the native output scene.');
      const config = await loadConnection();
      if (closing) return;
      await client.connect({ url: `ws://127.0.0.1:${config.port}`, password: config.password, requireAuthentication: true });
      await native.initialize(window.EmberstageNativeInstall);
      syncLayoutFromNative();
      connected = true; reconnectDelay = 500; clearTimeout(reconnectTimer); save();
      announce(); stage.postMessage({ version: 1, output: 'camera', action: 'ping' });
    } catch (_) { connected = false; client.disconnect(); message('Waiting for the local OBS connection — retrying automatically. If OBS server settings changed, close OBS and rerun the Emberstage installer.'); }
    finally { busy = false; render(); if (!connected) scheduleReconnect(); }
  }
  async function loadConnection() {
    // The credential is outside the shared app/static directory. A hosted page
    // must never attempt to load it, and no secret is stored in browser storage.
    const value = window.EmberstageNativeInstall?.connectionScript;
    if (location.protocol !== 'file:' || typeof value !== 'string') throw new Error('Automatic local connection is not installed.');
    const url = new URL(value);
    if (url.protocol !== 'file:' || url.host || url.search || url.hash || !url.pathname.endsWith('/Emberstage-private/obs-connection.js')) throw new Error('Invalid private connection path.');
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      const finish = (loaded) => {
        const config = window.EmberstageNativeConnection;
        delete window.EmberstageNativeConnection;
        script.onload = script.onerror = null;
        script.remove();
        if (!loaded || config?.version !== 1 || !Number.isInteger(config.port) || config.port < 1 || config.port > 65535 || typeof config.password !== 'string' || !config.password) reject(new Error('Private connection configuration unavailable.'));
        else resolve(config);
      };
      script.onload = () => finish(true); script.onerror = () => finish(false);
      script.src = url.href;
      document.head.append(script);
    });
  }
  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    if (closing) return;
    reconnectTimer = setTimeout(() => void connect(), reconnectDelay);
    reconnectDelay = Math.min(reconnectDelay * 2, 10000);
  }
  async function run(action) {
    if (!connected || busy) return;
    busy = true; message(''); render();
    try { await action(); }
    catch (error) {
      message(error.message);
      try { if (client.ready) await native.refresh(); } catch (_) { connected = false; }
    } finally { busy = false; render(); announce(); flushLayout(); }
  }
  async function refresh() {
    if (!connected || busy) return;
    await run(async () => { await native.refresh(); syncLayoutFromNative(); });
  }
  function getLayoutTransition(data) {
    if (data?.transition) {
      return {
        transition: data.transition,
        duration: data.duration !== undefined ? Number(data.duration) : 300
      };
    }
    if (transition.value === 'cut') {
      return { transition: 'cut', duration: 0 };
    }
    return { transition: 'fade', duration: 300 };
  }

  function flushLayout() {
    if (!connected || busy || !pendingLayout || closing) return;
    const next = pendingLayout; pendingLayout = null;
    if (next.preset === currentLayout.preset && next.corner === currentLayout.corner) return;
    void run(async () => { await native.layout(next); currentLayout = { preset: next.preset, corner: next.corner }; });
  }
  async function preview(input, frame) {
    const version = previewVersion;
    const id = uuid(input);
    try {
      const result = await native.screenshot(id);
      if (closing || !connected || version !== previewVersion || !frame.isConnected) return;
      const data = typeof result === 'string' ? result : result?.imageData;
      if (!/^data:image\/(png|jpe?g);base64,/.test(data || '')) return;
      previewRetryAfter.delete(id);
      const image = previewImages.get(id) || el('img');
      image.src = data; image.alt = 'Updating OBS thumbnail';
      previewImages.set(id, image);
      if (frame.firstChild !== image) frame.replaceChildren(image);
      frame.title = 'Updating OBS thumbnail (not full-frame-rate video)';
    } catch (_) {
      previewRetryAfter.set(id, Date.now() + PREVIEW_FAILURE_BACKOFF_MS);
      // Keep the last decoded frame during temporary OBS/driver failures.
      if (frame.isConnected) frame.title = previewImages.has(id) ? 'Preview unavailable — showing last frame' : 'OBS preview unavailable for this source';
    }
  }
  async function refreshPreviews() {
    if (closing) return;
    try {
      if (!connected || busy || native.transitioning || document.hidden) return;
      const visible = previewTargets.filter(({ input, frame }) => {
        const rect = frame.getBoundingClientRect?.();
        const bounds = list.getBoundingClientRect?.();
        return frame.isConnected && (previewRetryAfter.get(uuid(input)) || 0) <= Date.now() && rect && bounds && rect.width > 0 && rect.height > 0 && rect.bottom > Math.max(0, bounds.top) && rect.top < Math.min(window.innerHeight, bounds.bottom);
      });
      if (visible.length) {
        const { input, frame } = visible[previewCursor++ % visible.length];
        await preview(input, frame);
      }
    } finally {
      // Old integrated GPUs can fail OBS staging-surface reads under sustained
      // screenshot pressure. Keep previews lightweight and back off failed inputs.
      if (!closing) previewTimer = setTimeout(refreshPreviews, PREVIEW_REFRESH_MS);
    }
  }
  function render() {
    previewVersion++;
    previewTargets = [];
    const focusId = document.activeElement?.closest?.('[data-device-id]')?.dataset.deviceId;
    const entries = connected ? available() : [];
    const ids = new Set(entries.map(uuid));
    for (const id of previewImages.keys()) if (!ids.has(id)) previewImages.delete(id);
    for (const id of previewRetryAfter.keys()) if (!ids.has(id)) previewRetryAfter.delete(id);
    list.replaceChildren();
    for (const [index, input] of entries.entries()) {
      const id = uuid(input);
      const row = button('', () => { selected = id; render(); }, 'source-row camera-card');
      row.dataset.deviceId = id; row.setAttribute('aria-pressed', String(selected === id));
      const frame = el('span', 'source-preview source-preview-camera');
      frame.append(previewImages.get(id) || el('span', 'source-preview-placeholder', String(index + 1).padStart(2, '0')));
      const copy = el('span', 'source-copy'); copy.append(el('span', 'source-name', inputName(input)), el('span', 'source-meta', input.inputName));
      const on = native.live && (native.dual ? [native.activeLeftUuid, native.activeRightUuid].includes(id) : activeId() === id);
      row.append(frame, copy, el('span', on ? 'badge on' : 'badge', on ? 'ON' : selected === id ? 'SELECTED' : 'SOURCE'));
      list.append(row);
      previewTargets.push({ input, frame });
    }
    if (!entries.length) {
      const empty = el('div', 'empty');
      empty.append(el('strong', '', connected ? 'Add sources in OBS' : 'Connecting to OBS automatically'), el('small', '', connected ? (sourceView.value === 'all' ? 'Sources → + → choose any input type.' : 'Sources → + → Video Capture Device. For other inputs choose All sources.') : 'Open OBS normally. No password or special shortcut needed.'));
      list.append(empty);
    }
    // Render Dual Selects
    const prevLeft = dualLeftSelect.value;
    const prevRight = dualRightSelect.value;
    dualLeftSelect.replaceChildren();
    dualRightSelect.replaceChildren();

    if (entries.length > 0) {
      for (const input of entries) {
        const id = uuid(input);
        const name = inputName(input);
        
        const optL = el('option', '', name);
        optL.value = id;
        dualLeftSelect.append(optL);

        const optR = el('option', '', name);
        optR.value = id;
        dualRightSelect.append(optR);
      }
      
      // Restore previous selections or set defaults
      if (prevLeft && [...dualLeftSelect.options].some(o => o.value === prevLeft)) {
        dualLeftSelect.value = prevLeft;
      } else {
        dualLeftSelect.value = uuid(entries[0]);
      }

      if (prevRight && [...dualRightSelect.options].some(o => o.value === prevRight)) {
        dualRightSelect.value = prevRight;
      } else if (entries.length > 1) {
        dualRightSelect.value = uuid(entries[1]);
      } else {
        dualRightSelect.value = uuid(entries[0]);
      }
    } else {
      const optL = el('option', '', 'No cameras');
      optL.value = '';
      dualLeftSelect.append(optL);

      const optR = el('option', '', 'No cameras');
      optR.value = '';
      dualRightSelect.append(optR);
    }

    updateDualControls();
    state.textContent = busy ? 'WORKING' : !connected ? 'NOT CONNECTED' : native.live ? (native.dual ? (native.dualLayout === 'inset' ? 'INSET ON' : '50/50 ON') : 'ON') : 'CONNECTED';
    state.className = `badge${connected ? ' on' : ''}`;
    scan.disabled = !connected || busy;
    dualMenuButton.disabled = !connected;
    selectionName.textContent = inputName(current());
    selectionDetail.textContent = !connected ? 'Automatic local connection.' : !current() ? 'Selection never changes the output.' : native.dual ? 'Dual camera active. Show camera will return to single camera.' : native.live && activeId() === selected ? 'On in Emberstage Program · show that scene in OBS to use it.' : 'Preview only — Show camera applies these settings.';
    take.disabled = busy || !connected || !current();
    take.textContent = !native.dual && native.live && activeId() === selected ? 'Hide camera' : (native.dual ? 'Show Single' : 'Show camera');
    hide.disabled = busy || !connected || !native.live;
    label.disabled = !current(); label.value = current() ? labels[selected] || '' : '';
    if (focusId) [...list.querySelectorAll('[data-device-id]')].find(row => row.dataset.deviceId === focusId)?.focus({ preventScroll: true });
  }
  client.on('status', ({ state }) => {
    if (state !== 'disconnected') return;
    connected = false; pendingLayout = null; mediaLive = false; previewVersion++;
    if (!closing) { render(); scheduleReconnect(); }
  });
  client.on('event', ({ type }) => {
    if (!/InputCreated|InputRemoved|InputNameChanged|SceneItem|SceneCollection|SceneNameChanged/.test(type)) return;
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refresh(), 350);
  });
  stage.onmessage = ({ data }) => {
    if (!data || data.version !== 1 || !connected) return;
    if (data.action === 'ping') { announce(); return; }
    if (data.output !== 'media') return;
    if (data.action === 'active' && data.layout === 'full') {
      // Graphics are above the native camera slots. Full-screen media covers
      // cameras without taking them off air; hiding it reveals the same view.
      mediaLive = true;
      return;
    }
    if (data.action === 'layout-change' || data.action === 'inactive') {
      mediaLive = (data.action !== 'inactive');
      const transOpts = getLayoutTransition(data);
      let presetStr = 'full';
      let cornerStr = 'bottom-right';
      if (data.action === 'inactive') {
        presetStr = 'full';
      } else if (data.preset) {
        presetStr = data.preset;
        cornerStr = data.corner || 'bottom-right';
      } else if (data.layout) {
        if (typeof data.layout === 'object') {
          presetStr = data.layout.preset || 'full';
          cornerStr = data.layout.corner || data.corner || 'bottom-right';
        } else {
          presetStr = data.layout;
          cornerStr = data.corner || 'bottom-right';
        }
      }
      pendingLayout = {
        preset: presetStr,
        corner: cornerStr,
        transition: transOpts.transition,
        duration: transOpts.duration,
        isExplicit: true
      };
      clearTimeout(stageTimer); stageTimer = setTimeout(flushLayout, 25);
    } else if (data.action === 'status' && data.layout) {
      if (busy || native.transitioning || (pendingLayout && pendingLayout.isExplicit)) return;
      mediaLive = (data.state === 'live');
      const transOpts = getLayoutTransition(data);
      let presetStr = 'full';
      let cornerStr = 'bottom-right';
      if (typeof data.layout === 'object') {
        presetStr = data.layout.preset || 'full';
        cornerStr = data.layout.corner || data.corner || 'bottom-right';
      } else {
        presetStr = data.layout;
        cornerStr = data.corner || 'bottom-right';
      }
      if (data.state === 'live' && presetStr === 'full') {
        return;
      }
      pendingLayout = {
        preset: data.state === 'live' && native.live ? presetStr : 'full',
        corner: data.state === 'live' && native.live ? cornerStr : 'bottom-right',
        transition: transOpts.transition,
        duration: transOpts.duration,
        isExplicit: false
      };
      clearTimeout(stageTimer); stageTimer = setTimeout(flushLayout, 25);
    }
  };
  camera.onmessage = ({ data }) => { if (data?.version === 1 && data.type === 'ping') announce(); };
  document.addEventListener?.('pointerdown', event => {
    if (!dualSection.hidden && !dualSection.contains(event.target) && !dualMenuButton.contains(event.target)) toggleDualMenu(false);
  });
  document.addEventListener?.('keydown', event => {
    if (event.key === 'Escape' && !dualSection.hidden) {
      toggleDualMenu(false);
      dualMenuButton.focus();
    }
  });
  const heartbeat = setInterval(() => { announce(); }, 2000);
  addEventListener('pagehide', () => { closing = true; previewVersion++; clearTimeout(previewTimer); previewImages.clear(); previewRetryAfter.clear(); clearInterval(heartbeat); clearTimeout(refreshTimer); clearTimeout(stageTimer); clearTimeout(reconnectTimer); native.dispose(); client.disconnect(); stage.close(); camera.close(); });
  render();
  void connect();
  void refreshPreviews();
})();
