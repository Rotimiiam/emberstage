import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mediaAppJsPath = path.resolve(__dirname, '../../assets/js/media/owned-media-app.js');
const dockUiScaleJsPath = path.resolve(__dirname, '../../assets/js/dock_ui_scale.js');

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
      items: new Set(),
      add(cls) { this.items.add(cls); el.className = Array.from(this.items).join(' '); },
      remove(cls) { this.items.delete(cls); el.className = Array.from(this.items).join(' '); },
      toggle(cls, force) {
        if (force === undefined) {
          if (this.items.has(cls)) this.items.delete(cls);
          else this.items.add(cls);
        } else if (force) {
          this.items.add(cls);
        } else {
          this.items.delete(cls);
        }
        el.className = Array.from(this.items).join(' ');
      },
      contains(cls) { return this.items.has(cls); }
    },
    setAttribute(name, value) { el[name] = value; },
    getAttribute(name) { return el[name]; },
    matches: () => false,
    closest: () => null,
    listeners: {},
    addEventListener(event, cb) {
      if (!this.listeners[event]) this.listeners[event] = [];
      this.listeners[event].push(cb);
    },
    dispatchEvent(event) {
      if (this.listeners[event.type]) {
        for (const cb of this.listeners[event.type]) {
          cb(event);
        }
      }
    },
    children: [],
    appendChild(child) {
      el.children.push(child);
    },
    append(...nodes) {
      el.children.push(...nodes);
    },
    replaceChildren(...nodes) {
      el.children = nodes;
    },
    querySelectorAll(selector) {
      const results = [];
      function traverse(node) {
        if (!node || !node.children) return;
        node.children.forEach(c => {
          if (c.tagName && selector && c.tagName.toLowerCase() === selector.toLowerCase()) {
            results.push(c);
          }
          traverse(c);
        });
      }
      traverse(el);
      return results;
    }
  };
  return el;
}

function createMockDOM() {
  const store = {};
  const elements = {};

  const document = {
    body: {
      dataset: {},
      style: {
        values: {},
        setProperty(name, value) {
          this.values[name] = value;
        }
      }
    },
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
    querySelectorAll(selector) {
      const results = [];
      Object.values(elements).forEach(el => {
        if (el.tagName && selector && el.tagName.toLowerCase() === selector.toLowerCase()) {
          results.push(el);
        }
      });
      return results;
    }
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

class MockBroadcastChannel {
  constructor(name) {
    this.name = name;
    this.sentMessages = [];
    MockBroadcastChannel.instances.push(this);
  }
  postMessage(msg) {
    this.sentMessages.push(msg);
  }
  close() {}
}
MockBroadcastChannel.instances = [];

class MockURL {
  static createObjectURL(blob) { return 'blob-url-' + Math.random(); }
  static revokeObjectURL(url) {}
}

const mockCrypto = {
  randomUUID() { return 'uuid-1234'; }
};

test('media-dock: initialization and stable elements', () => {
  const dom = createMockDOM();
  const context = vm.createContext({
    document: dom.document,
    window: dom.window,
    localStorage: dom.localStorage,
    BroadcastChannel: MockBroadcastChannel,
    URL: MockURL,
    crypto: mockCrypto,
    console,
    setTimeout,
    setInterval: () => {},
    navigator: {
      storage: {
        estimate: async () => ({ usage: 1000, quota: 100000 })
      }
    }
  });

  const dockScaleCode = fs.readFileSync(dockUiScaleJsPath, 'utf8');
  vm.runInContext(dockScaleCode, context);

  const appCode = fs.readFileSync(mediaAppJsPath, 'utf8');
  vm.runInContext(appCode, context);

  const mainApp = dom.elements['media-app'];
  assert.ok(mainApp, 'media-app container must exist');

  const header = mainApp.children.find(c => c.className === 'deckbar');
  const sizeWrap = header.children.find(c => c.className === 'dock-ui-scale');
  assert.ok(sizeWrap, 'dock-ui-scale control must exist');
  const size = sizeWrap.children.find(c => c.id === 'media-dock-scale');
  const sizeValue = sizeWrap.children.find(c => c.id === 'media-dock-scale-value');
  assert.ok(size, 'media-dock-scale slider must exist');
  assert.ok(sizeValue, 'media-dock-scale-value readout must exist');
  dom.store['obs-bible:cameras:ui-scale'] = '105';
  size.value = '92';
  size.dispatchEvent({ type: 'input' });
  assert.equal(dom.document.body.dataset.uiScale, '92');
  assert.equal(sizeValue.textContent, '92%');
  assert.equal(dom.store['obs-bible:media:ui-scale'], '92');
  assert.equal(dom.store['obs-bible:cameras:ui-scale'], '105');

  // Verify toolbar components
  const toolbar = mainApp.children.find(c => c.className === 'toolbar');
  assert.ok(toolbar, 'toolbar must be appended');

  const searchInput = toolbar.children.find(c => c.className === 'search-input');
  assert.ok(searchInput, 'search-input must exist inside toolbar');

  const clearAllBtn = toolbar.children.find(c => c.className === 'quiet clear-btn');
  assert.ok(clearAllBtn, 'clear-btn must exist inside toolbar');

  // Verify actionbar footer
  const footer = mainApp.children.find(c => c.className === 'actionbar');
  assert.ok(footer, 'actionbar must be appended');

  const transitionsBtn = footer.children.find(c => c.className === 'quiet settings-toggle-btn');
  assert.ok(transitionsBtn, 'transitions settings button must exist in actionbar');

  // Verify transitions settings popover
  const popover = mainApp.children.find(c => c.className === 'settings-popover hidden');
  assert.ok(popover, 'settings-popover must exist and start hidden');
});
