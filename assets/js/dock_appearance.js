(function (global, factory) {
  const api = factory();
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  global.EmberstageDockAppearance = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  const STORAGE_KEY = 'emberstage-dock-appearance';
  const THEMES = [
    'obs-bible-acri',
    'obs-bible-dark',
    'obs-bible-grey',
    'obs-bible-light',
    'obs-bible-rachni',
    'obs-bible-system',
    'obs-bible-default-yami'
  ];
  const SIZES = ['auto', 'compact', 'standard', 'wide', 'short'];
  const DEFAULT_THEME = 'obs-bible-default-yami';
  const DEFAULT_LOGO = 'assets/brand/emberstage-logo.svg';
  const THEME_ACCENT = {
    'obs-bible-acri': '#9abaff',
    'obs-bible-dark': '#e6b15a',
    'obs-bible-grey': '#d7b46a',
    'obs-bible-light': '#3d6cb5',
    'obs-bible-rachni': '#28c8e4',
    'obs-bible-system': '#3d7ec4',
    'obs-bible-default-yami': '#e6b15a'
  };

  function brandingApi() {
    return globalThis.OBSBibleBroadcastBranding || null;
  }

  function sanitizeColor(value) {
    const text = String(value || '').trim();
    if (/^#[0-9a-f]{6}$/i.test(text)) return text.toLowerCase();
    if (/^#[0-9a-f]{3}$/i.test(text)) {
      return '#' + text.slice(1).split('').map(function (char) { return char + char; }).join('').toLowerCase();
    }
    return '';
  }

  function sanitizeLogo(value) {
    const branding = brandingApi();
    const text = String(value || '').trim();
    if (!text) return '';
    if (branding && typeof branding.isSafeLogoDataUrl === 'function') {
      return branding.isSafeLogoDataUrl(text) ? text : '';
    }
    if (text.length > 180000) return '';
    return /^data:(image\/png|image\/jpeg|image\/webp|image\/gif);base64,[a-z0-9+/=]+$/i.test(text) ? text : '';
  }

  function sanitizeDockAppearance(value) {
    const source = value && typeof value === 'object' ? value : {};
    const theme = THEMES.indexOf(source.theme) >= 0 ? source.theme : DEFAULT_THEME;
    const dockSize = SIZES.indexOf(source.dockSize) >= 0 ? source.dockSize : 'auto';
    const churchName = String(source.churchName || '').replace(/\s+/g, ' ').trim().slice(0, 40);
    return {
      theme: theme,
      churchName: churchName,
      brandColor: sanitizeColor(source.brandColor),
      logoDataUrl: sanitizeLogo(source.logoDataUrl),
      dockSize: dockSize
    };
  }

  function brighten(hex) {
    const color = sanitizeColor(hex);
    if (!color) return '';
    const value = parseInt(color.slice(1), 16);
    const mix = function (channel) { return Math.round(channel + (255 - channel) * 0.28); };
    return '#' + [mix((value >> 16) & 255), mix((value >> 8) & 255), mix(value & 255)]
      .map(function (channel) { return channel.toString(16).padStart(2, '0'); })
      .join('');
  }

  function themeAccent(theme) {
    return THEME_ACCENT[theme] || THEME_ACCENT[DEFAULT_THEME];
  }

  function readStored(storage) {
    try {
      return sanitizeDockAppearance(JSON.parse(storage.getItem(STORAGE_KEY) || '{}'));
    } catch (_) {
      return sanitizeDockAppearance({});
    }
  }

  function writeStored(storage, appearance) {
    try {
      storage.setItem(STORAGE_KEY, JSON.stringify(sanitizeDockAppearance(appearance)));
    } catch (_) {
      /* The dock still updates for this session. */
    }
  }

  function applyDockAppearance(doc, appearance) {
    const body = doc && doc.body;
    if (!body) return sanitizeDockAppearance(appearance);
    const next = sanitizeDockAppearance(appearance);
    const accent = next.brandColor || themeAccent(next.theme);
    const bright = brighten(accent);
    body.setAttribute('data-theme', next.theme);
    body.setAttribute('data-dock-size', next.dockSize);
    body.style.setProperty('--ember-brand-gold', accent);
    body.style.setProperty('--ember-brand-gold-bright', bright || accent);
    body.style.setProperty('--ember-brand-line', accent + '55');
    body.style.setProperty('--ember-brand-line-strong', accent + '88');
    body.style.setProperty('--primary-btn-bg', accent);
    body.style.setProperty('--selected-bg-color', accent);
    body.style.setProperty('--selected-fg-color', '#1a140c');
    body.style.setProperty('--highlighted-bg-color', accent);
    body.classList.toggle('dock-whitelabel', Boolean(next.churchName || next.logoDataUrl));

    const name = doc.querySelector('.dock-brand-name');
    const wordmark = doc.querySelector('.dock-brand-wordmark');
    const logo = doc.querySelector('.ember-brand-logo');
    const lockup = doc.querySelector('.dock-brand');
    if (name) {
      name.textContent = next.churchName;
      name.hidden = !next.churchName;
    }
    if (wordmark) wordmark.hidden = Boolean(next.churchName);
    if (logo) logo.src = next.logoDataUrl || logo.getAttribute('data-ember-logo') || DEFAULT_LOGO;
    if (lockup) {
      lockup.setAttribute('aria-label', next.churchName ? next.churchName + ' dock' : 'Emberstage dock');
    }

    const themeSelect = doc.getElementById('obs-bible-panel-theme');
    if (themeSelect && themeSelect.value !== next.theme) themeSelect.value = next.theme;
    const appearanceTheme = doc.getElementById('dock-appearance-theme');
    if (appearanceTheme) appearanceTheme.value = next.theme;
    const nameInput = doc.getElementById('dock-appearance-name');
    if (nameInput && nameInput.value !== next.churchName) nameInput.value = next.churchName;
    const colorInput = doc.getElementById('dock-appearance-color');
    if (colorInput) colorInput.value = next.brandColor || accent;
    doc.querySelectorAll('[data-dock-size-choice]').forEach(function (button) {
      button.setAttribute('aria-pressed', String(button.getAttribute('data-dock-size-choice') === next.dockSize));
    });
    return next;
  }

  function init(doc) {
    const documentRef = doc || document;
    const storage = documentRef.defaultView ? documentRef.defaultView.localStorage : localStorage;
    let current = readStored(storage);
    const panel = documentRef.getElementById('dock-appearance');
    const openButton = documentRef.getElementById('dock-appearance-open');
    if (!panel || !openButton) {
      applyDockAppearance(documentRef, current);
      return current;
    }

    function commit(patch) {
      current = sanitizeDockAppearance(Object.assign({}, current, patch));
      writeStored(storage, current);
      applyDockAppearance(documentRef, current);
      if (documentRef.defaultView && typeof documentRef.defaultView.updateDockLayoutClasses === 'function') {
        documentRef.defaultView.updateDockLayoutClasses();
      }
    }

    applyDockAppearance(documentRef, current);
    openButton.addEventListener('click', function () {
      panel.hidden = !panel.hidden;
      openButton.setAttribute('aria-expanded', String(!panel.hidden));
    });
    documentRef.getElementById('dock-appearance-theme').addEventListener('change', function (event) {
      commit({ theme: event.target.value });
    });
    documentRef.getElementById('dock-appearance-name').addEventListener('input', function (event) {
      commit({ churchName: event.target.value });
    });
    documentRef.getElementById('dock-appearance-color').addEventListener('input', function (event) {
      commit({ brandColor: event.target.value });
    });
    documentRef.getElementById('dock-appearance-color-clear').addEventListener('click', function () {
      commit({ brandColor: '' });
    });
    documentRef.getElementById('dock-appearance-logo').addEventListener('change', function (event) {
      const file = event.target.files && event.target.files[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = function () {
        const logo = sanitizeLogo(reader.result);
        if (logo) commit({ logoDataUrl: logo });
      };
      reader.readAsDataURL(file);
    });
    documentRef.getElementById('dock-appearance-logo-clear').addEventListener('click', function () {
      commit({ logoDataUrl: '' });
    });
    panel.querySelectorAll('[data-dock-size-choice]').forEach(function (button) {
      button.addEventListener('click', function () {
        commit({ dockSize: button.getAttribute('data-dock-size-choice') });
      });
    });
    const legacyTheme = documentRef.getElementById('obs-bible-panel-theme');
    if (legacyTheme) {
      legacyTheme.addEventListener('change', function (event) {
        commit({ theme: event.target.value });
      });
    }
    return current;
  }

  return {
    STORAGE_KEY: STORAGE_KEY,
    THEMES: THEMES,
    SIZES: SIZES,
    sanitizeDockAppearance: sanitizeDockAppearance,
    themeAccent: themeAccent,
    brighten: brighten,
    applyDockAppearance: applyDockAppearance,
    init: init
  };
});

if (typeof document !== 'undefined') {
  const startDockAppearance = function () {
    if (globalThis.EmberstageDockAppearance) globalThis.EmberstageDockAppearance.init(document);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', startDockAppearance);
  else startDockAppearance();
}
