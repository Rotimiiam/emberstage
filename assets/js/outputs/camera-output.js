(function () {
  'use strict';

  const HEARTBEAT_MS = 2000;
  const output = document.getElementById('output');
  const cameras = new BroadcastChannel('emberstage-camera-v1');
  const stage = new BroadcastChannel('emberstage-visual-v1');
  const allStreams = new Set();
  const transition = createTransitionController();
  let activeStream = null;
  let activeVideo = null;
  let currentDeviceId = '';
  let currentFit = 'cover';
  let requestVersion = 0;
  let currentState = 'hidden';
  let currentMessage = '';
  let heartbeatTimer = 0;

  let mediaActive = false;
  let mediaSeenAt = 0;
  let mediaLayoutPreset = 'full';
  let currentLayout = { preset: 'full', corner: 'bottom-right' };

  function sendStageStatus() {
    stage.postMessage({
      version: 1,
      output: 'camera',
      action: 'status',
      state: activeStream ? 'live' : 'hidden'
    });
  }

  function applyLayout() {
    const layout = currentLayout || { preset: 'full', corner: 'bottom-right' };
    const geom = EmberstageLayoutHelper.getLayoutGeometry(layout.preset, layout.corner);
    output.style.setProperty('--layout-left', geom.camera.left + '%');
    output.style.setProperty('--layout-top', geom.camera.top + '%');
    output.style.setProperty('--layout-width', geom.camera.width + '%');
    output.style.setProperty('--layout-height', geom.camera.height + '%');

    const clipPath = EmberstageLayoutHelper.getCameraClipPath(layout.preset, layout.corner);
    output.style.clipPath = clipPath;
  }

  function createTransitionController() {
    const helper = globalThis.EmberstageTransition;
    if (helper && typeof helper.create === 'function') return helper.create(output);
    return {
      async show(element, { fit }) {
        output.classList.toggle('cover', fit === 'cover');
        output.replaceChildren(element);
        output.classList.add('visible');
        return true;
      },
      hide() {
        output.replaceChildren();
        output.classList.remove('visible', 'cover');
      },
      destroy() {
        output.replaceChildren();
        output.classList.remove('visible', 'cover');
      }
    };
  }

  function ownStream(stream) {
    if (stream) allStreams.add(stream);
    return stream;
  }

  function stopStream(stream) {
    if (!stream) return;
    allStreams.delete(stream);
    for (const track of stream.getTracks()) track.stop();
  }

  function reportStatus(state = currentState, extra = {}) {
    currentState = state;
    currentMessage = typeof extra.message === 'string' ? extra.message : currentMessage;
    cameras.postMessage({
      version: 1,
      type: 'status',
      state,
      deviceId: typeof extra.deviceId === 'string' ? extra.deviceId : currentDeviceId,
      requestedDeviceId: extra.requestedDeviceId,
      reason: extra.reason,
      message: extra.message,
      warning: extra.warning,
      fit: currentFit,
      sentAt: Date.now()
    });
    sendStageStatus();
  }

  function scheduleHeartbeat() {
    clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      if (mediaActive && Date.now() - mediaSeenAt > 6000) {
        mediaActive = false;
        currentLayout = { preset: 'full', corner: 'bottom-right' };
        applyLayout();
      }
      reportStatus(currentState, { deviceId: currentDeviceId, message: currentMessage });
      scheduleHeartbeat();
    }, HEARTBEAT_MS);
  }

  function resetOutputNode() {
    output.replaceChildren();
    output.classList.remove('visible', 'cover');
    output.style.removeProperty('--layout-left');
    output.style.removeProperty('--layout-top');
    output.style.removeProperty('--layout-width');
    output.style.removeProperty('--layout-height');
    output.style.clipPath = '';
  }

  function stop(state = 'hidden', message = '') {
    requestVersion++;
    try { transition.hide(); } catch (_) { resetOutputNode(); }
    stopStream(activeStream);
    activeStream = null;
    activeVideo = null;
    currentDeviceId = '';
    currentFit = 'cover';
    currentMessage = message;
    resetOutputNode();
    reportStatus(state, { deviceId: '', message });
    stage.postMessage({ version: 1, output: 'camera', action: 'inactive' });
  }

  async function waitForVideoReady(video) {
    await new Promise((resolve, reject) => {
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        resolve();
        return;
      }
      let settled = false;
      const finish = callback => () => {
        if (settled) return;
        settled = true;
        cleanup();
        callback();
      };
      const onReady = finish(resolve);
      const onError = finish(() => reject(new Error('Camera preview could not start.')));
      const timer = setTimeout(onReady, 1200);
      const cleanup = () => {
        clearTimeout(timer);
        video.removeEventListener('loadedmetadata', onReady);
        video.removeEventListener('canplay', onReady);
        video.removeEventListener('error', onError);
      };
      video.addEventListener('loadedmetadata', onReady, { once: true });
      video.addEventListener('canplay', onReady, { once: true });
      video.addEventListener('error', onError, { once: true });
    });
    try { await video.play(); } catch (_) { /* OBS may defer playback until visible. */ }
    await new Promise(resolve => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        resolve();
      };
      const timer = setTimeout(finish, 280);
      if (typeof video.requestVideoFrameCallback === 'function') {
        video.requestVideoFrameCallback(() => {
          clearTimeout(timer);
          finish();
        });
      }
    });
  }

  function classifyError(error) {
    if (error?.name === 'NotAllowedError' || error?.name === 'SecurityError') return 'permission-denied';
    if (error?.name === 'NotReadableError' || error?.name === 'AbortError') return 'device-busy';
    if (error?.name === 'NotFoundError' || error?.name === 'OverconstrainedError') return 'device-missing';
    return 'device-open-failed';
  }

  function bindActiveStream(stream, deviceId) {
    for (const track of stream.getVideoTracks()) {
      track.addEventListener('ended', () => {
        if (stream !== activeStream || deviceId !== currentDeviceId) return;
        stop('error', 'The live camera stopped. Choose another camera or hide the output.');
      });
    }
  }

  async function commitVideo(nextVideo, options) {
    output.classList.toggle('cover', options.fit === 'cover');
    try {
      return await transition.show(nextVideo, options);
    } catch (_) {
      output.classList.toggle('cover', options.fit === 'cover');
      output.replaceChildren(nextVideo);
      output.classList.add('visible');
      return true;
    }
  }

  async function take(message) {
    const requestedFit = message.fit === 'contain' ? 'contain' : 'cover';
    const transitionType = ['cut', 'fade', 'dip'].includes(message.transition?.type) ? message.transition.type : 'cut';
    const transitionDuration = [150, 300, 500].includes(Number(message.transition?.duration)) ? Number(message.transition.duration) : 300;
    if (activeStream && currentDeviceId === message.deviceId) {
      requestVersion++;
      transition.cancel?.();
      currentFit = requestedFit;
      if (activeVideo) activeVideo.style.objectFit = currentFit;
      output.classList.toggle('cover', currentFit === 'cover');
      reportStatus(currentState === 'error' ? 'error' : 'live', { deviceId: currentDeviceId, message: currentState === 'error' ? currentMessage : '' });
      return;
    }
    const version = ++requestVersion;
    transition.cancel?.();
    let nextStream = null;
    reportStatus('switching', { requestedDeviceId: message.deviceId, deviceId: currentDeviceId, message: `Opening ${message.requestedLabel || 'camera'}…` });
    try {
      if (!navigator.mediaDevices?.getUserMedia) throw new DOMException('Camera APIs unavailable', 'NotAllowedError');
      nextStream = ownStream(await navigator.mediaDevices.getUserMedia({ audio: false, video: { deviceId: { exact: message.deviceId } } }));
      const nextVideo = document.createElement('video');
      nextVideo.autoplay = true;
      nextVideo.muted = true;
      nextVideo.defaultMuted = true;
      nextVideo.playsInline = true;
      nextVideo.srcObject = nextStream;
      await waitForVideoReady(nextVideo);
      if (version !== requestVersion) {
        stopStream(nextStream);
        return;
      }
      const oldStream = activeStream;
      const committed = await commitVideo(nextVideo, { type: transitionType, duration: transitionDuration, fit: requestedFit });
      if (!committed || version !== requestVersion) {
        stopStream(nextStream);
        return;
      }
      activeStream = nextStream;
      activeVideo = nextVideo;
      currentDeviceId = message.deviceId;
      currentFit = requestedFit;
      currentMessage = '';
      bindActiveStream(nextStream, message.deviceId);
      if (oldStream && oldStream !== activeStream) stopStream(oldStream);
      applyLayout();
      stage.postMessage({ version: 1, output: 'camera', action: 'active' });
      reportStatus('live', { deviceId: message.deviceId, message: '' });
    } catch (error) {
      if (nextStream) stopStream(nextStream);
      if (version !== requestVersion) return;
      const reason = classifyError(error);
      const fallbackMessage = activeStream
        ? `Could not switch to ${message.requestedLabel || 'that camera'}. The current live camera stayed up.`
        : `Could not open ${message.requestedLabel || 'that camera'}.`;
      currentMessage = fallbackMessage;
      reportStatus(activeStream ? 'live' : 'error', {
        deviceId: currentDeviceId,
        requestedDeviceId: message.deviceId,
        reason,
        message: fallbackMessage,
        warning: activeStream ? `${fallbackMessage} If another OBS source or app owns it, release that first. Fade-style transitions may not work on drivers that refuse overlap.` : undefined
      });
    }
  }

  cameras.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    if (data.type === 'take' && typeof data.deviceId === 'string' && data.deviceId.trim()) take(data);
    else if (data.type === 'hide') stop();
    else if (data.type === 'ping') {
      reportStatus(activeStream ? currentState : 'hidden', { deviceId: currentDeviceId, message: currentMessage });
      sendStageStatus();
    }
  };

  stage.onmessage = ({ data }) => {
    if (!data || data.version !== 1) return;
    if (data.output === 'media') {
      mediaSeenAt = Date.now();
      if (data.action === 'active') {
        mediaActive = true;
        mediaLayoutPreset = data.layout || 'full';
        if (mediaLayoutPreset === 'full') {
          stop();
        }
      } else if (data.action === 'status') {
        mediaActive = (data.state === 'live');
        mediaLayoutPreset = data.layout?.preset || 'full';
      } else if (data.action === 'layout-change') {
        currentLayout = { preset: data.preset, corner: data.corner };
        applyLayout();
      } else if (data.action === 'inactive') {
        mediaActive = false;
        currentLayout = { preset: 'full', corner: 'bottom-right' };
        applyLayout();
      }
    } else if (data.action === 'ping') {
      sendStageStatus();
    }
  };

  scheduleHeartbeat();
  stage.postMessage({ version: 1, output: 'camera', action: 'ping' });
  cameras.postMessage({ version: 1, type: 'ready' });
  addEventListener('pagehide', () => {
    stop();
    clearTimeout(heartbeatTimer);
    for (const stream of [...allStreams]) stopStream(stream);
    try { transition.destroy(); } catch (_) { resetOutputNode(); }
    cameras.close();
    stage.close();
  });
})();
