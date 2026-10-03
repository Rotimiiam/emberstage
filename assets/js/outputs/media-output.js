(function () {
  'use strict';
  const output = document.getElementById('output');
  const media = new BroadcastChannel('emberstage-media-v1');
  const stage = new BroadcastChannel('emberstage-visual-v1');
  const transition = EmberstageTransition.create(output);
  let current = null, pending = null, generation = 0, failure = '';
  let cameraActive = false;
  let cameraSeenAt = 0;
  let currentLayout = { preset: 'full', corner: 'bottom-right' };
  let currentTransition = 'fade';
  let currentDuration = 300;
  let isHiding = false;
  let layoutAnimations = [];
  let lastGeom = { left: 0, top: 0, width: 100, height: 100 };
  let lastClipPath = '';

  function normalizeLayout(value) {
    return {
      preset: ['full', 'split-left', 'split-right', 'camera-inset'].includes(value?.preset) ? value.preset : 'full',
      corner: ['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(value?.corner) ? value.corner : 'bottom-right'
    };
  }

  function sendStageStatus() {
    const layout = isHiding ? { preset: 'full', corner: 'bottom-right' } : (currentLayout || { preset: 'full', corner: 'bottom-right' });
    stage.postMessage({
      version: 1,
      output: 'media',
      action: 'status',
      state: isHiding ? 'hidden' : current ? 'live' : failure ? 'error' : 'hidden',
      layout: layout
    });
  }

  function applyLayout(item = current, transitionType = currentTransition, durationVal = currentDuration) {
    const layout = currentLayout || { preset: 'full', corner: 'bottom-right' };
    const actualPreset = (!item || !cameraActive) ? 'full' : layout.preset;

    const geom = EmberstageLayoutHelper.getLayoutGeometry(actualPreset, layout.corner);
    const targetLeft = geom.media.left;
    const targetTop = geom.media.top;
    const targetWidth = geom.media.width;
    const targetHeight = geom.media.height;

    const clipPath = EmberstageLayoutHelper.getMediaClipPath(actualPreset, layout.corner, cameraActive);

    // Cancel existing layout animations
    layoutAnimations.forEach(anim => { try { anim.cancel(); } catch (_) {} });
    layoutAnimations = [];

    const reduced = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    const isCut = transitionType === 'cut' || durationVal === 0 || reduced;

    const isDifferent = lastGeom.left !== targetLeft ||
                        lastGeom.top !== targetTop ||
                        lastGeom.width !== targetWidth ||
                        lastGeom.height !== targetHeight;

    if (isCut || !current || !isDifferent) {
      output.style.setProperty('--layout-left', targetLeft + '%');
      output.style.setProperty('--layout-top', targetTop + '%');
      output.style.setProperty('--layout-width', targetWidth + '%');
      output.style.setProperty('--layout-height', targetHeight + '%');
      output.style.clipPath = clipPath;

      const layers = output.querySelectorAll('.output-layer, .output-blackout');
      layers.forEach(layer => {
        layer.style.left = '';
        layer.style.top = '';
        layer.style.width = '';
        layer.style.height = '';
      });

      lastGeom = { left: targetLeft, top: targetTop, width: targetWidth, height: targetHeight };
      lastClipPath = clipPath;
    } else {
      output.style.setProperty('--layout-left', targetLeft + '%');
      output.style.setProperty('--layout-top', targetTop + '%');
      output.style.setProperty('--layout-width', targetWidth + '%');
      output.style.setProperty('--layout-height', targetHeight + '%');
      output.style.clipPath = clipPath;

      const layers = output.querySelectorAll('.output-layer, .output-blackout');
      layers.forEach(layer => {
        if (typeof layer.animate === 'function') {
          const anim = layer.animate([
            {
              left: lastGeom.left + '%',
              top: lastGeom.top + '%',
              width: lastGeom.width + '%',
              height: lastGeom.height + '%'
            },
            {
              left: targetLeft + '%',
              top: targetTop + '%',
              width: targetWidth + '%',
              height: targetHeight + '%'
            }
          ], {
            duration: durationVal,
            easing: 'ease-in-out',
            fill: 'both'
          });
          layoutAnimations.push(anim);
        }
      });

      lastGeom = { left: targetLeft, top: targetTop, width: targetWidth, height: targetHeight };
      lastClipPath = clipPath;
    }

    stage.postMessage({
      version: 1,
      output: 'media',
      action: 'layout-change',
      preset: actualPreset,
      corner: layout.corner,
      transition: transitionType,
      duration: durationVal
    });
  }

  function status() {
    const layoutPreset = isHiding ? 'full' : (currentLayout?.preset || 'full');
    const isComposite = current && layoutPreset !== 'full';
    const cameraAbsent = isComposite && !cameraActive;
    media.postMessage({ version: 1, type: 'status',
      state: isHiding ? 'hidden' : pending ? 'switching' : current ? 'live' : failure ? 'error' : 'hidden',
      id: current?.id || '', reason: failure,
      cameraAbsent: cameraAbsent, layout: isHiding ? { preset: 'full', corner: 'bottom-right' } : currentLayout });
    sendStageStatus();
  }

  function dispose(item) {
    if (!item || item.disposed) return;
    item.disposed = true;
    item.cancelLoad?.();
    if (item.element.tagName === 'VIDEO') item.element.pause();
    item.element.removeAttribute('src');
    if (item.element.tagName === 'VIDEO') item.element.load();
    item.element.remove();
    URL.revokeObjectURL(item.url);
  }

  function cancelPending() {
    transition.cancel();
    dispose(pending);
    pending = null;
  }

  function clear(transitionType = currentTransition, durationVal = currentDuration) {
    generation++;
    isHiding = false;
    cancelPending();
    transition.hide();
    const video = current?.element;
    if (video && video.tagName === 'VIDEO') {
      video.muted = true;
    }
    dispose(current);
    current = null;
    currentLayout = { preset: 'full', corner: 'bottom-right' };
    failure = '';
    output.style.removeProperty('--layout-left');
    output.style.removeProperty('--layout-top');
    output.style.removeProperty('--layout-width');
    output.style.removeProperty('--layout-height');
    output.style.clipPath = '';
    stage.postMessage({
      version: 1,
      output: 'media',
      action: 'inactive',
      transition: transitionType,
      duration: durationVal
    });
  }

  function progress() {
    const video = current?.element;
    if (video?.tagName !== 'VIDEO') return;
    media.postMessage({ version: 1, type: 'progress', id: current.id,
      currentTime: video.currentTime, duration: Number.isFinite(video.duration) ? video.duration : 0,
      paused: video.paused, ended: video.ended });
  }

  function prepare(item) {
    return new Promise((resolve, reject) => {
      const element = item.element;
      const event = element.tagName === 'VIDEO' ? 'canplay' : 'load';
      const finish = error => {
        clearTimeout(timer);
        element.removeEventListener(event, ready);
        element.removeEventListener('error', failed);
        item.cancelLoad = null;
        error ? reject(error) : resolve();
      };
      const ready = () => finish();
      const failed = () => finish(new Error('unsupported-format'));
      const timer = setTimeout(() => finish(new Error('load-timeout')), 12000);
      item.cancelLoad = () => finish(new Error('cancelled'));
      element.addEventListener(event, ready, { once: true });
      element.addEventListener('error', failed, { once: true });
      element.src = item.url;
      if (element.tagName === 'VIDEO') element.load();
    });
  }

  async function show(message) {
    if (!(message.blob instanceof Blob) || !['image', 'video'].includes(message.kind)) {
      return;
    }
    const version = ++generation;
    isHiding = false;
    cancelPending();
    // A superseded candidate may already have announced its layout. Roll back
    // to the committed clip, not that candidate, while the next file loads.
    const committedLayout = current?.layout || normalizeLayout(null);
    const restoreLayout = currentLayout.preset !== committedLayout.preset || currentLayout.corner !== committedLayout.corner;
    currentLayout = committedLayout;
    if (restoreLayout) applyLayout(current, 'cut', 0);
    if (current?.element.tagName === 'VIDEO') current.element.muted = current.muted;
    failure = '';
    const element = document.createElement(message.kind === 'image' ? 'img' : 'video');
    const candidate = { id: message.id, element, url: URL.createObjectURL(message.blob),
      muted: message.muted === true, fit: message.fit === 'cover' ? 'cover' : 'contain' };
    pending = candidate;
    if (message.kind === 'video') {
      element.playsInline = true;
      element.loop = message.loop !== false;
      // Prepare silently. Only the committed live clip may become audible.
      element.muted = true;
      for (const event of ['timeupdate', 'play', 'pause', 'ended', 'seeked']) {
        element.addEventListener(event, () => { if (current === candidate) progress(); });
      }
    } else element.alt = '';

    const incomingLayout = normalizeLayout(message.layout);
    candidate.layout = incomingLayout;
    const previousLayout = currentLayout;

    status();
    try {
      await prepare(candidate);
      if (version !== generation) { dispose(candidate); return; }
      if (message.kind === 'video') await element.play();
      if (version !== generation) { dispose(candidate); return; }
      currentLayout = incomingLayout;
      currentTransition = message.transition || 'fade';
      currentDuration = (currentTransition === 'cut') ? 0 : (message.duration !== undefined ? parseInt(message.duration, 10) : 300);
      const layoutPreset = currentLayout?.preset || 'full';
      const isComposite = layoutPreset !== 'full';
      if (!isComposite) {
        stage.postMessage({ version: 1, output: 'media', action: 'active', layout: 'full', transition: currentTransition, duration: currentDuration });
      } else {
        stage.postMessage({ version: 1, output: 'media', action: 'active', layout: layoutPreset, transition: currentTransition, duration: currentDuration });
      }
      
      const targetPreset = (!candidate || !cameraActive) ? 'full' : currentLayout.preset;
      const initialGeom = EmberstageLayoutHelper.getLayoutGeometry(targetPreset, currentLayout.corner);
      lastGeom = { left: initialGeom.media.left, top: initialGeom.media.top, width: initialGeom.media.width, height: initialGeom.media.height };

      applyLayout(candidate, currentTransition, currentDuration);
      const committed = await transition.show(element, {
        type: currentTransition, duration: currentDuration, fit: candidate.fit
      });
      if (!committed || version !== generation) { dispose(candidate); return; }
      dispose(current);
      current = candidate;
      pending = null;
      applyLayout(current, currentTransition, currentDuration);
      if (element.tagName === 'VIDEO') element.muted = candidate.muted;
      status();
      progress();
    } catch (error) {
      dispose(candidate);
      if (version !== generation) return;
      pending = null;
      currentLayout = previousLayout;
      applyLayout(current, currentTransition, currentDuration);
      failure = error.message === 'load-timeout' ? 'load-timeout' : 'unsupported-format';
      status(); // Preserve the previous live media when a replacement cannot load.
    }
  }

  async function hide(message = {}) {
    const version = ++generation;
    cancelPending();
    failure = '';

    const transitionType = message.transition || currentTransition || 'fade';
    const transitionDuration = (transitionType === 'cut') ? 0 : (message.duration !== undefined ? parseInt(message.duration, 10) : 300);

    const video = current?.element;
    if (video && video.tagName === 'VIDEO') {
      video.muted = true; // Silence audio immediately!
    }

    if (!current || transitionDuration === 0 || transitionType === 'cut') {
      isHiding = false;
      clear(transitionType, transitionDuration);
      status();
      return;
    }

    isHiding = true;
    currentTransition = transitionType;
    currentDuration = transitionDuration;
    // Notify about the transition hide start
    stage.postMessage({
      version: 1,
      output: 'media',
      action: 'layout-change',
      preset: 'full',
      corner: currentLayout?.corner || 'bottom-right',
      transition: transitionType,
      duration: transitionDuration
    });
    status();

    const committed = await transition.hide({ type: transitionType, duration: transitionDuration });
    if (version !== generation) return; // Superseded by a newer action

    isHiding = false;
    dispose(current);
    current = null;
    currentLayout = { preset: 'full', corner: 'bottom-right' };
    output.style.removeProperty('--layout-left');
    output.style.removeProperty('--layout-top');
    output.style.removeProperty('--layout-width');
    output.style.removeProperty('--layout-height');
    output.style.clipPath = '';

    stage.postMessage({
      version: 1,
      output: 'media',
      action: 'inactive',
      transition: transitionType,
      duration: transitionDuration
    });
    status();
  }

  media.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    if (data.type === 'show') void show(data);
    else if (data.type === 'hide') { void hide(data); }
    else if (data.type === 'apply-layout') {
      if (current && !pending && !isHiding && current.id === data.id && (current.element.tagName === 'IMG' || current.element.tagName === 'VIDEO')) {
        currentLayout = normalizeLayout(data.layout);
        current.layout = currentLayout;
        currentTransition = data.transition || 'fade';
        currentDuration = (currentTransition === 'cut') ? 0 : (data.duration !== undefined ? parseInt(data.duration, 10) : 300);
        if (currentLayout.preset === 'full') {
          stage.postMessage({ version: 1, output: 'media', action: 'active', layout: 'full', transition: currentTransition, duration: currentDuration });
        } else {
          stage.postMessage({ version: 1, output: 'media', action: 'active', layout: currentLayout.preset, transition: currentTransition, duration: currentDuration });
        }
        applyLayout(current, currentTransition, currentDuration);
        status();
      }
    }
    else if (data.type === 'update-settings') {
      for (const item of [current, pending]) {
        if (!item) continue;
        item.fit = data.fit === 'cover' ? 'cover' : 'contain';
        item.element.style.objectFit = item.fit;
        item.muted = data.muted === true;
        if (item.element.tagName === 'VIDEO') {
          item.element.muted = item === current && !isHiding ? item.muted : true;
          item.element.loop = data.loop !== false;
        }
      }
    } else if (data.type === 'seek') {
      const video = current?.element;
      if (!isHiding && video?.tagName === 'VIDEO' && Number.isFinite(data.time) && Number.isFinite(video.duration)) {
        video.currentTime = Math.max(0, Math.min(video.duration, data.time));
      }
    } else if (data.type === 'transport') {
      const video = current?.element;
      if (isHiding || video?.tagName !== 'VIDEO') return;
      if (data.action === 'pause') video.pause();
      if (data.action === 'play') video.play().catch(() => {});
      if (data.action === 'restart') { video.currentTime = 0; video.play().catch(() => {}); }
      progress();
    } else if (data.type === 'ping') { status(); progress(); }
  };

  stage.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    if (data.output === 'camera') {
      cameraSeenAt = Date.now();
      if (data.action === 'active') {
        cameraActive = true;
        const layoutPreset = currentLayout?.preset || 'full';
        const isComposite = current && layoutPreset !== 'full';
        if (!isComposite) {
          clear();
          status();
        } else {
          cameraActive = true;
          applyLayout();
          status();
        }
      } else if (data.action === 'status') {
        const wasActive = cameraActive;
        cameraActive = (data.state === 'live');
        if (cameraActive !== wasActive) {
          applyLayout();
          status();
        }
      } else if (data.action === 'inactive') {
        const wasActive = cameraActive;
        cameraActive = false;
        if (wasActive) { applyLayout(); status(); }
      }
    } else if (data.action === 'ping') {
      sendStageStatus();
    }
  };
  const heartbeat = setInterval(() => {
    if (cameraActive && Date.now() - cameraSeenAt > 6000) {
      cameraActive = false;
      applyLayout();
      status();
    }
    sendStageStatus();
  }, 2000);
  stage.postMessage({ version: 1, output: 'media', action: 'ping' });
  media.postMessage({ version: 1, type: 'ready' });
  addEventListener('pagehide', () => { clearInterval(heartbeat); clear(); media.close(); stage.close(); });
})();
