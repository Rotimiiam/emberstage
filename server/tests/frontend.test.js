import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appJsPath = path.resolve(__dirname, '../public/app.js');
const dockPath = path.resolve(__dirname, '../../streaming_dock.html');
const siteIndexPath = path.resolve(__dirname, '../../site/index.html');
const portalHtmlPath = path.resolve(__dirname, '../public/app.html');

// Helper to create a fully featured mock DOM element
function createMockElement(tag, id = '') {
  const el = {
    tagName: tag.toUpperCase(),
    id: id,
    className: '',
    value: '',
    textContent: '',
    innerHTML: '',
    dataset: {},
    style: { display: 'none' },
    classList: {
      add: () => {},
      remove: () => {},
      toggle: () => {},
      contains: () => false
    },
    setAttribute: () => {},
    matches: () => false,
    closest: () => null,
    listeners: {},
    addEventListener(event, cb) {
      this.listeners[event] = cb;
    },
    dispatchEvent(event) {
      if (this.listeners[event.type]) {
        this.listeners[event.type](event);
      }
    },
    children: [],
    appendChild(child) {
      el.children.push(child);
    }
  };
  return el;
}

// Helper to create a minimal browser DOM environment in VM
function createMockDOM() {
  const store = {};
  const elements = {};

  const document = {
    cookie: '',
    visibilityState: 'visible',
    getElementById(id) {
      if (!elements[id]) {
        elements[id] = createMockElement('div', id);
      }
      return elements[id];
    },
    addEventListener(event, cb) {
      if (!elements['document']) {
        elements['document'] = { listeners: {} };
      }
      elements['document'].listeners[event] = cb;
    },
    createElement(tag) {
      return createMockElement(tag);
    },
    createTextNode(text) {
      return { textContent: text, type: 'text' };
    },
    activeElement: null,
    querySelectorAll() { return []; }
  };

  const window = {
    addEventListener(event, cb) {
      if (!elements['window']) {
        elements['window'] = { listeners: {} };
      }
      elements['window'].listeners[event] = cb;
    },
    location: { href: '', hash: '' }
  };

  const localStorage = {
    getItem(key) { return store[key] || null; },
    setItem(key, val) { store[key] = String(val); },
    removeItem(key) { delete store[key]; }
  };

  return {
    document,
    window,
    localStorage,
    elements,
    store
  };
}

test('frontend: getSelectedBroadcastForTarget prioritization and logout secrets cleanup', async () => {
  const { document, window, localStorage, elements } = createMockDOM();
  const context = vm.createContext({
    document,
    window,
    localStorage,
    console,
    setTimeout: () => {},
    setInterval: () => {},
    URL,
    URLSearchParams,
    fetch: async () => ({ ok: true, text: async () => '{}' })
  });

  const appJsCode = fs.readFileSync(appJsPath, 'utf8');
  try {
    vm.runInContext(appJsCode, context);
  } catch (err) {
    console.error('ERROR during runInContext of app.js:', err);
    throw err;
  }

  // Retrieve the lexically scoped references
  let state, getSelectedBroadcastForTarget, setupEventListeners;
  try {
    state = vm.runInContext("state", context);
    getSelectedBroadcastForTarget = vm.runInContext("getSelectedBroadcastForTarget", context);
    setupEventListeners = vm.runInContext("setupEventListeners", context);
  } catch (err) {
    console.error('ERROR during variable retrieval:', err);
    throw err;
  }

  // Initial state check
  assert.equal(state.user, null);

  // Mock workspace targets
  state.activeWorkspaceId = 'ws-123';
  state.youtubeBroadcastSelections['target-1'] = 'b-selected';
  state.youtubeBroadcasts['target-1'] = [
    { id: 'b-selected', title: 'Selected Broadcast Title' },
    { id: 'b-other', title: 'Other Broadcast' }
  ];
  state.setup.destinations = [
    {
      id: 'target-1',
      broadcast: { id: 'b-dest', title: 'Destination Broadcast Title' }
    }
  ];

  // Test priority: selection first
  const selected = getSelectedBroadcastForTarget('target-1');
  assert.ok(selected);
  assert.equal(selected.id, 'b-selected');
  assert.equal(selected.title, 'Selected Broadcast Title');

  // Test fallback: no selection, returns destination broadcast
  delete state.youtubeBroadcastSelections['target-1'];
  const fallback = getSelectedBroadcastForTarget('target-1');
  assert.ok(fallback);
  assert.equal(fallback.id, 'b-dest');
  assert.equal(fallback.title, 'Destination Broadcast Title');

  // Run setupEventListeners to register listeners on our mock elements
  setupEventListeners();

  const logoutBtn = elements['logout-btn'];
  assert.ok(logoutBtn);
  const logoutListener = logoutBtn.listeners['click'];
  assert.ok(logoutListener);

  // Test logout clears all secrets and draft states
  state.user = { id: 'user-1' };
  state.drafts.customTarget.stream_key = 'super_secret_stream_key';
  assert.equal(state.drafts.customTarget.stream_key, 'super_secret_stream_key');

  // Call logout asynchronously
  context.showView = () => {};
  await logoutListener();

  assert.equal(state.user, null);
  assert.equal(state.drafts.customTarget.stream_key, '');
  assert.equal(state.activeWorkspaceId, null);
});

test('frontend: billing fails closed without server entitlements and never offers a second active checkout', async () => {
  const dom = createMockDOM();
  let requests = 0;
  const context = vm.createContext({ ...dom, console, URL, URLSearchParams,
    setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {},
    fetch: async () => { requests++; return { ok: true, text: async () => '{}' }; }
  });
  vm.runInContext(fs.readFileSync(appJsPath, 'utf8'), context);
  vm.runInContext(`state.activeWorkspace = { id: 'ws', name: 'Studio', stripe_status: 'active', stripe_customer_id: 'legacy', max_devices: 99 };
    state.activeWorkspaceId = 'ws'; state.activeWorkspaceRole = 'owner';`, context);
  assert.equal(vm.runInContext('getWorkspaceEntitlement().canStream', context), false);
  assert.equal(vm.runInContext('getWorkspaceEntitlement().maxDevices', context), 0);
  assert.equal(vm.runInContext('getWorkspaceSubscription().manageAvailable', context), false);
  await vm.runInContext('handleBillingCheckout()', context);
  assert.equal(requests, 0);
  vm.runInContext(`state.billing.workspace = { checkoutAvailable: true, mode: 'test', plan: { amount: 300000, currency: 'NGN', interval: 'monthly', maxDevices: 3, maxDestinations: 3, maxActiveBroadcasts: 1 },
    entitlement: { plan: 'pro', canStream: true, maxDevices: 3, maxDestinations: 3, maxActiveBroadcasts: 1 }, subscription: { status: 'active', manageAvailable: true } }; renderSubscriptionPanel();`, context);
  assert.match(dom.elements['subscription-panel'].innerHTML, /data-action="billing-checkout" disabled>Pro is active/);
  await vm.runInContext('handleBillingCheckout()', context);
  assert.equal(requests, 0);
  vm.runInContext(`state.activeWorkspaceRole = 'operator'; renderSubscriptionPanel();`, context);
  assert.match(dom.elements['subscription-panel'].innerHTML, /data-action="billing-portal" disabled/);
  await vm.runInContext('handleBillingPortal()', context);
  assert.equal(requests, 0);
});

test('frontend: verified expired payment does not falsely announce active Pro', async () => {
  const dom = createMockDOM();
  const context = vm.createContext({ ...dom, console, URL, URLSearchParams,
    setTimeout: () => {}, clearTimeout: () => {}, setInterval: () => {},
    fetch: async () => ({ ok: true, text: async () => JSON.stringify({ verified: true, entitlement: { canStream: false } }) })
  });
  vm.runInContext(fs.readFileSync(appJsPath, 'utf8'), context);
  vm.runInContext(`loadWorkspaceData = async () => {}; state.activeWorkspaceId = 'ws';
    state.billing.returnFlow = { workspaceId: 'ws', reference: 'old-payment', attempts: 0 };`, context);
  await vm.runInContext('verifyBillingReturn()', context);
  assert.equal(vm.runInContext('state.ui.statuses.billing.type', context), 'warning');
  assert.doesNotMatch(vm.runInContext('state.ui.statuses.billing.message', context), /Pro access is active/);
});

test('frontend: compact auth modes preserve workspace field and hide unavailable OAuth methods', () => {
  const { document, window, localStorage } = createMockDOM();
  const context = vm.createContext({ document, window, localStorage, console, URL, URLSearchParams });
  vm.runInContext(fs.readFileSync(appJsPath, 'utf8'), context);
  const auth0 = document.getElementById('auth0-auth-button');
  const google = document.getElementById('google-auth-button');
  auth0.hidden = true;
  google.hidden = true;

  vm.runInContext('renderAuthView()', context);
  assert.equal(document.getElementById('auth-title').textContent, 'Welcome back');
  assert.equal(document.getElementById('workspace-group').style.display, 'none');
  assert.equal(document.getElementById('auth-methods').hidden, true);
  assert.equal(document.getElementById('auth-divider').hidden, true);

  vm.runInContext('state.isRegisterMode = true; renderAuthView()', context);
  assert.equal(document.getElementById('workspace-group').style.display, 'block');
  assert.equal(document.getElementById('auth-submit-btn').textContent, 'Create workspace');

  auth0.hidden = false;
  auth0.style.display = '';
  vm.runInContext('updateAuthMethodsVisibility()', context);
  assert.equal(document.getElementById('auth-methods').hidden, false);
  assert.equal(document.getElementById('auth-divider').hidden, false);
  auth0.style.display = 'none';
  vm.runInContext('updateAuthMethodsVisibility()', context);
  assert.equal(document.getElementById('auth-methods').hidden, true);
  assert.equal(document.getElementById('auth-divider').hidden, true);
});

test('frontend: isUserInteracting checks and thumbnail constraints', () => {
  const { document, window, localStorage } = createMockDOM();
  const context = vm.createContext({
    document,
    window,
    localStorage,
    console,
    setTimeout: () => {},
    setInterval: () => {},
    URL,
    URLSearchParams
  });

  const appJsCode = fs.readFileSync(appJsPath, 'utf8');
  try {
    vm.runInContext(appJsCode, context);
  } catch (err) {
    console.error('ERROR during runInContext of app.js (test 2):', err);
    throw err;
  }

  const state = vm.runInContext("state", context);
  const isUserInteracting = vm.runInContext("isUserInteracting", context);
  const handleUploadThumbnail = vm.runInContext("handleUploadThumbnail", context);

  // 1. User interaction check when no inputs are focused
  document.activeElement = null;
  assert.equal(isUserInteracting(), false);

  // 2. User interaction check when an input is focused
  document.activeElement = { tagName: 'INPUT' };
  assert.equal(isUserInteracting(), true);

  // 3. User interaction check when a thumbnail is selected
  document.activeElement = null;
  state.youtubeThumbnailFiles['target-1'] = { name: 'test.png', size: 5000 };
  assert.equal(isUserInteracting(), true);

  // 4. Thumbnail validation mock
  let alertType = null;
  let alertMsg = null;
  context.setStatus = (section, type, msg) => {
    alertType = type;
    alertMsg = msg;
  };
  context.renderYouTubeStudio = () => {};

  // Mock valid file
  state.youtubeThumbnailFiles['target-1'] = {
    name: 'test.png',
    type: 'image/png',
    size: 1.5 * 1024 * 1024
  };
  handleUploadThumbnail('target-1');
  assert.notEqual(alertType, 'danger');

  // Mock invalid type
  state.youtubeThumbnailFiles['target-1'] = {
    name: 'test.gif',
    type: 'image/gif',
    size: 500
  };
  handleUploadThumbnail('target-1');
  assert.equal(alertType, 'danger');
  assert.ok(alertMsg.includes('must be a JPEG or PNG'));

  // Mock oversize file (2.5MB)
  state.youtubeThumbnailFiles['target-1'] = {
    name: 'test.png',
    type: 'image/png',
    size: 2.5 * 1024 * 1024
  };
  handleUploadThumbnail('target-1');
  assert.equal(alertType, 'danger');
  assert.ok(alertMsg.includes('under 2MB'));
});

test('frontend: setActiveView updates hash and view state', () => {
  const { document, window, localStorage } = createMockDOM();
  const sections = [
    { dataset: { view: 'overview' }, hidden: false },
    { dataset: { view: 'broadcasts' }, hidden: true },
    { dataset: { view: 'devices' }, hidden: true },
    { dataset: { view: 'workspace' }, hidden: true }
  ];
  const navButtons = [
    { dataset: { view: 'overview' }, classList: { toggle() {} }, setAttribute() {} },
    { dataset: { view: 'broadcasts' }, classList: { toggle() {} }, setAttribute() {} },
    { dataset: { view: 'devices' }, classList: { toggle() {} }, setAttribute() {} },
    { dataset: { view: 'workspace' }, classList: { toggle() {} }, setAttribute() {} }
  ];
  document.querySelectorAll = (selector) => {
    if (selector === '.portal-view') return sections;
    if (selector === '[data-action="open-view"]') return navButtons;
    return [];
  };

  const context = vm.createContext({
    document,
    window,
    localStorage,
    console,
    setTimeout: () => {},
    setInterval: () => {},
    URL,
    URLSearchParams
  });

  vm.runInContext(fs.readFileSync(appJsPath, 'utf8'), context);
  vm.runInContext("setActiveView('devices')", context);

  assert.equal(window.location.hash, '#devices');
  assert.equal(sections[0].hidden, true);
  assert.equal(sections[2].hidden, false);
  assert.equal(document.getElementById('view-title').textContent, 'Devices');
});

test('streaming_dock: token refresh race safety and renderDestinations safe text nodes', async () => {
  const { document, window, localStorage } = createMockDOM();
  
  // Extract script from HTML
  const htmlContent = fs.readFileSync(dockPath, 'utf8');
  const scriptMatch = htmlContent.match(/<script>([\s\S]*?)<\/script>/);
  assert.ok(scriptMatch, 'script tag should be found in streaming_dock.html');
  let scriptContent = scriptMatch[1];

  // Expose internal functions and state for testing by rewriting the script content slightly
  scriptContent = "var testEnv = {};\n" + scriptContent.replace(
    "var state = {",
    "var state = testEnv.state = {"
  ).replace(
    "async function refreshDeviceSession() {",
    "testEnv.refreshDeviceSession = refreshDeviceSession;\nasync function refreshDeviceSession() {"
  );

  let fetchCalls = 0;
  const mockFetch = async (url, options) => {
    fetchCalls++;
    // Simulate latency for token refresh
    await new Promise(resolve => setTimeout(resolve, 50));
    return {
      ok: true,
      text: async () => JSON.stringify({
        accessToken: 'new-access-token',
        refreshToken: 'new-refresh-token'
      })
    };
  };

  const context = vm.createContext({
    document,
    window,
    localStorage,
    console,
    fetch: mockFetch,
    setTimeout: () => {},
    setInterval: () => {},
    URL,
    URLSearchParams
  });

  try {
    vm.runInContext(scriptContent, context);
  } catch (err) {
    // Expected initialization might complete partially; retrieve testEnv regardless
  }

  // Retrieve testEnv where we exposed internal state and functions
  const testEnv = vm.runInContext("testEnv", context);
  const state = testEnv.state;
  const refreshDeviceSession = testEnv.refreshDeviceSession;

  // Initialize session state
  state.session = {
    baseUrl: 'http://localhost:3000',
    accessToken: 'expired-token',
    refreshToken: 'valid-refresh-token'
  };

  // Trigger concurrent refreshes
  const p1 = refreshDeviceSession();
  const p2 = refreshDeviceSession();
  const p3 = refreshDeviceSession();

  const [t1, t2, t3] = await Promise.all([p1, p2, p3]);

  // Assert single fetch call and equal tokens returned (race-safe lock)
  assert.equal(fetchCalls, 1);
  assert.equal(t1, 'new-access-token');
  assert.equal(t2, 'new-access-token');
  assert.equal(t3, 'new-access-token');

  // Verify that renderDestinations script handles untrusted broadcast.title securely (does not use innerHTML)
  // Let's inspect the code of renderDestinations inside scriptContent directly
  assert.ok(!scriptContent.includes('broadcast.innerHTML ='), 'Should not contain dangerous assignment to innerHTML');
});

test('frontend copy reflects OBS-start auto-go-live approval flow', () => {
  const appJsCode = fs.readFileSync(appJsPath, 'utf8');
  const dockHtml = fs.readFileSync(dockPath, 'utf8');

  assert.ok(appJsCode.includes('approved to auto-go-live when OBS starts streaming'));
  assert.ok(appJsCode.includes('approved YouTube channels should go live automatically without a second Go Live click'));
  assert.ok(!appJsCode.includes('Go Live on YouTube'));

  assert.ok(dockHtml.includes('Portal controls approval.'));
  assert.ok(dockHtml.includes('No approved channels'));
  assert.ok(dockHtml.includes('Approved channels should join automatically.'));
});

test('frontend branding uses local emberstage svg assets', () => {
  const siteHtml = fs.readFileSync(siteIndexPath, 'utf8');
  const portalHtml = fs.readFileSync(portalHtmlPath, 'utf8');
  const dockHtml = fs.readFileSync(dockPath, 'utf8');

  assert.ok(siteHtml.includes('brand/favicon.svg'));
  assert.ok(siteHtml.includes('brand/emberstage-wordmark.svg'));

  assert.ok(portalHtml.includes('/assets/brand/favicon.svg'));
  assert.ok(portalHtml.includes('/assets/brand/emberstage-wordmark.svg'));

  assert.ok(dockHtml.includes('assets/brand/favicon.svg'));
  assert.ok(dockHtml.includes('assets/brand/emberstage-logo.svg'));
  assert.ok(!dockHtml.includes('assets/brand/emberstage-wordmark.svg'), 'compact dock must not duplicate the wordmark');
});
