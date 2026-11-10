const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const updaterScript = fs.readFileSync(path.join(__dirname, '../assets/js/dock_auto_updater.js'), 'utf8');

function createEnvironment() {
  const listeners = {};
  const storage = {};
  const headNodes = [];
  const bodyNodes = [];
  const sandbox = {
    window: { location: { pathname: '/control_panel.html', reload: () => {} } },
    crypto: (globalThis.crypto && globalThis.crypto.subtle) ? globalThis.crypto : require('node:crypto').webcrypto,
    TextEncoder: globalThis.TextEncoder,
    Uint8Array: globalThis.Uint8Array,
    document: {
      readyState: 'complete',
      addEventListener: (event, fn) => { listeners[event] = fn; },
      head: { appendChild: (n) => headNodes.push(n) },
      body: { prepend: (n) => bodyNodes.unshift(n), appendChild: (n) => bodyNodes.push(n) },
      getElementById: () => null,
      querySelector: () => null,
      querySelectorAll: (sel) => {
        if (sel.indexOf('stylesheet') !== -1) {
          return [{ getAttribute: () => 'assets/css/control_panel/cp_compact_overrides.css' }];
        }
        return [];
      },
      createElement: (tag) => ({
        tag,
        attrs: {},
        setAttribute(k, v) { this.attrs[k] = v; },
        remove: () => {},
        querySelector: () => null
      })
    },
    navigator: {
      platform: 'MacIntel',
      userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)'
    },
    localStorage: {
      getItem: (key) => storage[key] ?? null,
      setItem: (key, val) => { storage[key] = String(val); },
      removeItem: (key) => { delete storage[key]; }
    },
    setTimeout: () => {},
    clearTimeout: () => {},
    fetch: async () => ({ ok: true, json: async () => ({}) })
  };
  vm.createContext(sandbox);
  vm.runInContext(updaterScript, sandbox);
  return { sandbox, storage, headNodes, bodyNodes };
}

test('EmberstageUpdater parses valid semver strings', () => {
  const { sandbox } = createEnvironment();
  const updater = sandbox.window.EmberstageUpdater;

  const v1 = updater.parseSemver('0.1.0');
  assert.equal(v1.major, 0);
  assert.equal(v1.minor, 1);
  assert.equal(v1.patch, 0);
  assert.equal(v1.prerelease, '');

  const v2 = updater.parseSemver('v0.1.0-beta.4');
  assert.equal(v2.major, 0);
  assert.equal(v2.minor, 1);
  assert.equal(v2.patch, 0);
  assert.equal(v2.prerelease, 'beta.4');

  assert.equal(updater.parseSemver('invalid'), null);
});

test('EmberstageUpdater correctly identifies newer versions', () => {
  const { sandbox } = createEnvironment();
  const updater = sandbox.window.EmberstageUpdater;

  // Major/minor/patch upgrades
  assert.equal(updater.isNewerVersion('0.2.0', '0.1.0'), true);
  assert.equal(updater.isNewerVersion('1.0.0', '0.9.9'), true);
  assert.equal(updater.isNewerVersion('0.1.1', '0.1.0'), true);
  assert.equal(updater.isNewerVersion('0.1.0', '0.1.1'), false);
  assert.equal(updater.isNewerVersion('0.1.0', '0.1.0'), false);

  // Pre-release comparisons
  assert.equal(updater.isNewerVersion('0.1.0-beta.5', '0.1.0-beta.4'), true);
  assert.equal(updater.isNewerVersion('0.1.0-beta.4', '0.1.0-beta.5'), false);
  assert.equal(updater.isNewerVersion('0.1.0', '0.1.0-beta.4'), true); // full release newer than beta
  assert.equal(updater.isNewerVersion('0.1.0-beta.4', '0.1.0'), false);
});

test('version.json matches updater contract format', () => {
  const manifestRaw = fs.readFileSync(path.join(__dirname, '../site/version.json'), 'utf8');
  const manifest = JSON.parse(manifestRaw);

  assert.ok(manifest.version, 'Manifest has version');
  assert.ok(manifest.releaseUrl, 'Manifest has releaseUrl');
  assert.ok(manifest.downloads, 'Manifest has downloads');
  assert.ok(manifest.downloads.windows.installer, 'Manifest has windows installer');
  assert.ok(manifest.downloads.macos.installer, 'Manifest has macos installer');
  assert.ok(manifest.downloads.linux.installer, 'Manifest has linux installer');
});

test('syncOtaBundle verifies SHA-256 and applies OTA CSS patch live', async () => {
  const crypto = require('node:crypto');
  const { sandbox, storage, headNodes } = createEnvironment();
  const updater = sandbox.window.EmberstageUpdater;

  const cssContent = 'body { --ota-verified: 1; }';
  const expectedHash = crypto.createHash('sha256').update(cssContent).digest('hex');

  sandbox.fetch = async (url) => ({
    ok: true,
    text: async () => cssContent
  });

  const synced = await updater.syncOtaBundle({
    version: '0.1.0-beta.10',
    files: {
      'assets/css/control_panel/cp_compact_overrides.css': {
        sha256: expectedHash,
        url: 'https://emberstage.pages.dev/ota/assets/css/control_panel/cp_compact_overrides.css'
      }
    }
  });

  assert.equal(synced, true);
  assert.equal(updater.getActiveVersion(), '0.1.0-beta.10');
  assert.ok(storage['emberstage.ota.bundle.v1']);
  const injectedStyle = headNodes.find((n) => n.attrs && n.attrs['data-ota-asset'] === 'assets/css/control_panel/cp_compact_overrides.css');
  assert.ok(injectedStyle);
  assert.equal(injectedStyle.textContent, cssContent);
});

test('syncOtaBundle rejects tampered OTA asset on SHA-256 mismatch', async () => {
  const { sandbox, storage } = createEnvironment();
  const updater = sandbox.window.EmberstageUpdater;

  sandbox.fetch = async () => ({
    ok: true,
    text: async () => 'body { background: red; }'
  });

  await assert.rejects(
    () => updater.syncOtaBundle({
      version: '0.1.0-beta.10',
      files: {
        'assets/css/control_panel/cp_compact_overrides.css': {
          sha256: '0000000000000000000000000000000000000000000000000000000000000000',
          url: 'https://emberstage.pages.dev/ota/assets/css/control_panel/cp_compact_overrides.css'
        }
      }
    }),
    /SHA-256 mismatch/
  );
  assert.equal(storage['emberstage.ota.bundle.v1'], undefined);
});

