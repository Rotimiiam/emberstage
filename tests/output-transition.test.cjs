'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function fixture(reduced = false) {
  const running = [];
  const classes = () => {
    const values = new Set();
    return { add: (...keys) => keys.forEach(key => values.add(key)), remove: (...keys) => keys.forEach(key => values.delete(key)), contains: key => values.has(key), toggle: (key, on) => on ? values.add(key) : values.delete(key) };
  };
  function element(name) {
    return {
      name, style: {}, classList: classes(), children: [],
      setAttribute() {},
      replaceChildren(...children) { this.children = children; },
      append(child) { this.children.push(child); },
      prepend(child) { this.children.unshift(child); },
      animate(frames, timing) {
        let finish, reject;
        const finished = new Promise((resolve, fail) => { finish = resolve; reject = fail; });
        const animation = { frames, timing, finished, finish, cancel: () => reject(new Error('cancelled')) };
        running.push(animation);
        return animation;
      }
    };
  }
  const output = element('output');
  output.ownerDocument = { createElement: element };
  const context = vm.createContext({ matchMedia: () => ({ matches: reduced }) });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js/outputs/output-transition.js'), 'utf8'), context);
  return { output, element, running, transition: context.EmberstageTransition.create(output) };
}

test('cut commits immediately, fits content and hide clears it', async () => {
  const f = fixture(); const image = f.element('one');
  assert.equal(await f.transition.show(image, { type: 'cut', fit: 'cover' }), true);
  assert.deepEqual(f.output.children, [image]);
  assert.equal(image.style.objectFit, 'cover');
  assert.equal(f.running.length, 0);
  f.transition.hide();
  assert.deepEqual(f.output.children, []);
  assert.equal(f.output.classList.contains('visible'), false);
});

test('crossfade retains old content until both animations finish', async () => {
  const f = fixture(); const old = f.element('old'); const next = f.element('next');
  await f.transition.show(old);
  const pending = f.transition.show(next, { type: 'fade', duration: 500 });
  assert.deepEqual(f.output.children, [old, next]);
  assert.equal(f.running.length, 2);
  assert.equal(f.running[0].timing.duration, 500);
  f.running.forEach(animation => animation.finish());
  assert.equal(await pending, true);
  assert.deepEqual(f.output.children, [next]);
});

test('dip uses a black backing and a fully black midpoint', async () => {
  const f = fixture(); await f.transition.show(f.element('old'));
  const next = f.element('next');
  const pending = f.transition.show(next, { type: 'dip', duration: 150 });
  assert.equal(f.output.children[0].className, 'output-blackout');
  assert.equal(f.running[0].frames[1].opacity, 0);
  assert.equal(f.running[1].frames[1].opacity, 0);
  f.running.forEach(animation => animation.finish());
  assert.equal(await pending, true);
  assert.deepEqual(f.output.children, [next]);
});

test('hide during fade cancels candidate and never resurrects output', async () => {
  const f = fixture(); await f.transition.show(f.element('old'));
  const pending = f.transition.show(f.element('next'), { type: 'fade' });
  f.transition.hide();
  assert.equal(await pending, false);
  assert.equal(f.output.children.length, 0);
});

test('rapid take cancels earlier transition and commits only newest content', async () => {
  const f = fixture(); const old = f.element('old'); await f.transition.show(old);
  const first = f.transition.show(f.element('superseded'), { type: 'fade' });
  const newest = f.element('newest');
  const second = f.transition.show(newest, { type: 'fade', duration: 9999 });
  assert.deepEqual(f.output.children, [old, newest]);
  assert.equal(await first, false);
  f.running.slice(2).forEach(animation => animation.finish());
  assert.equal(await second, true);
  assert.deepEqual(f.output.children, [newest]);
  assert.equal(f.running[2].timing.duration, 300);
});

test('reduced motion and older browsers use a safe immediate cut', async () => {
  const reduced = fixture(true); const image = reduced.element('image');
  assert.equal(await reduced.transition.show(image, { type: 'fade' }), true);
  assert.equal(reduced.running.length, 0);
  const old = fixture(); const video = old.element('video'); delete video.animate;
  assert.equal(await old.transition.show(video, { type: 'dip' }), true);
  assert.deepEqual(old.output.children, [video]);
});

test('animated hide fades out previous element and clears only after finish', async () => {
  const f = fixture(); const image = f.element('image');
  await f.transition.show(image);
  const pending = f.transition.hide({ type: 'fade', duration: 300 });
  assert.deepEqual(f.output.children, [image]);
  assert.equal(f.running.length, 1);
  assert.equal(f.running[0].timing.duration, 300);
  f.running[0].finish();
  assert.equal(await pending, true);
  assert.deepEqual(f.output.children, []);
});

test('hide cancellation by subsequent show cancels hide transition', async () => {
  const f = fixture(); const image = f.element('image');
  await f.transition.show(image);
  const pendingHide = f.transition.hide({ type: 'fade', duration: 300 });
  const next = f.element('next');
  const pendingShow = f.transition.show(next, { type: 'fade', duration: 150 });
  assert.equal(await pendingHide, false);
  f.running.forEach(anim => { try { anim.finish(); } catch (_) {} });
  assert.equal(await pendingShow, true);
  assert.deepEqual(f.output.children, [next]);
});

test('destroy or synchronous clear cancels animations and leaves no leaks or children', async () => {
  const f = fixture(); const image = f.element('image');
  await f.transition.show(image);
  f.transition.hide({ type: 'fade', duration: 300 });
  assert.equal(f.running.length, 1);
  f.transition.destroy();
  assert.deepEqual(f.output.children, []);
  assert.equal(f.output.classList.contains('visible'), false);
});

function mediaOutputFixture(reduced = false) {
  const mediaMessages = [];
  const stageMessages = [];
  let mediaOnMessage = null;
  let stageOnMessage = null;
  let pagehideListener = null;

  const mockMediaChannel = {
    postMessage: (msg) => mediaMessages.push(msg),
    close: () => {}
  };
  const mockStageChannel = {
    postMessage: (msg) => stageMessages.push(msg),
    close: () => {}
  };

  const createdElements = [];

  const mockOutput = {
    style: {
      setProperty(name, val) { this[name] = val; },
      removeProperty(name) { delete this[name]; }
    },
    classList: {
      values: new Set(),
      add(...keys) { keys.forEach(k => this.values.add(k)); },
      remove(...keys) { keys.forEach(k => this.values.delete(k)); },
      contains(k) { return this.values.has(k); }
    },
    replaceChildren(...children) { this.children = children; },
    children: [],
    querySelectorAll(selector) {
      if (selector === '.output-layer, .output-blackout') {
        return createdElements;
      }
      return [];
    },
    append(child) { this.children.push(child); }
  };

  const doc = {
    getElementById: (id) => id === 'output' ? mockOutput : null,
    createElement: (tag) => {
      const el = {
        tagName: tag.toUpperCase(),
        style: {},
        classList: {
          values: new Set(),
          add(...keys) { keys.forEach(k => this.values.add(k)); },
          remove(...keys) { keys.forEach(k => this.values.delete(k)); },
          contains(k) { return this.values.has(k); }
        },
        setAttribute() {},
        addEventListener(event, handler) {
          if (event === 'canplay' || event === 'load') {
            this.readyHandler = handler;
          }
          if (event === 'error') {
            this.errorHandler = handler;
          }
        },
        removeEventListener() {},
        play() { return Promise.resolve(); },
        pause() {},
        load() {},
        removeAttribute() {},
        remove() {
          const idx = createdElements.indexOf(this);
          if (idx !== -1) createdElements.splice(idx, 1);
        },
        animate(frames, timing) {
          this.animateCalled = true;
          this.animateFrames = frames;
          this.animateTiming = timing;
          let finish;
          const finished = new Promise(resolve => { finish = resolve; });
          return { finished, finish, cancel() {} };
        }
      };
      createdElements.push(el);
      return el;
    }
  };

  const mockTransition = {
    show: (el, opts) => {
      el.style.objectFit = opts.fit;
      mockOutput.replaceChildren(el);
      return Promise.resolve(true);
    },
    hide: (opts) => {
      mockOutput.replaceChildren();
      return Promise.resolve(true);
    },
    cancel: () => {},
    destroy: () => {}
  };

  const context = vm.createContext({
    console,
    document: doc,
    BroadcastChannel: function(name) {
      if (name === 'emberstage-media-v1') {
        return {
          set onmessage(fn) { mediaOnMessage = fn; },
          get onmessage() { return mediaOnMessage; },
          postMessage: mockMediaChannel.postMessage,
          close() {}
        };
      }
      if (name === 'emberstage-visual-v1') {
        return {
          set onmessage(fn) { stageOnMessage = fn; },
          get onmessage() { return stageOnMessage; },
          postMessage: mockStageChannel.postMessage,
          close() {}
        };
      }
    },
    EmberstageTransition: {
      create: () => mockTransition
    },
    URL: {
      createObjectURL: () => 'blob:mock',
      revokeObjectURL: () => {}
    },
    Blob: Blob,
    setTimeout: () => 1,
    clearTimeout: () => {},
    setInterval: () => {},
    clearInterval: () => {},
    addEventListener: (event, handler) => {
      if (event === 'pagehide') pagehideListener = handler;
    },
    matchMedia: () => ({ matches: reduced })
  });
  context.window = context;

  vm.runInContext('function makeVMBlob() { return new Blob([]); }', context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js/outputs/layout-helper.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../assets/js/outputs/media-output.js'), 'utf8'), context);

  return {
    context,
    mediaMessages,
    stageMessages,
    mockOutput,
    mockTransition,
    createdElements,
    triggerMedia: (msg) => {
      console.log('triggerMedia called with msg type:', msg.type);
      console.log('mediaOnMessage function is:', mediaOnMessage ? 'DEFINED' : 'UNDEFINED');
      return mediaOnMessage({ data: msg });
    },
    triggerStage: (msg) => stageOnMessage({ data: msg }),
    triggerPagehide: () => pagehideListener()
  };
}

test('media Fit and Fill apply to images and videos without replacing live media', async () => {
  for (const kind of ['image', 'video']) {
    const f = mediaOutputFixture();
    f.triggerMedia({ version: 1, type: 'show', id: kind, kind,
      blob: f.context.makeVMBlob(), fit: 'contain', transition: 'cut' });
    const element = f.createdElements[0];
    element.readyHandler();
    await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(element.style.objectFit, 'contain');
    for (const fit of ['cover', 'contain']) {
      f.triggerMedia({ version: 1, type: 'update-settings', fit, muted: true, loop: true });
      assert.equal(element.style.objectFit, fit);
      assert.equal(f.mockOutput.children[0], element);
    }
  }
});

test('media-output video layout Apply runs WAAPI style geometry animations', async () => {
  const f = mediaOutputFixture();
  f.triggerStage({ version: 1, output: 'camera', action: 'status', state: 'live' });
  
  f.triggerMedia({
    version: 1,
    type: 'show',
    id: 'video-1',
    kind: 'video',
    blob: f.context.makeVMBlob(),
    layout: { preset: 'camera-inset', corner: 'bottom-right' }
  });
  
  const videoElement = f.createdElements[0];
  assert.ok(videoElement);
  videoElement.readyHandler();
  await new Promise(resolve => setTimeout(resolve, 10));
  
  f.triggerMedia({
    version: 1,
    type: 'apply-layout',
    id: 'video-1',
    layout: { preset: 'split-left', corner: 'bottom-right' },
    transition: 'fade',
    duration: 300
  });
  
  assert.ok(videoElement.animateCalled);
  assert.equal(videoElement.animateTiming.duration, 300);
});

test('media-output show-hide-show rapid actions preserve only the newest video', async () => {
  const f = mediaOutputFixture();
  
  f.triggerMedia({
    version: 1, type: 'show', id: 'video-1', kind: 'video', blob: f.context.makeVMBlob()
  });
  
  f.triggerMedia({
    version: 1, type: 'hide', transition: 'fade', duration: 300
  });
  
  f.triggerMedia({
    version: 1, type: 'show', id: 'video-2', kind: 'video', blob: f.context.makeVMBlob()
  });
  
  const video2 = f.createdElements.find(el => el.src === 'blob:mock');
  assert.ok(video2);
  video2.readyHandler();
  await new Promise(resolve => setTimeout(resolve, 10));
  
  assert.ok(f.mediaMessages.some(m => m.type === 'status' && m.id === 'video-2' && m.state === 'live'));
});

test('media-output failed video replacement retains old video and geometry', async () => {
  const f = mediaOutputFixture();
  f.triggerStage({ version: 1, output: 'camera', action: 'status', state: 'live' });
  
  f.triggerMedia({
    version: 1, type: 'show', id: 'video-1', kind: 'video', blob: f.context.makeVMBlob(), layout: { preset: 'split-right' }
  });
  f.createdElements[0].readyHandler();
  await new Promise(resolve => setTimeout(resolve, 10));
  
  f.triggerMedia({
    version: 1, type: 'show', id: 'video-2', kind: 'video', blob: f.context.makeVMBlob(), layout: { preset: 'camera-inset' }
  });
  
  const el = f.createdElements.find(el => el !== f.createdElements[0]);
  assert.ok(el);
  el.errorHandler();
  await new Promise(resolve => setTimeout(resolve, 10));
  
  assert.equal(f.mockOutput.children[0].tagName, 'VIDEO');
  assert.equal(f.mockOutput.style['--layout-width'], '50%');
});

test('media-output cut/reduced motion hide clears layout immediately with no stale state', async () => {
  const f = mediaOutputFixture(true);
  
  f.triggerMedia({
    version: 1, type: 'show', id: 'video-1', kind: 'video', blob: f.context.makeVMBlob()
  });
  f.createdElements[0].readyHandler();
  await new Promise(resolve => setTimeout(resolve, 10));
  
  f.triggerMedia({
    version: 1, type: 'hide', transition: 'fade'
  });
  await new Promise(resolve => setTimeout(resolve, 10));
  
  assert.equal(f.createdElements.length, 0);
  assert.equal(f.mockOutput.style['--layout-left'], undefined);
});

const settleMedia = () => new Promise(resolve => setImmediate(resolve));
async function showMedia(f, id, layout = 'full') {
  f.triggerMedia({ version: 1, type: 'show', id, kind: 'video', muted: false,
    blob: f.context.makeVMBlob(), layout: { preset: layout }, transition: 'cut' });
  const video = f.createdElements.at(-1);
  video.readyHandler();
  await settleMedia();
  return video;
}

test('camera activation immediately supplies composite media geometry without waiting for heartbeat', async () => {
  const f = mediaOutputFixture();
  f.triggerStage({ version: 1, output: 'camera', action: 'active' });
  await showMedia(f, 'clip', 'split-left');
  assert.equal(f.mockOutput.style['--layout-width'], '50%');
  assert.equal(f.mediaMessages.at(-2).cameraAbsent, false);
});

test('settings, layout and transport cannot revive or unmute a fading-out video', async () => {
  const f = mediaOutputFixture();
  const video = await showMedia(f, 'clip');
  let finishHide;
  f.mockTransition.hide = () => new Promise(resolve => { finishHide = resolve; });
  f.triggerMedia({ version: 1, type: 'hide', transition: 'fade', duration: 300 });
  const stageCount = f.stageMessages.length;
  f.triggerMedia({ version: 1, type: 'update-settings', muted: false, loop: true, fit: 'cover' });
  assert.equal(video.muted, true);
  f.triggerMedia({ version: 1, type: 'apply-layout', id: 'clip', layout: { preset: 'camera-inset' } });
  assert.equal(f.stageMessages.length, stageCount);
  let played = false;
  video.play = () => { played = true; return Promise.resolve(); };
  f.triggerMedia({ version: 1, type: 'transport', action: 'restart' });
  assert.equal(played, false);
  finishHide(true);
  await settleMedia();
  assert.equal(f.mediaMessages.at(-1).state, 'hidden');
});

test('failed replacement after superseding a transition restores committed media layout', async () => {
  const f = mediaOutputFixture();
  f.triggerStage({ version: 1, output: 'camera', action: 'status', state: 'live' });
  const original = await showMedia(f, 'original', 'split-left');
  let cancelShow;
  f.mockTransition.show = () => new Promise(resolve => { cancelShow = resolve; });
  f.mockTransition.cancel = () => cancelShow?.(false);
  await showMedia(f, 'superseded', 'camera-inset');
  f.triggerMedia({ version: 1, type: 'show', id: 'broken', kind: 'video',
    blob: f.context.makeVMBlob(), layout: { preset: 'full' } });
  f.createdElements.at(-1).errorHandler();
  await settleMedia();
  const status = f.mediaMessages.at(-1);
  assert.equal(status.id, 'original');
  assert.equal(status.layout.preset, 'split-left');
  assert.equal(f.mockOutput.children[0], original);
  assert.equal(f.mockOutput.style['--layout-width'], '50%');
});
