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
  const context = vm.createContext({ document, window, URL, setTimeout() {}, setInterval() {}, async mockApi(method, path) {
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
  assert.equal(p.requests(), 6);
  assert.match(p.card(), />Connected</);
  // Destinations are rendered once in the flat list, not nested in account management.
  const channels = p.nodes.get('channels-panel').innerHTML;
  assert.match(channels, /Test Channel/);
  assert.equal(channels.match(/<strong>Test Channel<\/strong>/g).length, 1);
  p.document.visibilityState = 'hidden';
  await p.events.visibilitychange();
  assert.equal(p.requests(), 6);
  p.document.visibilityState = 'visible';
  vm.runInContext('state.user = null', p.context);
  await p.events.focus();
  assert.equal(p.requests(), 6);
});

test('failed connector request closes the blank tab and re-enables the button', async () => {
  const p = portal({ failed: true });
  await p.connect();
  assert.equal(p.popup.closed, true);
  assert.equal(vm.runInContext("isBusy('provider-connect-youtube')", p.context), false);
  assert.match(p.card(), /Connector unavailable/);
  assert.equal(p.window.location.href, '/app');
});
