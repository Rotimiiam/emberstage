;(function () {
  'use strict';

  var CURRENT_VERSION = '0.1.0-beta.9';
  var DEFAULT_MANIFEST_URL = 'https://emberstage.pages.dev/version.json';
  var DEFAULT_OTA_MANIFEST_URL = 'https://emberstage.pages.dev/ota-manifest.json';
  var STORAGE_KEY_DISMISSED = 'emberstage.update.dismissedVersion';
  var STORAGE_KEY_LAST_CHECK = 'emberstage.update.lastCheckTime';
  var STORAGE_KEY_OTA_BUNDLE = 'emberstage.ota.bundle.v1';
  var CHECK_INTERVAL_MS = 60 * 1000; // 60 seconds

  function parseSemver(str) {
    if (!str || typeof str !== 'string') return null;
    var cleaned = str.trim().replace(/^v/, '');
    var parts = cleaned.split('-');
    var nums = parts[0].split('.').map(function (n) { return parseInt(n, 10); });
    if (nums.length < 3 || nums.some(isNaN)) return null;
    return {
      major: nums[0],
      minor: nums[1],
      patch: nums[2],
      prerelease: parts[1] || ''
    };
  }

  function isNewerVersion(remote, local) {
    var r = parseSemver(remote);
    var l = parseSemver(local);
    if (!r || !l) return false;
    if (r.major !== l.major) return r.major > l.major;
    if (r.minor !== l.minor) return r.minor > l.minor;
    if (r.patch !== l.patch) return r.patch > l.patch;
    if (r.prerelease && !l.prerelease) return false;
    if (!r.prerelease && l.prerelease) return true;
    if (r.prerelease && l.prerelease) return r.prerelease.localeCompare(l.prerelease, undefined, { numeric: true }) > 0;
    return false;
  }

  function detectOS() {
    var platform = (navigator.userAgentData && navigator.userAgentData.platform) || navigator.platform || navigator.userAgent || '';
    var p = platform.toLowerCase();
    if (p.indexOf('win') !== -1) return 'windows';
    if (p.indexOf('mac') !== -1) return 'macos';
    if (p.indexOf('linux') !== -1) return 'linux';
    return 'windows';
  }

  function getStoredOtaBundle() {
    try {
      var raw = localStorage.getItem(STORAGE_KEY_OTA_BUNDLE);
      if (!raw) return null;
      var parsed = JSON.parse(raw);
      if (!parsed || !parsed.version || typeof parsed.assets !== 'object') return null;
      if (!isNewerVersion(parsed.version, CURRENT_VERSION)) return null;
      return parsed;
    } catch (_) {
      return null;
    }
  }

  function getActiveVersion() {
    var bundle = getStoredOtaBundle();
    return (bundle && bundle.version) ? bundle.version : CURRENT_VERSION;
  }

  function normalizeAssetPath(urlOrPath) {
    if (!urlOrPath) return '';
    var idx = urlOrPath.indexOf('assets/');
    if (idx !== -1) return urlOrPath.slice(idx).split('?')[0].split('#')[0];
    return urlOrPath.split('?')[0].split('#')[0].replace(/^\.\//, '');
  }

  function applyCachedOtaPatches() {
    var bundle = getStoredOtaBundle();
    if (!bundle || !bundle.assets) return false;
    var appliedCount = 0;

    // 1. Apply OTA CSS overrides for stylesheets linked on this page
    var links = document.querySelectorAll('link[rel="stylesheet"][href]');
    for (var i = 0; i < links.length; i++) {
      var relCss = normalizeAssetPath(links[i].getAttribute('href'));
      if (relCss && bundle.assets[relCss] && typeof bundle.assets[relCss].content === 'string') {
        var existingStyle = document.querySelector('style[data-ota-asset="' + relCss + '"]');
        if (!existingStyle) {
          existingStyle = document.createElement('style');
          existingStyle.setAttribute('data-ota-asset', relCss);
          document.head.appendChild(existingStyle);
        }
        existingStyle.textContent = bundle.assets[relCss].content;
        appliedCount++;
      }
    }

    // 2. Apply OTA JS patches for scripts referenced on this page (except protected files and updater itself)
    var scripts = document.querySelectorAll('script[src]');
    for (var j = 0; j < scripts.length; j++) {
      var relJs = normalizeAssetPath(scripts[j].getAttribute('src'));
      // The installed media output must keep its on-disk YouTube player. A cached
      // pages.dev copy would load the old remote player and leave live audio running.
      if (!relJs || relJs === 'assets/js/dock_auto_updater.js' || relJs === 'assets/js/media/native-install.js' || relJs === 'assets/js/outputs/media-output.js') continue;
      if (bundle.assets[relJs] && typeof bundle.assets[relJs].content === 'string') {
        if (!document.querySelector('script[data-ota-asset="' + relJs + '"]')) {
          var patchScript = document.createElement('script');
          patchScript.setAttribute('data-ota-asset', relJs);
          patchScript.textContent = bundle.assets[relJs].content;
          document.body.appendChild(patchScript);
          appliedCount++;
        }
      }
    }
    return appliedCount > 0;
  }

  function computeSha256Hex(text) {
    if (typeof crypto === 'undefined' || !crypto.subtle || typeof TextEncoder === 'undefined') {
      return Promise.resolve(null);
    }
    var bytes = new TextEncoder().encode(text);
    return crypto.subtle.digest('SHA-256', bytes).then(function (buf) {
      var arr = Array.from(new Uint8Array(buf));
      return arr.map(function (b) { return b.toString(16).padStart(2, '0'); }).join('');
    });
  }

  function syncOtaBundle(otaManifest) {
    if (!otaManifest || !otaManifest.version || !otaManifest.files) {
      return Promise.resolve(false);
    }
    if (!isNewerVersion(otaManifest.version, getActiveVersion())) {
      return Promise.resolve(false);
    }

    var fileEntries = Object.keys(otaManifest.files).filter(function (relPath) {
      if (relPath === 'assets/js/media/native-install.js') return false;
      if (relPath.indexOf('local_msg') !== -1) return false;
      return /\.(css|js)$/i.test(relPath);
    });

    var currentBundle = getStoredOtaBundle();
    var existingAssets = (currentBundle && currentBundle.assets) || {};
    var nextAssets = {};

    var tasks = fileEntries.map(function (relPath) {
      var meta = otaManifest.files[relPath];
      if (!meta || !meta.url || !meta.sha256) return Promise.resolve();

      // Reuse already cached & verified asset if sha256 matches
      if (existingAssets[relPath] && existingAssets[relPath].sha256 === meta.sha256) {
        nextAssets[relPath] = existingAssets[relPath];
        return Promise.resolve();
      }

      return fetch(meta.url, { cache: 'no-cache' })
        .then(function (res) {
          if (!res.ok) throw new Error('HTTP ' + res.status + ' for ' + relPath);
          return res.text();
        })
        .then(function (content) {
          return computeSha256Hex(content).then(function (hash) {
            if (!hash || hash.toLowerCase() !== meta.sha256.toLowerCase()) {
              throw new Error('SHA-256 mismatch for ' + relPath);
            }
            nextAssets[relPath] = {
              sha256: meta.sha256.toLowerCase(),
              content: content
            };
          });
        });
    });

    return Promise.all(tasks).then(function () {
      var newBundle = {
        version: otaManifest.version,
        syncedAt: new Date().toISOString(),
        assets: nextAssets
      };
      localStorage.setItem(STORAGE_KEY_OTA_BUNDLE, JSON.stringify(newBundle));
      applyCachedOtaPatches();
      try {
        if (typeof BroadcastChannel !== 'undefined') {
          var ch = new BroadcastChannel('emberstage_ota_sync');
          ch.postMessage({ type: 'ota-updated', version: otaManifest.version });
          ch.close();
        }
      } catch (_) {}
      return true;
    });
  }

  function ensureBannerStyles() {
    if (document.getElementById('emberstage-update-style')) return;
    var style = document.createElement('style');
    style.id = 'emberstage-update-style';
    style.textContent =
      '#emberstage-update-banner {' +
        'position: sticky;' +
        'top: 0;' +
        'left: 0;' +
        'right: 0;' +
        'z-index: 99999;' +
        'background: #171c26;' +
        'border-bottom: 1px solid #d99a38;' +
        'color: #e4e7eb;' +
        'font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;' +
        'font-size: 11px;' +
        'line-height: 1.3;' +
        'box-shadow: 0 2px 8px rgba(0,0,0,0.4);' +
      '}' +
      '.emberstage-update-content {' +
        'display: flex;' +
        'align-items: center;' +
        'gap: 8px;' +
        'padding: 4px 8px;' +
        'max-width: 100%;' +
      '}' +
      '.emberstage-update-badge {' +
        'background: #d99a38;' +
        'color: #0d1117;' +
        'font-weight: 700;' +
        'font-size: 9px;' +
        'text-transform: uppercase;' +
        'padding: 1px 5px;' +
        'border-radius: 3px;' +
        'flex-shrink: 0;' +
        'letter-spacing: 0.04em;' +
      '}' +
      '.emberstage-update-text {' +
        'flex: 1;' +
        'white-space: nowrap;' +
        'overflow: hidden;' +
        'text-overflow: ellipsis;' +
        'color: #c9d1d9;' +
      '}' +
      '.emberstage-update-text strong {' +
        'color: #ffffff;' +
      '}' +
      '.emberstage-update-btn {' +
        'font-size: 10px;' +
        'font-weight: 600;' +
        'padding: 2px 8px;' +
        'border-radius: 3px;' +
        'cursor: pointer;' +
        'text-decoration: none;' +
        'transition: background 0.15s ease;' +
        'flex-shrink: 0;' +
      '}' +
      '.emberstage-update-download {' +
        'background: rgba(217, 154, 56, 0.2);' +
        'color: #f0b24d;' +
        'border: 1px solid #d99a38;' +
      '}' +
      '.emberstage-update-download:hover {' +
        'background: #d99a38;' +
        'color: #0d1117;' +
      '}' +
      '.emberstage-update-dismiss {' +
        'background: transparent;' +
        'border: none;' +
        'color: #8b949e;' +
        'padding: 2px 6px;' +
        'font-size: 11px;' +
      '}' +
      '.emberstage-update-dismiss:hover {' +
        'color: #f0f6fc;' +
      '}';
    document.head.appendChild(style);
  }

  function isOutputPage() {
    var path = (window.location && window.location.pathname) ? window.location.pathname.toLowerCase() : '';
    return path.indexOf('browser_source') !== -1 ||
           path.indexOf('media_output') !== -1 ||
           path.indexOf('camera_output') !== -1 ||
           path.indexOf('emberstage_output') !== -1;
  }

  function showOtaReadyBanner(version) {
    if (!version || !document.body || isOutputPage()) return;
    var existing = document.getElementById('emberstage-update-banner');
    if (existing) existing.remove();
    ensureBannerStyles();

    var banner = document.createElement('div');
    banner.id = 'emberstage-update-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'OTA update ready');
    banner.innerHTML =
      '<div class="emberstage-update-content">' +
        '<span class="emberstage-update-badge">OTA Updated</span>' +
        '<span class="emberstage-update-text">Emberstage <strong>v' + escapeHtml(version) + '</strong> downloaded over-the-air.</span>' +
        '<button type="button" class="emberstage-update-btn emberstage-update-download emberstage-ota-reload">Apply Now</button>' +
        '<button type="button" class="emberstage-update-btn emberstage-update-dismiss" aria-label="Dismiss update notification">✕</button>' +
      '</div>';

    document.body.prepend(banner);
    var reloadBtn = banner.querySelector('.emberstage-ota-reload');
    if (reloadBtn) {
      reloadBtn.addEventListener('click', function () {
        window.location.reload();
      });
    }
    var dismissBtn = banner.querySelector('.emberstage-update-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        banner.remove();
      });
    }
  }

  function showUpdateBanner(info) {
    if (!info || !info.version || !document.body || isOutputPage()) return;
    try {
      if (localStorage.getItem(STORAGE_KEY_DISMISSED) === info.version) return;
    } catch (_) {}

    var existing = document.getElementById('emberstage-update-banner');
    if (existing) existing.remove();
    ensureBannerStyles();

    var os = detectOS();
    var downloadUrl = (info.downloads && info.downloads[os] && info.downloads[os].installer) || info.releaseUrl || 'https://github.com/Rotimiiam/emberstage/releases';

    var banner = document.createElement('div');
    banner.id = 'emberstage-update-banner';
    banner.setAttribute('role', 'region');
    banner.setAttribute('aria-label', 'Software update notification');

    banner.innerHTML =
      '<div class="emberstage-update-content">' +
        '<span class="emberstage-update-badge">Update Available</span>' +
        '<span class="emberstage-update-text">Emberstage <strong>v' + escapeHtml(info.version) + '</strong> is ready.</span>' +
        '<a class="emberstage-update-btn emberstage-update-download" href="' + escapeHtml(downloadUrl) + '" target="_blank" rel="noopener noreferrer">Get Update</a>' +
        '<button type="button" class="emberstage-update-btn emberstage-update-dismiss" aria-label="Dismiss update notification">✕</button>' +
      '</div>';

    document.body.prepend(banner);

    var dismissBtn = banner.querySelector('.emberstage-update-dismiss');
    if (dismissBtn) {
      dismissBtn.addEventListener('click', function () {
        try {
          localStorage.setItem(STORAGE_KEY_DISMISSED, info.version);
        } catch (_) {}
        banner.remove();
      });
    }
  }

  function escapeHtml(text) {
    if (!text) return '';
    return String(text)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function checkForUpdates(manifestUrl, options) {
    var url = manifestUrl || DEFAULT_MANIFEST_URL;
    var otaUrl = (options && options.otaManifestUrl) || DEFAULT_OTA_MANIFEST_URL;
    var force = options && options.force;
    try {
      var lastCheck = parseInt(localStorage.getItem(STORAGE_KEY_LAST_CHECK) || '0', 10);
      if (!force && Date.now() - lastCheck < CHECK_INTERVAL_MS) {
        return Promise.resolve(false);
      }
    } catch (_) {}

    var controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;

    return fetch(url, {
      method: 'GET',
      headers: { 'Accept': 'application/json' },
      cache: 'no-cache',
      signal: controller ? controller.signal : undefined
    })
      .then(function (res) {
        if (!res.ok) throw new Error('HTTP ' + res.status);
        return res.json();
      })
      .then(function (data) {
        if (timer) clearTimeout(timer);
        try {
          localStorage.setItem(STORAGE_KEY_LAST_CHECK, String(Date.now()));
        } catch (_) {}
        var activeVer = getActiveVersion();
        if (data && data.version && isNewerVersion(data.version, activeVer)) {
          // Attempt zero-installer OTA sync first; fall back to installer banner if native update is required
          if (data.requiresNativeInstaller) {
            showUpdateBanner(data);
            return true;
          }
          return fetch(otaUrl, { cache: 'no-cache' })
            .then(function (r) {
              if (!r.ok) throw new Error('No OTA manifest');
              return r.json();
            })
            .then(function (otaManifest) {
              return syncOtaBundle(otaManifest);
            })
            .then(function (synced) {
              if (synced) {
                showOtaReadyBanner(data.version);
                return true;
              }
              showUpdateBanner(data);
              return true;
            })
            .catch(function () {
              showUpdateBanner(data);
              return true;
            });
        }
        return false;
      })
      .catch(function (_) {
        if (timer) clearTimeout(timer);
        return false;
      });
  }

  // Listen for OTA sync events from sibling docks so all docks & outputs stay in sync
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      var otaChannel = new BroadcastChannel('emberstage_ota_sync');
      otaChannel.onmessage = function (ev) {
        if (ev && ev.data && ev.data.type === 'ota-updated') {
          applyCachedOtaPatches();
        }
      };
    }
  } catch (_) {}

  function initUpdater() {
    applyCachedOtaPatches();
    if (!isOutputPage()) {
      setTimeout(checkForUpdates, 3000);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initUpdater);
  } else {
    initUpdater();
  }

  window.EmberstageUpdater = {
    currentVersion: CURRENT_VERSION,
    getActiveVersion: getActiveVersion,
    checkForUpdates: checkForUpdates,
    syncOtaBundle: syncOtaBundle,
    applyCachedOtaPatches: applyCachedOtaPatches,
    isNewerVersion: isNewerVersion,
    parseSemver: parseSemver
  };
})();
