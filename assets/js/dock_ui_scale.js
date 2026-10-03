;(function () {
  'use strict';

  function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
  }

  function parseStoredValue(key) {
    if (!key) return null;
    try {
      var raw = localStorage.getItem(key);
      if (raw == null) return null;
      var value = Number(raw);
      return Number.isFinite(value) ? value : null;
    } catch (_) {
      return null;
    }
  }

  function persistValue(key, value) {
    if (!key) return;
    try {
      localStorage.setItem(key, String(value));
    } catch (_) {
      /* Session-only fallback. */
    }
  }

  function applyScale(root, value) {
    var scale = Math.round(value) / 100;
    root.dataset.uiScale = String(Math.round(value));
    root.style.setProperty('--dock-scale', scale.toFixed(2));
  }

  function init(options) {
    if (!options) return null;
    var root = options.root || document.body;
    var control = typeof options.control === 'string' ? document.getElementById(options.control) : options.control;
    var output = typeof options.output === 'string' ? document.getElementById(options.output) : options.output;
    if (!root || !control) return null;

    var min = Number(options.min ?? 70);
    var max = Number(options.max ?? 120);
    var step = Number(options.step ?? 1);
    var fallback = clamp(Number(options.defaultValue ?? 100), min, max);
    var stored = clamp(parseStoredValue(options.storageKey) ?? fallback, min, max);

    control.min = String(min);
    control.max = String(max);
    control.step = String(step);

    function sync(nextValue, shouldPersist) {
      var value = clamp(Number(nextValue), min, max);
      control.value = String(value);
      applyScale(root, value);
      if (output) output.textContent = value + '%';
      if (shouldPersist) persistValue(options.storageKey, value);
      return value;
    }

    sync(stored, false);

    control.addEventListener('input', function () {
      sync(control.value, true);
    });

    control.addEventListener('change', function () {
      sync(control.value, true);
    });

    return {
      get value() {
        return Number(control.value);
      },
      set(value) {
        sync(value, true);
      }
    };
  }

  window.EmberstageDockScale = { init: init, applyScale: applyScale };
})();
