import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import test from 'node:test';

const source = readFileSync(new URL('../public/app.js', import.meta.url), 'utf8');

function portal({ blocked = false, failed = false } = {}) {
  function element() {
    return {
      style: {}, children: [], textContent: '', classList: { add() {}, remove() {}, toggle() {} },
      appendChild(child) { this.children.push(child); },
      set innerHTML(value) { this.children = []; this.html = value; },
      get innerHTML() { return this.html || ''; },
      setAttribute() {},
      addEventListener() {}
    };
  }
  const nodes = new Map();
  const events = {};
  const order = [];
  const popup = { opener: {}, closed: false, location: {}, close() { this.closed = true; } };
  const document = {
    visibilityState: 'visible',
    getElementById(id) {
      if (!nodes.has(id)) nodes.set(id, element());
      return nodes.get(id);
    },
    createElement: element,
    createTextNode: text => ({ textContent: text }),
    addEventListener(name, handler) { events[name] = handler; }
  };
  const window = {
    location: { href: '/app' },
    open(url, target) {
      order.push('open');
      assert.equal(url, 'about:blank');
      assert.equal(target, '_blank');
      return blocked ? null : popup;
    },
    addEventListener(name, handler) { events[name] = handler; }
  };
  let requests = 0;
  const context = vm.createContext({ document, window, URL, URLSearchParams, clearTimeout() {}, setTimeout() {}, setInterval() {}, async mockApi(method, path) {
    requests++;
    order.push('api');
    if (method === 'POST') {
      if (failed) throw new Error('Connector unavailable');
      return { url: 'http://connect.test/session' };
    }
    if (path.endsWith('/providers')) {
      return { success: true, providers: { youtube: { connected: true } } };
    }
    if (path.endsWith('/providers/targets')) return [{ id: 'yt-1', provider: 'youtube', name: 'Test Channel', selected: false }];
    if (path.endsWith('/streams/setup')) return { devices: [], stream: null, destinations: [] };
    if (path.endsWith('/streams/custom-targets')) return { targets: [] };
    if (path.endsWith('/broadcasts')) return { broadcasts: [] };
    return { success: true, workspace: { id: 'ws-1', name: 'Test Studio' } };
  } });
  vm.runInContext(source, context);
  vm.runInContext(`
    apiCall = mockApi;
    state.user = { email: 'test@example.test' };
    state.activeWorkspaceId = 'ws-1';
    state.providers = { youtube: { connected: false, connect_available: true } };
    setupEventListeners();
    renderChannelsPanel();
  `, context);
  return { nodes, events, order, popup, window, document, context, requests: () => requests,
    card: () => vm.runInContext("renderProviderCard('youtube')", context),
    connect: () => vm.runInContext("handleConnectProvider('youtube')", context) };
}

test('connect opens exactly one tab before the API call and leaves the portal in place', async () => {
  const p = portal();
  await p.connect();
  assert.deepEqual(p.order, ['open', 'api']);
  assert.equal(p.popup.opener, null);
  assert.equal(p.popup.location.href, 'http://connect.test/session');
  assert.equal(p.window.location.href, '/app');
  assert.match(p.card(), /then return here/);
});

test('blocked popup offers a safe clickable link rather than redirecting the portal', async () => {
  const p = portal({ blocked: true });
  await p.connect();
  assert.deepEqual(p.order, ['open', 'api']);
  assert.match(p.card(), /href="http:\/\/connect.test\/session" target="_blank" rel="noopener noreferrer"/);
  assert.equal(p.window.location.href, '/app');
});

test('returning to the portal refreshes the connected badge and channel, without duplicate requests', async () => {
  const p = portal();
  const focus = p.events.focus();
  const visible = p.events.visibilitychange();
  await Promise.all([focus, visible]);
  assert.equal(p.requests(), 7); // Includes the server-authoritative billing summary.
  assert.match(p.card(), />Connected</);
  // Destinations are rendered once in the flat list, not nested in account management.
  const channels = p.nodes.get('channels-panel').innerHTML;
  assert.match(channels, /Test Channel/);
  assert.equal(channels.match(/<strong>Test Channel<\/strong>/g).length, 1);
  p.document.visibilityState = 'hidden';
  await p.events.visibilitychange();
  assert.equal(p.requests(), 7);
  p.document.visibilityState = 'visible';
  vm.runInContext('state.user = null', p.context);
  await p.events.focus();
  assert.equal(p.requests(), 7);
});

test('failed connector request closes the blank tab and re-enables the button', async () => {
  const p = portal({ failed: true });
  await p.connect();
  assert.equal(p.popup.closed, true);
  assert.equal(vm.runInContext("isBusy('provider-connect-youtube')", p.context), false);
  assert.match(p.card(), /Connector unavailable/);
  assert.equal(p.window.location.href, '/app');
});

function billingReturnPortal({ authenticated = true, workspaceId = 'ws-2', result = { verified: true, entitlement: { canStream: true } } } = {}) {
  const p = portal();
  const stored = new Map();
  p.window.sessionStorage = { getItem: key => stored.get(key), setItem: (key, value) => stored.set(key, value), removeItem: key => stored.delete(key) };
  p.window.location = new URL(`http://portal.test/app?billing=return&workspaceId=${workspaceId}&reference=test-reference#workspace`);
  p.window.history = { replaceState(_state, _title, url) { p.window.location = new URL(url, p.window.location); } };
  const requests = [];
  p.context.testAuthenticated = authenticated;
  p.context.billingApi = async (method, path, body) => {
    if (path === '/api/auth/me') return { success: p.context.testAuthenticated, user: { id: 'user' } };
    if (path === '/api/workspaces') return { workspaces: [{ id: 'ws-1' }, { id: 'ws-2' }] };
    requests.push({ method, path, body: JSON.parse(JSON.stringify(body)) });
    return result;
  };
  vm.runInContext(`
    apiCall = billingApi;
    configureProductAuth = async () => {};
    showView = () => {};
    loadWorkspaceData = async () => {};
    renderSubscriptionPanel = () => {};
  `, p.context);
  return { ...p, requests, stored, init: () => vm.runInContext('init()', p.context) };
}

test('checkout return automatically verifies the returned workspace and clears return parameters', async () => {
  const p = billingReturnPortal();
  await p.init();
  assert.deepEqual(p.requests, [{ method: 'POST', path: '/api/workspaces/ws-2/billing/verify', body: { reference: 'test-reference' } }]);
  assert.equal(p.window.location.search, '');
  assert.equal(p.window.location.hash, '#workspace');
  assert.equal(p.stored.size, 0);
  assert.equal(vm.runInContext('state.billing.stickyNotice.type', p.context), 'success');
  await p.init();
  assert.equal(p.requests.length, 1, 'successful return is not verified again on reinitialization');
});

test('checkout return survives required login, then verifies after authentication', async () => {
  const p = billingReturnPortal({ authenticated: false });
  await p.init();
  assert.equal(p.requests.length, 0);
  assert.equal(p.stored.size, 1);
  p.context.testAuthenticated = true;
  await p.init();
  assert.equal(p.requests.length, 1);
  assert.equal(p.stored.size, 0);
});

test('checkout return cannot verify a workspace outside the signed-in memberships', async () => {
  const p = billingReturnPortal({ workspaceId: 'foreign-workspace' });
  await p.init();
  assert.equal(p.requests.length, 0);
  assert.match(vm.runInContext('state.billing.returnFlow.lastError', p.context), /do not belong/);
});

test('pending payment stays unconfirmed and offers working retry and dismiss actions', async () => {
  const p = billingReturnPortal({ result: { verified: false, message: 'Pending verification' } });
  await p.init();
  assert.equal(vm.runInContext('state.billing.stickyNotice', p.context), null);
  assert.equal(p.stored.size, 1);
  const click = action => p.events.click({ target: { closest: () => ({ dataset: { action } }) } });
  await click('billing-manual-retry');
  assert.equal(p.requests.length, 2);
  await click('billing-dismiss-return');
  assert.equal(p.stored.size, 0);
  assert.equal(vm.runInContext('state.billing.returnFlow', p.context), null);
});
