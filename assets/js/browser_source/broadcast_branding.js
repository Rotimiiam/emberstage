(function () {
  const branding = window.OBSBibleBroadcastBranding;
  if (!branding) return;

  const bgContainer = document.getElementById('bg-container');
  const messageDisplay = document.getElementById('messageDisplay');
  const broadcastRoot = document.getElementById('broadcast-root');
  const broadcastBackdrop = document.getElementById('broadcast-backdrop');
  const broadcastCard = document.getElementById('broadcast-card');
  const broadcastCardShell = document.getElementById('broadcast-card-shell');
  const broadcastReference = document.getElementById('broadcast-reference');
  const broadcastVerse = document.getElementById('broadcast-verse');
  const broadcastInlineBrand = document.getElementById('broadcast-inline-brand');
  const broadcastInlineLogo = document.getElementById('broadcast-inline-logo');
  const broadcastInlineName = document.getElementById('broadcast-inline-name');
  const broadcastCornerBrand = document.getElementById('broadcast-corner-brand');
  const broadcastCornerLogo = document.getElementById('broadcast-corner-logo');
  const broadcastCornerName = document.getElementById('broadcast-corner-name');
  const broadcastMeasure = document.getElementById('broadcast-measure');

  if (!bgContainer || !messageDisplay || !broadcastRoot) return;

  function readStoredSettings(keys = branding.STORAGE_KEYS) {
    try {
      return branding.sanitizeBroadcastSettings(JSON.parse(localStorage.getItem(keys.applied) || '{}'));
    } catch (_) {
      return branding.sanitizeBroadcastSettings();
    }
  }

  function readStoredPayload() {
    try {
      const raw = localStorage.getItem(branding.STORAGE_KEYS.payload);
      return raw ? branding.coerceMessagePayload(JSON.parse(raw)) : null;
    } catch (_) {
      return null;
    }
  }

  function isReducedMotion() {
    return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  const state = {
    settings: readStoredSettings(),
    textSettings: readStoredSettings(branding.TEXT_STORAGE_KEYS),
    payload: readStoredPayload(),
    visible: (() => {
      try {
        const data = JSON.parse(localStorage.getItem('obs-bible-animationData') || '{}');
        return data.display !== 'none';
      } catch (_) {
        return true;
      }
    })(),
    hideTimer: 0,
    showTimer: 0,
    swapTimer: 0,
    animationToken: 0,
    mode: 'legacy',
  };

  function activeSettings() {
    return state.payload?.kind === 'text' ? state.textSettings : state.settings;
  }

  function clearAnimationTimers() {
    window.clearTimeout(state.hideTimer);
    window.clearTimeout(state.showTimer);
    window.clearTimeout(state.swapTimer);
    state.hideTimer = 0;
    state.showTimer = 0;
    state.swapTimer = 0;
  }

  function hexToRgba(hex, alpha) {
    const value = branding.sanitizeAccentColor(hex, branding.DEFAULT_BROADCAST_SETTINGS.accentColor);
    const red = Number.parseInt(value.slice(1, 3), 16);
    const green = Number.parseInt(value.slice(3, 5), 16);
    const blue = Number.parseInt(value.slice(5, 7), 16);
    return `rgba(${red}, ${green}, ${blue}, ${alpha})`;
  }

  function setBrandImage(img, src) {
    if (!img) return;
    if (src) {
      if (img.getAttribute('src') !== src) img.src = src;
      img.hidden = false;
    } else {
      img.removeAttribute('src');
      img.hidden = true;
    }
  }

  function setBroadcastTheme(settings) {
    broadcastRoot.style.setProperty('--broadcast-accent', settings.accentColor);
    broadcastRoot.style.setProperty('--broadcast-accent-strong', hexToRgba(settings.accentColor, 0.95));
    broadcastRoot.style.setProperty('--broadcast-accent-soft', hexToRgba(settings.accentColor, 0.2));
    broadcastRoot.style.setProperty('--broadcast-accent-glow', hexToRgba(settings.accentColor, 0.35));
    broadcastRoot.style.setProperty('--broadcast-safe-x', `${settings.safeMarginPercent}vw`);
    broadcastRoot.style.setProperty('--broadcast-safe-y', `${settings.safeMarginPercent}vh`);
  }

  function fitBroadcastTypography(layout) {
    if (!broadcastMeasure || !broadcastCardShell || !broadcastVerse || !broadcastReference) return;
    // Fit to the card content area, not the previous verse's auto-sized wrapper.
    if (broadcastRoot.hidden || !broadcastCard.clientWidth) return;
    const cardStyle = window.getComputedStyle(broadcastCard);
    const num = value => Number.parseFloat(value) || 0;
    broadcastReference.style.fontSize = `${Math.max(14, Math.min(28, window.innerHeight * 0.026))}px`;
    // Branding spans both text rows on the left; fit to the remaining column.
    const availableWidth = Math.max(1, Math.floor(broadcastCard.clientWidth - num(cardStyle.paddingLeft) - num(cardStyle.paddingRight)
      - (broadcastInlineBrand.hidden ? 0 : broadcastInlineBrand.offsetWidth + num(cardStyle.columnGap))));
    const availableHeight = Math.max(1, Math.floor(window.innerHeight * (layout === 'lower-third' ? 0.45 : 0.72)
      - num(cardStyle.paddingTop) - num(cardStyle.paddingBottom) - 2
      - broadcastReference.offsetHeight - num(cardStyle.rowGap)));
    const minFont = 14;
    const maxFont = Math.round(Math.min(layout === 'lower-third' ? 78 : 96, window.innerHeight * (layout === 'lower-third' ? 0.065 : 0.09)));

    broadcastMeasure.style.width = `${availableWidth}px`;
    broadcastMeasure.style.maxWidth = `${availableWidth}px`;
    broadcastMeasure.style.fontFamily = window.getComputedStyle(broadcastVerse).fontFamily;
    broadcastMeasure.style.fontWeight = window.getComputedStyle(broadcastVerse).fontWeight;
    broadcastMeasure.style.letterSpacing = window.getComputedStyle(broadcastVerse).letterSpacing;
    broadcastMeasure.style.lineHeight = '1.12';
    broadcastMeasure.textContent = broadcastVerse.textContent || '';

    let low = minFont;
    let high = maxFont;
    let best = minFont;

    while (low <= high) {
      const mid = Math.floor((low + high) / 2);
      broadcastMeasure.style.fontSize = `${mid}px`;
      const overflow = Math.ceil(broadcastMeasure.scrollHeight) > availableHeight || Math.ceil(broadcastMeasure.scrollWidth) > availableWidth;
      if (overflow) {
        high = mid - 1;
      } else {
        best = mid;
        low = mid + 1;
      }
    }

    broadcastVerse.style.fontSize = `${best}px`;
  }

  function deactivateBroadcastLayer() {
    clearAnimationTimers();
    state.mode = 'legacy';
    bgContainer.classList.remove('broadcast-mode');
    broadcastRoot.hidden = true;
    broadcastRoot.setAttribute('aria-hidden', 'true');
    broadcastRoot.classList.remove('is-visible', 'is-entering', 'is-exiting', 'is-swapping');
    messageDisplay.hidden = false;
  }

  function updateBrandVisibility(settings) {
    const hasBrand = Boolean(settings.logoDataUrl || settings.churchName);
    const inCard = settings.logoPosition === 'in-card';
    broadcastRoot.dataset.logoPosition = settings.logoPosition;
    broadcastInlineBrand.hidden = !(hasBrand && inCard);
    broadcastCornerBrand.hidden = !(hasBrand && !inCard);
    broadcastCard.classList.toggle('has-inline-brand', !broadcastInlineBrand.hidden);
  }

  function renderBroadcastContent(payload, options) {
    const parts = branding.extractScriptureParts(payload);
    const settings = activeSettings();
    const hasBrand = Boolean(settings.logoDataUrl || settings.churchName);
    const layout = settings.layout;

    bgContainer.classList.add('broadcast-mode');
    broadcastRoot.dataset.layout = layout;
    broadcastRoot.dataset.kind = payload.kind;
    const position = payload.kind === 'text' ? payload.position : '';
    broadcastRoot.dataset.position = /^(top|middle|bottom)-(left|center|right)$/.test(position) || position === 'center' ? position : '';
    setBroadcastTheme(settings);
    updateBrandVisibility(settings);
    messageDisplay.hidden = true;

    setBrandImage(broadcastInlineLogo, settings.logoDataUrl);
    setBrandImage(broadcastCornerLogo, settings.logoDataUrl);
    broadcastInlineName.textContent = settings.churchName;
    broadcastCornerName.textContent = settings.churchName;
    broadcastReference.textContent = (parts.reference || '').toUpperCase();
    broadcastReference.hidden = !parts.reference;
    broadcastVerse.textContent = parts.verseText;
    broadcastBackdrop.hidden = layout !== 'full-screen';
    broadcastCard.classList.toggle('has-brand', hasBrand);
    fitBroadcastTypography(layout);

    if (options && options.swap && !isReducedMotion()) {
      broadcastRoot.classList.add('is-swapping');
      window.clearTimeout(state.swapTimer);
      state.swapTimer = window.setTimeout(() => {
        broadcastRoot.classList.remove('is-swapping');
      }, 180);
    } else {
      broadcastRoot.classList.remove('is-swapping');
    }
  }

  function applyVisibilityState(visible) {
    state.visible = visible;
    bgContainer.style.display = visible ? 'flex' : 'none';
    if (!visible) {
      broadcastRoot.classList.remove('is-visible', 'is-entering');
      broadcastRoot.hidden = true;
      broadcastRoot.setAttribute('aria-hidden', 'true');
    }
  }

  function runBroadcastVisibility(show) {
    const token = ++state.animationToken;
    const settings = activeSettings();
    const style = show ? settings.entranceStyle : settings.exitStyle;
    const duration = isReducedMotion() ? 0 : (show ? settings.entranceDuration : settings.exitDuration);

    clearAnimationTimers();
    broadcastRoot.classList.remove('is-entering', 'is-exiting', 'motion-none', 'motion-fade', 'motion-rise');
    broadcastRoot.classList.add(`motion-${style}`);
    broadcastRoot.style.setProperty('--broadcast-motion-duration', `${duration}ms`);

    if (show) {
      bgContainer.style.display = 'flex';
      broadcastRoot.hidden = false;
      broadcastRoot.setAttribute('aria-hidden', 'false');
      fitBroadcastTypography(settings.layout);
      broadcastRoot.classList.add('is-visible');
      if (style !== 'none' && duration > 0) broadcastRoot.classList.add('is-entering');
      void broadcastRoot.offsetWidth;
      if (style === 'none' || duration === 0) return;
      window.requestAnimationFrame(() => {
        if (token !== state.animationToken) return;
        broadcastRoot.classList.remove('is-entering');
      });
      return;
    }

    if (style === 'none' || duration === 0) {
      applyVisibilityState(false);
      return;
    }

    broadcastRoot.classList.add('is-exiting');
    state.hideTimer = window.setTimeout(() => {
      if (token !== state.animationToken) return;
      broadcastRoot.classList.remove('is-exiting', 'is-visible');
      applyVisibilityState(false);
    }, duration);
  }

  function syncBroadcastPayload(payload) {
    const normalizedPayload = branding.coerceMessagePayload(payload);
    ++state.animationToken;
    clearAnimationTimers();
    broadcastRoot.classList.remove('is-entering', 'is-exiting');
    state.payload = normalizedPayload;

    if (!branding.shouldUseBroadcastLayout(normalizedPayload, activeSettings())) {
      deactivateBroadcastLayer();
      return false;
    }

    const swap = state.mode === 'broadcast' && state.visible;
    state.mode = 'broadcast';
    broadcastRoot.hidden = !state.visible;
    broadcastRoot.setAttribute('aria-hidden', state.visible ? 'false' : 'true');
    renderBroadcastContent(normalizedPayload, { swap });
    if (state.visible) {
      bgContainer.style.display = 'flex';
      broadcastRoot.classList.add('is-visible');
    }
    return true;
  }

  function handleSettingsMessage(data) {
    if (!data || data.protocol !== branding.PROTOCOL || !data.broadcastLook) return false;
    if (data.target && !['scripture', 'text'].includes(data.target)) return false;
    const target = data.target || 'scripture';
    const field = target === 'text' ? 'textSettings' : 'settings';
    const keys = target === 'text' ? branding.TEXT_STORAGE_KEYS : branding.STORAGE_KEYS;
    state[field] = branding.sanitizeBroadcastSettings(data.broadcastLook, state[field]);
    try { localStorage.setItem(keys.applied, JSON.stringify(state[field])); } catch (_) { /* Keep live look when storage is full. */ }
    if (state.payload?.kind !== target) return true;

    if (state.payload && branding.shouldUseBroadcastLayout(state.payload, activeSettings())) {
      syncBroadcastPayload(state.payload);
    } else if (state.payload && typeof window.renderLegacyMessagePayload === 'function') {
      deactivateBroadcastLayer();
      window.renderLegacyMessagePayload(state.payload);
    }
    return true;
  }

  function handleAnimationMessage(data) {
    const show = data && data.display === 'flex';
    state.visible = show;
    if (!branding.shouldUseBroadcastLayout(state.payload, activeSettings())) {
      return false;
    }
    try { localStorage.setItem('obs-bible-animationData', JSON.stringify(data || {})); } catch (_) {}
    runBroadcastVisibility(show);
    return true;
  }

  function restoreSavedBroadcastPayload() {
    if (!state.payload) return;
    if (!branding.shouldUseBroadcastLayout(state.payload, activeSettings())) return;
    syncBroadcastPayload(state.payload);
    if (state.visible) {
      bgContainer.style.display = 'flex';
      broadcastRoot.classList.add('is-visible');
      broadcastRoot.hidden = false;
      broadcastRoot.setAttribute('aria-hidden', 'false');
    }
  }

  window.obsBibleBroadcasting = {
    syncBroadcastPayload,
    handleSettingsMessage,
    handleAnimationMessage,
    restoreSavedBroadcastPayload,
    deactivateBroadcastLayer,
  };

  window.addEventListener('resize', () => {
    if (state.mode === 'broadcast') {
      fitBroadcastTypography(activeSettings().layout);
    }
  });

  restoreSavedBroadcastPayload();
  window.__obsBibleBroadcastSourceReady = true;
  window.dispatchEvent(new CustomEvent('obs-bible:broadcast-source-ready', {
    detail: {
      protocol: branding.PROTOCOL,
      rootId: 'broadcast-root',
      messagePayloadStorageKey: branding.STORAGE_KEYS.payload,
    },
  }));
})();
