'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');

function getHelperContext() {
  const context = vm.createContext({});
  const scriptPath = path.join(__dirname, '../assets/js/outputs/layout-helper.js');
  const code = fs.readFileSync(scriptPath, 'utf8');
  vm.runInContext(code, context);
  return context.EmberstageLayoutHelper;
}

function clean(obj) {
  return JSON.parse(JSON.stringify(obj));
}

test('layout-helper returns correct geometry for all presets', () => {
  const helper = getHelperContext();
  
  // full
  const full = clean(helper.getLayoutGeometry('full', 'bottom-right'));
  assert.deepEqual(full.media, { left: 0, top: 0, width: 100, height: 100 });
  assert.deepEqual(full.camera, { left: 0, top: 0, width: 100, height: 100 });
  
  // split-left
  const splitLeft = clean(helper.getLayoutGeometry('split-left', 'bottom-right'));
  assert.deepEqual(splitLeft.media, { left: 0, top: 0, width: 50, height: 100 });
  assert.deepEqual(splitLeft.camera, { left: 50, top: 0, width: 50, height: 100 });
  
  // split-right
  const splitRight = clean(helper.getLayoutGeometry('split-right', 'bottom-right'));
  assert.deepEqual(splitRight.media, { left: 50, top: 0, width: 50, height: 100 });
  assert.deepEqual(splitRight.camera, { left: 0, top: 0, width: 50, height: 100 });
  
  // camera-inset top-left
  const insetTL = clean(helper.getLayoutGeometry('camera-inset', 'top-left'));
  assert.deepEqual(insetTL.media, { left: 0, top: 0, width: 100, height: 100 });
  assert.deepEqual(insetTL.camera, { left: 2, top: 2, width: 30, height: 30 });

  // camera-inset top-right
  const insetTR = clean(helper.getLayoutGeometry('camera-inset', 'top-right'));
  assert.deepEqual(insetTR.camera, { left: 68, top: 2, width: 30, height: 30 });

  // camera-inset bottom-left
  const insetBL = clean(helper.getLayoutGeometry('camera-inset', 'bottom-left'));
  assert.deepEqual(insetBL.camera, { left: 2, top: 68, width: 30, height: 30 });

  // camera-inset bottom-right
  const insetBR = clean(helper.getLayoutGeometry('camera-inset', 'bottom-right'));
  assert.deepEqual(insetBR.camera, { left: 68, top: 68, width: 30, height: 30 });
});

test('layout-helper returns correct clip paths for camera', () => {
  const helper = getHelperContext();
  
  assert.equal(helper.getCameraClipPath('full', 'bottom-right'), '');
  assert.equal(helper.getCameraClipPath('split-left', 'bottom-right'), 'polygon(50% 0%, 100% 0%, 100% 100%, 50% 100%)');
  assert.equal(helper.getCameraClipPath('split-right', 'bottom-right'), 'polygon(0% 0%, 50% 0%, 50% 100%, 0% 100%)');
  assert.equal(helper.getCameraClipPath('camera-inset', 'top-left'), 'polygon(2% 2%, 32% 2%, 32% 32%, 2% 32%)');
});

test('layout-helper returns correct clip paths for media', () => {
  const helper = getHelperContext();
  
  assert.equal(helper.getMediaClipPath('full', 'bottom-right', true), '');
  assert.equal(helper.getMediaClipPath('split-left', 'bottom-right', true), 'polygon(0% 0%, 50% 0%, 50% 100%, 0% 100%)');
  assert.equal(helper.getMediaClipPath('split-right', 'bottom-right', true), 'polygon(50% 0%, 100% 0%, 100% 100%, 50% 100%)');
  
  const expectedHoleBR = 'polygon(evenodd, 0% 0%, 0% 100%, 100% 100%, 100% 0%, 0% 0%, 68% 68%, 98% 68%, 98% 98%, 68% 98%, 68% 68%)';
  assert.equal(helper.getMediaClipPath('camera-inset', 'bottom-right', true), expectedHoleBR);
});
