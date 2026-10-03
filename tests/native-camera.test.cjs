'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Dynamically load the actual LayoutHelper into global context so core can access it
const layoutHelperCode = fs.readFileSync(path.join(__dirname, '../assets/js/outputs/layout-helper.js'), 'utf8');
vm.runInThisContext(layoutHelperCode);

// Require the core module
const EmberstageNativeCamera = require('../assets/js/media/native-camera-core.js');

class MockOBSClient {
  constructor() {
    this.ready = true;
    this.requestsLog = [];
    this.listeners = new Map();

    // Standard valid OBS mock state matching the real protocol
    this.state = {
      currentSceneCollection: 'Emberstage Collection',
      transforms: {},
      scenes: [
        { sceneName: 'Emberstage Program', sceneUuid: 'program-uuid-1' },
        { sceneName: 'Emberstage Camera A', sceneUuid: 'camera-a-uuid-1' },
        { sceneName: 'Emberstage Camera B', sceneUuid: 'camera-b-uuid-1' }
      ],
      programItems: [
        { sourceName: 'Emberstage Camera A', sourceUuid: 'camera-a-uuid-1', sceneItemId: 101, sceneItemIndex: 1 },
        { sourceName: 'Emberstage Camera B', sourceUuid: 'camera-b-uuid-1', sceneItemId: 102, sceneItemIndex: 2 },
        { sourceName: 'Emberstage Graphics', sourceUuid: 'graphics-uuid-1', sceneItemId: 103, sceneItemIndex: 3 }
      ],
      graphicsSettings: {
        inputKind: 'browser_source',
        inputSettings: {
          url: 'http://localhost:3000/assets/outputs/emberstage_output.html'
        }
      },
      videoSettings: {
        baseWidth: 1920,
        baseHeight: 1080
      },
      inputs: [
        { inputName: 'FaceTime HD Camera', inputUuid: 'input-facetime', inputKind: 'av_capture_input_v2' },
        { inputName: 'Logitech Webcam', inputUuid: 'input-logitech', inputKind: 'dshow_input' },
        { inputName: 'Color Source', inputUuid: 'input-color', inputKind: 'color_source_v2' }
      ],
      filters: {
        'camera-a-uuid-1': {
          'Emberstage Opacity': {
            filterKind: 'color_filter_v2',
            filterEnabled: true,
            filterSettings: { opacity: 1.0 }
          }
        },
        'camera-b-uuid-1': {
          'Emberstage Opacity': {
            filterKind: 'color_filter_v2',
            filterEnabled: true,
            filterSettings: { opacity: 0.0 }
          }
        }
      },
      slotItems: {
        'camera-a-uuid-1': [
          { sourceUuid: 'input-logitech', sceneItemId: 501 }
        ],
        'camera-b-uuid-1': []
      },
      enabledItems: {
        // sceneUuid + '#' + sceneItemId
        'program-uuid-1#101': true,  // slot A is enabled in program
        'program-uuid-1#102': false, // slot B is disabled
        'camera-a-uuid-1#501': true
      },
      availableRequests: [
        'GetSceneCollectionList',
        'GetSceneList',
        'GetSceneItemList',
        'GetInputSettings',
        'GetInputList',
        'GetVideoSettings',
        'GetSourceFilter',
        'SetSourceFilterSettings',
        'CreateSceneItem',
        'RemoveSceneItem',
        'SetSceneItemEnabled',
        'SetSceneItemTransform',
        'GetSourceScreenshot',
        'GetVersion'
      ]
    };

    // For injecting custom failures per RPC
    this.failures = {};
  }

  on(type, handler) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(handler);
    return () => this.listeners.get(type)?.delete(handler);
  }

  emit(type, data) {
    for (const handler of this.listeners.get(type) || []) {
      handler(data);
    }
  }

  async request(type, requestData = {}) {
    this.requestsLog.push({ type, requestData });

    if (this.failures[type]) {
      throw new Error(`Mock injected failure for ${type}`);
    }

    if (!this.ready) {
      throw new Error('Connect to OBS first.');
    }

    switch (type) {
      case 'GetVersion':
        return { availableRequests: this.state.availableRequests };

      case 'GetSceneCollectionList':
        return { currentSceneCollectionName: this.state.currentSceneCollection };

      case 'GetSceneList':
        return { scenes: this.state.scenes };

      case 'GetSceneItemList': {
        const uuid = requestData.sceneUuid;
        if (uuid === 'program-uuid-1') {
          return { sceneItems: this.state.programItems };
        }
        if (this.state.slotItems[uuid]) {
          return { sceneItems: this.state.slotItems[uuid] };
        }
        return { sceneItems: [] };
      }

      case 'GetInputSettings': {
        if (requestData.inputUuid === 'graphics-uuid-1') {
          return this.state.graphicsSettings;
        }
        throw new Error('Input not found');
      }

      case 'GetVideoSettings':
        return this.state.videoSettings;

      case 'GetInputList':
        return { inputs: this.state.inputs };

      case 'GetSourceFilter': {
        const filters = this.state.filters[requestData.sourceUuid];
        if (filters && filters[requestData.filterName]) {
          return filters[requestData.filterName];
        }
        throw new Error('Filter not found');
      }

      case 'SetSourceFilterSettings': {
        const filters = this.state.filters[requestData.sourceUuid] || {};
        const existing = filters[requestData.filterName] || { filterType: 'color_filter_v2', filterEnabled: true };
        existing.filterSettings = requestData.filterSettings;
        filters[requestData.filterName] = existing;
        this.state.filters[requestData.sourceUuid] = filters;
        return {};
      }

      case 'CreateSceneItem': {
        const uuid = requestData.sceneUuid;
        const srcUuid = requestData.sourceUuid;
        const itemId = Math.floor(Math.random() * 1000) + 1000;
        const item = { sourceUuid: srcUuid, sceneItemId: itemId };
        if (!this.state.slotItems[uuid]) {
          this.state.slotItems[uuid] = [];
        }
        this.state.slotItems[uuid].push(item);
        this.state.enabledItems[`${uuid}#${itemId}`] = !!requestData.sceneItemEnabled;
        return { sceneItemId: itemId };
      }

      case 'RemoveSceneItem': {
        const uuid = requestData.sceneUuid;
        const itemId = requestData.sceneItemId;
        if (this.state.slotItems[uuid]) {
          this.state.slotItems[uuid] = this.state.slotItems[uuid].filter((it) => it.sceneItemId !== itemId);
        }
        delete this.state.enabledItems[`${uuid}#${itemId}`];
        return {};
      }

      case 'GetSceneItemEnabled': {
        const key = `${requestData.sceneUuid}#${requestData.sceneItemId}`;
        return { sceneItemEnabled: !!this.state.enabledItems[key] };
      }

      case 'SetSceneItemEnabled': {
        const key = `${requestData.sceneUuid}#${requestData.sceneItemId}`;
        this.state.enabledItems[key] = !!requestData.sceneItemEnabled;
        return {};
      }

      case 'SetSceneItemTransform': {
        const key = `${requestData.sceneUuid}#${requestData.sceneItemId}`;
        this.state.transforms[key] = {
          ...this.state.transforms[key],
          ...requestData.sceneItemTransform
        };
        return {};
      }

      case 'GetSceneItemTransform': {
        const key = `${requestData.sceneUuid}#${requestData.sceneItemId}`;
        const stored = this.state.transforms[key] || {};
        return {
          sceneItemTransform: {
            positionX: 0,
            positionY: 0,
            scaleX: 1.0,
            scaleY: 1.0,
            boundsType: 'OBS_BOUNDS_NONE',
            boundsWidth: 1920,
            boundsHeight: 1080,
            cropTop: 0,
            cropBottom: 0,
            cropLeft: 0,
            cropRight: 0,
            cropToBounds: true,
            alignment: 5,
            ...stored
          }
        };
      }

      case 'SetSceneItemIndex': {
        const uuid = requestData.sceneUuid;
        const itemId = requestData.sceneItemId;
        const targetIdx = requestData.sceneItemIndex;
        let items = [];
        if (uuid === 'program-uuid-1') {
          items = this.state.programItems;
        } else if (this.state.slotItems[uuid]) {
          items = this.state.slotItems[uuid];
        }
        const item = items.find((it) => it.sceneItemId === itemId);
        if (item) {
          const oldIdx = item.sceneItemIndex;
          item.sceneItemIndex = targetIdx;
          for (const other of items) {
            if (other.sceneItemId !== itemId) {
              if (oldIdx < targetIdx) {
                if (other.sceneItemIndex > oldIdx && other.sceneItemIndex <= targetIdx) {
                  other.sceneItemIndex--;
                }
              } else if (oldIdx > targetIdx) {
                if (other.sceneItemIndex >= targetIdx && other.sceneItemIndex < oldIdx) {
                  other.sceneItemIndex++;
                }
              }
            }
          }
        }
        return {};
      }

      case 'GetSourceScreenshot':
        return { imageData: 'data:image/png;base64,mockPngData' };

      default:
        throw new Error(`Unsupported mock request ${type}`);
    }
  }
}

const validBinding = {
  version: 1,
  collection: 'Emberstage Collection',
  program: { name: 'Emberstage Program', uuid: 'program-uuid-1' },
  slots: [
    { name: 'Emberstage Camera A', uuid: 'camera-a-uuid-1' },
    { name: 'Emberstage Camera B', uuid: 'camera-b-uuid-1' }
  ],
  graphics: { name: 'Emberstage Graphics', uuid: 'graphics-uuid-1' }
};

test('initialize structure validation and async execution', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);

  assert.equal(camera.initialized, false);

  // Throws on distinct slots check
  await assert.rejects(async () => {
    await camera.initialize({
      version: 1,
      collection: 'Emberstage Collection',
      program: { name: 'Emberstage Program', uuid: 'program-uuid-1' },
      slots: [
        { name: 'Emberstage Camera A', uuid: 'same-uuid' },
        { name: 'Emberstage Camera B', uuid: 'same-uuid' }
      ],
      graphics: { name: 'Emberstage Graphics', uuid: 'graphics-uuid-1' }
    });
  });

  // Succeeds and runs refresh directly
  await camera.initialize(validBinding);
  assert.equal(camera.initialized, true);
  assert.equal(camera.verified, true);
  assert.equal(camera.activeSlotIndex, 0);
  assert.equal(camera.activeInputUuid, 'input-logitech');
});

test('Discovery accepts every input kind without enabling sources or including owned containers', async () => {
  const client = new MockOBSClient();
  client.state.inputs.push(
    { inputName: 'iruin', inputUuid: 'input-iruin', inputKind: 'macos-avcapture' },
    { inputName: 'Video Capture Device', inputUuid: 'input-modern', inputKind: 'macos-avcapture_v2' },
    { inputName: 'Microphone', inputUuid: 'input-mic', inputKind: 'coreaudio_input_capture' },
    { inputName: 'NDI', inputUuid: 'input-ndi', inputKind: 'ndi_source' },
    { inputName: 'Network media', inputUuid: 'input-media', inputKind: 'ffmpeg_source' },
    { inputName: 'Browser', inputUuid: 'input-browser', inputKind: 'browser_source' },
    { inputName: 'Unknown plugin', inputUuid: 'input-plugin', inputKind: 'future_plugin' },
    { inputName: 'Graphics', inputUuid: 'graphics-uuid-1', inputKind: 'browser_source' },
    { inputName: 'Program', inputUuid: 'program-uuid-1', inputKind: 'scene' },
    { inputName: 'Slot', inputUuid: 'camera-a-uuid-1', inputKind: 'scene' },
    { inputName: 'Other scene', inputUuid: 'other-scene', inputKind: 'scene' },
    { inputName: 'Group', inputUuid: 'group', inputKind: 'group' }
  );
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);
  assert.deepEqual(camera.inputs.map(input => input.inputUuid), [
    'input-facetime', 'input-logitech', 'input-color', 'input-iruin', 'input-modern',
    'input-mic', 'input-ndi', 'input-media', 'input-browser', 'input-plugin'
  ]);
  assert.ok(client.requestsLog.every(request => request.type.startsWith('Get')));
  for (const input of ['input-browser', 'input-plugin', 'input-media', 'input-mic']) {
    await camera.take(input, { transition: 'cut' });
    assert.equal(camera.activeInputUuid, input);
  }
  for (const input of ['graphics-uuid-1', 'program-uuid-1', 'camera-a-uuid-1', 'other-scene', 'group']) {
    await assert.rejects(camera.take(input, { transition: 'cut' }));
  }
});

test('Critical failures throw instead of swallowing (fail closed)', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. GetVersion failure
  client.failures['GetVersion'] = true;
  await assert.rejects(async () => {
    await camera.refresh();
  });
  delete client.failures['GetVersion'];

  // 2. GetVideoSettings failure
  client.failures['GetVideoSettings'] = true;
  await assert.rejects(async () => {
    await camera.refresh();
  });
  delete client.failures['GetVideoSettings'];

  // 3. Filter missing/disabled / Wrong opacity
  client.state.filters['camera-a-uuid-1']['Emberstage Opacity'].filterEnabled = false;
  await assert.rejects(async () => {
    await camera.refresh();
  });
  client.state.filters['camera-a-uuid-1']['Emberstage Opacity'].filterEnabled = true;

  client.state.filters['camera-a-uuid-1']['Emberstage Opacity'].filterKind = 'some_other_filter';
  await assert.rejects(async () => {
    await camera.refresh();
  });
  client.state.filters['camera-a-uuid-1']['Emberstage Opacity'].filterKind = 'color_filter_v2';

  client.state.filters['camera-a-uuid-1']['Emberstage Opacity'].filterSettings.opacity = Infinity;
  await assert.rejects(async () => {
    await camera.refresh();
  });
  client.state.filters['camera-a-uuid-1']['Emberstage Opacity'].filterSettings.opacity = 1.0;
});

test('Physical layout index & order validation', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Reordered graphics: index of graphics is lower than cameras
  client.state.programItems[2].sceneItemIndex = 0; // Graphics is at bottom now
  await assert.rejects(async () => {
    await camera.refresh();
  });

  // Restore
  client.state.programItems[2].sceneItemIndex = 3;
  await camera.refresh();
  assert.equal(camera.verified, true);
});

test('Extra slot item protection', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Inject extra item into Slot A
  client.state.slotItems['camera-a-uuid-1'].push({ sourceUuid: 'another-input', sceneItemId: 999 });

  await assert.rejects(async () => {
    await camera.refresh();
  });
});

test('Fresh Take input check and sensible inputs mapping', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // All user inputs are available, including non-camera sources.
  assert.equal(camera.inputs.length, 3);
  assert.equal(camera.allInputs.length, 3);
  assert.ok(camera.allInputs.some((i) => i.inputUuid === 'input-color'));

  // Delete logitech before Take
  client.state.inputs = client.state.inputs.filter((i) => i.inputUuid !== 'input-logitech');

  await assert.rejects(async () => {
    await camera.take('input-logitech');
  });
});

test('Duration boundaries and invalid checks', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Throws on NaN/Infinity
  await assert.rejects(async () => {
    await camera.take('input-facetime', { duration: NaN });
  });
  await assert.rejects(async () => {
    await camera.take('input-facetime', { duration: Infinity });
  });

  // Auto bounding [150, 300, 500]
  client.requestsLog = [];
  await camera.take('input-facetime', { transition: 'fade', duration: 10 });
  // Duration should be bounded to 150.
  // We can't inspect the duration directly, but we can verify it succeeded.
  assert.equal(camera.activeInputUuid, 'input-facetime');
});

test('RPC failure rollback preserves old live and removes ONLY exact created item', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Inactive slot is Camera B (index 1)
  assert.equal(camera.activeSlotIndex, 0);
  assert.equal(camera.live, true);

  // Let's inject failure on SetSceneItemEnabled during Take
  client.failures['SetSceneItemEnabled'] = true;

  const preItemsCount = client.state.slotItems['camera-b-uuid-1'].length;

  await assert.rejects(async () => {
    await camera.take('input-facetime');
  });

  // Verify rollback:
  // Old live state is preserved
  assert.equal(camera.live, true);
  assert.equal(camera.activeSlotIndex, 0);

  // Removed ONLY the exact created item from Camera B
  assert.equal(client.state.slotItems['camera-b-uuid-1'].length, preItemsCount);
});

test('Interleaved hide/layout checks and dispose during transition', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Start slow transition
  const takePromise = camera.take('input-facetime', { transition: 'fade', duration: 300 });

  // Try calling hide() or layout() during transition
  await assert.rejects(async () => {
    await camera.hide();
  });
  await assert.rejects(async () => {
    await camera.layout({ preset: 'split-left' });
  });

  // Try disposing during transition
  camera.dispose();
  assert.equal(camera.transitioning, false);
  assert.equal(camera.verified, false);
  assert.equal(camera.initialized, false);

  try {
    await takePromise;
  } catch (_) {
    // Take promise might throw or reject because we disposed, which is fine
  }
});

test('Intermediate hide opacity and geometry, and cut transition', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. Hide with fade: verify intermediate opacity is set
  client.requestsLog = [];
  await camera.hide({ transition: 'fade', duration: 200 });

  const filterSettingsRequests = client.requestsLog.filter(r => r.type === 'SetSourceFilterSettings' && r.requestData.filterName === 'Emberstage Opacity');
  assert.ok(filterSettingsRequests.length > 1, 'Should have multiple filter settings requests for animation');
  
  // Find intermediate opacities (neither 1.0 nor 0.0)
  const opacities = filterSettingsRequests.map(r => r.requestData.filterSettings.opacity);
  const intermediateOpacities = opacities.filter(o => o > 0.0 && o < 1.0);
  assert.ok(intermediateOpacities.length > 0, 'Should have intermediate opacities during fade hide');
  assert.equal(camera.live, false, 'Camera should be hidden');

  // Let's re-take the camera so we can test layout
  await camera.take('input-logitech', { transition: 'cut' });
  assert.equal(camera.live, true);

  // 2. Layout with fade: verify intermediate geometry is set
  // Start preset is 'full' (left=0, width=100) -> Target preset is 'camera-inset' with 'top-left' (left=2, width=30)
  client.requestsLog = [];
  await camera.layout({ preset: 'camera-inset', corner: 'top-left', transition: 'fade', duration: 200 });

  const transformRequests = client.requestsLog.filter(r => r.type === 'SetSceneItemTransform');
  assert.ok(transformRequests.length > 1, 'Should have multiple transform requests for layout animation');

  // Let's inspect positionX and boundsWidth in inner slot or outer slots
  // Canvas width is 1920. Outer slot translation: x ranges from 0 to 38.4.
  // Inner camera boundsWidth ranges from 1920 to 576.
  const positionXs = transformRequests
    .map(r => r.requestData.sceneItemTransform.positionX)
    .filter(x => x !== undefined);
  const boundsWidths = transformRequests
    .map(r => r.requestData.sceneItemTransform.boundsWidth)
    .filter(w => w !== undefined);

  const intermediateXs = positionXs.filter(x => x > 0 && x < 38.4);
  const intermediateWidths = boundsWidths.filter(w => w > 576 && w < 1920);

  assert.ok(intermediateXs.length > 0, 'Should have intermediate positionX during layout animation');
  assert.ok(intermediateWidths.length > 0, 'Should have intermediate boundsWidth during layout animation');

  // 3. Cut transition (no animation) for layout
  client.requestsLog = [];
  await camera.layout({ preset: 'split-left', transition: 'cut' });
  const cutTransformRequests = client.requestsLog.filter(r => r.type === 'SetSceneItemTransform');
  // For 'split-left', camera left is 50 -> positionX is 960.
  const finalX = cutTransformRequests.find(r => r.requestData.sceneItemTransform.positionX !== undefined).requestData.sceneItemTransform.positionX;
  assert.equal(finalX, 960);
  // There should be very few requests, all at final values (no intermediate values)
  const cutXs = cutTransformRequests
    .map(r => r.requestData.sceneItemTransform.positionX)
    .filter(x => x !== undefined);
  assert.ok(cutXs.every(x => x === 960 || x === 0), 'All positionXs should be final values');
});

test('Unchanged layout no animation', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Set to split-left first
  await camera.layout({ preset: 'split-left', transition: 'cut' });

  client.requestsLog = [];
  // Apply the same layout
  await camera.layout({ preset: 'split-left', transition: 'fade', duration: 200 });

  // If there was no animation, there should be exactly one step of requests (or very few) and they apply the layout instantly without looping.
  const transformRequests = client.requestsLog.filter(r => r.type === 'SetSceneItemTransform');
  // The layout helper slots would be set only once.
  // In a loop there would be many transforms. Here there should be 4 or less outer slot updates.
  assert.ok(transformRequests.length <= 4, 'Should not loop for unchanged layout');
});

test('Failure state and rollback for hide and layout', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. Hide failure and rollback
  client.failures['SetSourceFilterSettings'] = true;
  await assert.rejects(async () => {
    await camera.hide({ transition: 'fade', duration: 200 });
  });
  assert.equal(camera.live, true, 'Camera should remain live after hide failure');
  delete client.failures['SetSourceFilterSettings'];

  // Re-verify the camera
  await camera.refresh();

  // 2. Layout failure and rollback
  // Set starting layout
  await camera.layout({ preset: 'split-left', transition: 'cut' });
  assert.equal(camera.currentPreset, 'split-left');

  client.failures['SetSceneItemTransform'] = true;
  await assert.rejects(async () => {
    await camera.layout({ preset: 'camera-inset', transition: 'fade', duration: 200 });
  });
  // Should rollback currentPreset to 'split-left'
  assert.equal(camera.currentPreset, 'split-left');
  delete client.failures['SetSceneItemTransform'];
});

test('Dispose during transitions', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Start transition with long duration
  const hidePromise = camera.hide({ transition: 'fade', duration: 500 });

  // Dispose instantly
  camera.dispose();

  await assert.rejects(async () => {
    await hidePromise;
  });
  assert.equal(camera.transitioning, false);
  assert.equal(camera.initialized, false);
});

test('Dual-camera features: dual geometry, swaps, single return, hide, ownership refusal', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. Dual Geometry Validation
  client.requestsLog = [];
  await camera.takeDual('input-facetime', 'input-logitech', { fit: 'cover', transition: 'cut' });

  assert.equal(camera.dual, true, 'Should be in dual camera mode');
  assert.equal(camera.activeLeftUuid, 'input-facetime', 'Left camera should be FaceTime');
  assert.equal(camera.activeRightUuid, 'input-logitech', 'Right camera should be Logitech');
  assert.equal(camera.live, true, 'Camera should be live');

  // Verify geometry
  const slotATransforms = client.requestsLog.filter(
    r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.program.uuid && r.requestData.sceneItemId === 101
  );
  const slotBTransforms = client.requestsLog.filter(
    r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.program.uuid && r.requestData.sceneItemId === 102
  );

  assert.ok(slotATransforms.length > 0, 'Should update slot A transform');
  assert.ok(slotBTransforms.length > 0, 'Should update slot B transform');

  // Slot A outer transform should be at (0, 0)
  const slotATrans = slotATransforms[slotATransforms.length - 1].requestData.sceneItemTransform;
  assert.equal(slotATrans.positionX, 0);
  assert.equal(slotATrans.positionY, 0);

  // Slot B outer transform should be at (960, 0) since baseWidth is 1920
  const slotBTrans = slotBTransforms[slotBTransforms.length - 1].requestData.sceneItemTransform;
  assert.equal(slotBTrans.positionX, 960);
  assert.equal(slotBTrans.positionY, 0);

  // Inner item transforms should have boundsWidth 960 and boundsHeight 1080 (50% scale side by side)
  const innerATransforms = client.requestsLog.filter(
    r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.slots[0].uuid
  );
  const innerBTransforms = client.requestsLog.filter(
    r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.slots[1].uuid
  );
  assert.equal(innerATransforms[innerATransforms.length - 1].requestData.sceneItemTransform.boundsWidth, 960);
  assert.equal(innerATransforms[innerATransforms.length - 1].requestData.sceneItemTransform.boundsHeight, 1080);
  assert.equal(innerBTransforms[innerBTransforms.length - 1].requestData.sceneItemTransform.boundsWidth, 960);
  assert.equal(innerBTransforms[innerBTransforms.length - 1].requestData.sceneItemTransform.boundsHeight, 1080);

  // 2. Swaps & Return to Single
  client.requestsLog = [];
  await camera.take('input-facetime', { fit: 'cover', transition: 'cut' });
  assert.equal(camera.dual, false, 'Should exit dual camera mode after taking a single camera');
  assert.equal(camera.activeInputUuid, 'input-facetime', 'Active input should be FaceTime');
  assert.equal(camera.live, true);

  // 3. Hide after Dual
  await camera.takeDual('input-facetime', 'input-logitech', { fit: 'cover', transition: 'cut' });
  assert.equal(camera.dual, true);
  await camera.hide({ transition: 'cut' });
  assert.equal(camera.dual, false);
  assert.equal(camera.live, false);
   assert.equal(camera.activeInputUuid, null);

  // 4. Ownership Refusal / Invalid Input Uuids
  await assert.rejects(async () => {
    await camera.takeDual('input-facetime', 'non-existent-uuid');
  }, /is invalid or does not exist in OBS/);
});

test('Dual-camera robust features: transitions, layout event blocking, and failures with perfect rollback', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. takeDual with fade transition (should split transition duration and do fade-out if prior was live)
  // Transition to single camera first, make it live
  await camera.take('input-facetime', { transition: 'cut' });
  assert.equal(camera.live, true);
  assert.equal(camera.dual, false);

  client.requestsLog = [];
  // Take dual with fade transition
  await camera.takeDual('input-facetime', 'input-logitech', { transition: 'fade', duration: 200 });
  assert.equal(camera.dual, true);

  // 2. layout event should be ignored when dual is active
  client.requestsLog = [];
  await camera.layout({ preset: 'split-left', corner: 'top-left' });
  // Ensure we didn't send any SetSceneItemTransform requests from layout when dual was active
  const layoutTransforms = client.requestsLog.filter(r => r.type === 'SetSceneItemTransform');
  assert.equal(layoutTransforms.length, 0, 'Layout should not change transforms when dual is active');

  // 3. takeDual RPC failure recovery (rollback Slot A and Slot B items and program slots properties)
  // Save current dual state details
  const priorLeft = camera.activeLeftUuid;
  const priorRight = camera.activeRightUuid;

  // Let's force an RPC failure on SetSceneItemTransform for Slot B during the next takeDual
  client.failures['SetSceneItemTransform'] = true;
  await assert.rejects(async () => {
    await camera.takeDual('input-logitech', 'input-facetime', { transition: 'cut' });
  }, /Mock injected failure/);

  delete client.failures['SetSceneItemTransform'];
  camera.verified = true; // reset verification flag for test progression
  // Verify dual state is perfectly restored
  assert.equal(camera.dual, true, 'Dual flag should remain true after failed takeDual');
  assert.equal(camera.activeLeftUuid, priorLeft, 'Left camera should be restored to prior');
  assert.equal(camera.activeRightUuid, priorRight, 'Right camera should be restored to prior');

  // 4. Transition from dual to single with fade
  client.requestsLog = [];
  await camera.take('input-logitech', { transition: 'fade', duration: 200 });
  assert.equal(camera.dual, false, 'Should be single camera after take');
  assert.equal(camera.activeInputUuid, 'input-logitech');

  // 5. Transition from dual to single RPC failure rollback
  // First, let's enter dual again
  await camera.takeDual('input-facetime', 'input-logitech', { transition: 'cut' });
  assert.equal(camera.dual, true);

  // Force RPC failure during take() on SetSceneItemEnabled
  client.failures['SetSceneItemEnabled'] = true;
  await assert.rejects(async () => {
    await camera.take('input-facetime', { transition: 'cut' });
  }, /Mock injected failure/);

  delete client.failures['SetSceneItemEnabled'];
  camera.verified = true; // reset verification flag for test verification
  // Verify dual state is restored
  assert.equal(camera.dual, true, 'Should rollback to dual after failed take');
  assert.equal(camera.activeLeftUuid, 'input-facetime');
  assert.equal(camera.activeRightUuid, 'input-logitech');
});

test('Extended Dual-camera: Layout layout, corner, z-order, rollback, and fade sequence validation', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. Validation of invalid layout & corner
  await assert.rejects(async () => {
    await camera.takeDual('input-facetime', 'input-logitech', { layout: 'invalid-layout' });
  }, /Invalid layout/);

  await assert.rejects(async () => {
    await camera.takeDual('input-facetime', 'input-logitech', { layout: 'inset', corner: 'invalid-corner' });
  }, /Invalid corner/);

  // 2. Validation of Inset Layout geometry across all 4 corners
  const corners = ['bottom-right', 'top-left', 'top-right', 'bottom-left'];
  const expectedGeom = {
    'bottom-right': { x: 1305.6, y: 734.4 },
    'top-left': { x: 38.4, y: 21.6 },
    'top-right': { x: 1305.6, y: 21.6 },
    'bottom-left': { x: 38.4, y: 734.4 }
  };

  for (const corner of corners) {
    client.requestsLog = [];
    await camera.takeDual('input-facetime', 'input-logitech', { layout: 'inset', corner, transition: 'cut' });

    assert.equal(camera.dualLayout, 'inset');
    assert.equal(camera.dualCorner, corner);

    // Verify Slot A (Main full canvas) transform
    const slotATransform = client.requestsLog.find(
      r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.program.uuid && r.requestData.sceneItemId === 101
    ).requestData.sceneItemTransform;
    assert.equal(slotATransform.positionX, 0);
    assert.equal(slotATransform.positionY, 0);

    const innerATransform = client.requestsLog.find(
      r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.slots[0].uuid
    ).requestData.sceneItemTransform;
    assert.equal(innerATransform.boundsWidth, 1920);
    assert.equal(innerATransform.boundsHeight, 1080);

    // Verify Slot B (Inset matching camera-inset preset) transform
    const slotBTransform = client.requestsLog.find(
      r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.program.uuid && r.requestData.sceneItemId === 102
    ).requestData.sceneItemTransform;
    assert.equal(Math.abs(slotBTransform.positionX - expectedGeom[corner].x) < 0.1, true, `Corner ${corner} positionX mismatch`);
    assert.equal(Math.abs(slotBTransform.positionY - expectedGeom[corner].y) < 0.1, true, `Corner ${corner} positionY mismatch`);

    const innerBTransform = client.requestsLog.find(
      r => r.type === 'SetSceneItemTransform' && r.requestData.sceneUuid === validBinding.slots[1].uuid
    ).requestData.sceneItemTransform;
    assert.equal(innerBTransform.boundsWidth, 576);
    assert.equal(innerBTransform.boundsHeight, 324);
  }

  // 3. Validation of Compositing Z-Order: B above A, Graphics above both
  client.requestsLog = [];
  // Set starting scene item indices where Graphics is above both, but B is below A
  client.state.programItems = [
    { sourceName: 'Emberstage Camera A', sourceUuid: 'camera-a-uuid-1', sceneItemId: 101, sceneItemIndex: 2 },
    { sourceName: 'Emberstage Camera B', sourceUuid: 'camera-b-uuid-1', sceneItemId: 102, sceneItemIndex: 1 },
    { sourceName: 'Emberstage Graphics', sourceUuid: 'graphics-uuid-1', sceneItemId: 103, sceneItemIndex: 3 }
  ];

  await camera.takeDual('input-facetime', 'input-logitech', { layout: 'inset', corner: 'bottom-right', transition: 'cut' });

  // Get final indices
  const finalA = client.state.programItems.find(it => it.sceneItemId === 101).sceneItemIndex;
  const finalB = client.state.programItems.find(it => it.sceneItemId === 102).sceneItemIndex;
  const finalG = client.state.programItems.find(it => it.sceneItemId === 103).sceneItemIndex;

  assert.ok(finalA < finalB, 'Slot A index must be less than Slot B index');
  assert.ok(finalB < finalG, 'Slot B index must be less than Graphics index');

  // 4. Validation of Z-Order Rollback on Failure
  client.state.programItems = [
    { sourceName: 'Emberstage Camera A', sourceUuid: 'camera-a-uuid-1', sceneItemId: 101, sceneItemIndex: 2 },
    { sourceName: 'Emberstage Camera B', sourceUuid: 'camera-b-uuid-1', sceneItemId: 102, sceneItemIndex: 1 },
    { sourceName: 'Emberstage Graphics', sourceUuid: 'graphics-uuid-1', sceneItemId: 103, sceneItemIndex: 3 }
  ];

  client.failures['SetSceneItemTransform'] = true;
  await assert.rejects(async () => {
    await camera.takeDual('input-facetime', 'input-logitech', { layout: 'inset', corner: 'bottom-right', transition: 'cut' });
  });
  delete client.failures['SetSceneItemTransform'];
  camera.verified = true; // reset verification flag for test progression

  // Check indices were restored to prior state (A=2, B=1, G=3)
  const rolledA = client.state.programItems.find(it => it.sceneItemId === 101).sceneItemIndex;
  const rolledB = client.state.programItems.find(it => it.sceneItemId === 102).sceneItemIndex;
  const rolledG = client.state.programItems.find(it => it.sceneItemId === 103).sceneItemIndex;

  assert.equal(rolledA, 2, 'Slot A index should be restored');
  assert.equal(rolledB, 1, 'Slot B index should be restored');
  assert.equal(rolledG, 3, 'Graphics index should be restored');

  // 5. Validation of Sequential Fade Sequencing (SetSourceFilterSettings with opacity: 0.0 completed BEFORE SetSceneItemEnabled: true)
  // Let's take single first to set a baseline
  await camera.take('input-facetime', { transition: 'cut' });

  client.requestsLog = [];
  await camera.takeDual('input-facetime', 'input-logitech', { layout: 'inset', corner: 'bottom-right', transition: 'fade', duration: 100 });

  // Let's filter the log to see the relative order of opacity: 0.0 vs SetSceneItemEnabled: true for program items
  const filterZeroAIdx = client.requestsLog.findIndex(
    r => r.type === 'SetSourceFilterSettings' && r.requestData.sourceUuid === 'camera-a-uuid-1' && r.requestData.filterSettings?.opacity === 0.0
  );
  const filterZeroBIdx = client.requestsLog.findIndex(
    r => r.type === 'SetSourceFilterSettings' && r.requestData.sourceUuid === 'camera-b-uuid-1' && r.requestData.filterSettings?.opacity === 0.0
  );
  const enableAIdx = client.requestsLog.findIndex(
    r => r.type === 'SetSceneItemEnabled' && r.requestData.sceneUuid === validBinding.program.uuid && r.requestData.sceneItemId === 101 && r.requestData.sceneItemEnabled === true
  );
  const enableBIdx = client.requestsLog.findIndex(
    r => r.type === 'SetSceneItemEnabled' && r.requestData.sceneUuid === validBinding.program.uuid && r.requestData.sceneItemId === 102 && r.requestData.sceneItemEnabled === true
  );

  assert.ok(filterZeroAIdx !== -1, 'Should set Slot A opacity to 0.0');
  assert.ok(filterZeroBIdx !== -1, 'Should set Slot B opacity to 0.0');
  assert.ok(enableAIdx !== -1, 'Should enable Slot A in program');
  assert.ok(enableBIdx !== -1, 'Should enable Slot B in program');

  assert.ok(filterZeroAIdx < enableAIdx, 'Slot A opacity 0.0 must be set before enabling Slot A in program to avoid flash');
  assert.ok(filterZeroBIdx < enableBIdx, 'Slot B opacity 0.0 must be set before enabling Slot B in program to avoid flash');
});

test('Lightweight and robust screenshot validation', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // 1. Verify correct screenshot request properties (JPEG, width 320, compression quality 60)
  client.requestsLog = [];
  const imgData = await camera.screenshot('input-facetime');
  assert.equal(imgData, 'data:image/png;base64,mockPngData');

  const screenshotRequests = client.requestsLog.filter(r => r.type === 'GetSourceScreenshot');
  assert.equal(screenshotRequests.length, 1);
  const reqData = screenshotRequests[0].requestData;
  assert.equal(reqData.sourceUuid, 'input-facetime');
  assert.equal(reqData.imageFormat, 'jpeg');
  assert.equal(reqData.imageWidth, 320);
  assert.equal(reqData.imageCompressionQuality, 60);

  // Verify NO full graph validation burst (no revalidate requests like GetSceneList or GetInputList)
  const revalidateRequests = client.requestsLog.filter(
    r => r.type === 'GetSceneList' || r.type === 'GetInputList'
  );
  assert.equal(revalidateRequests.length, 0, 'Screenshot must be cheap and not revalidate the entire graph per frame');

  // 2. Reject during transitions
  camera.transitioning = true;
  await assert.rejects(async () => {
    await camera.screenshot('input-facetime');
  }, /Cannot take screenshot while transition in progress/);
  camera.transitioning = false;

  // 3. Reject when disposed (not initialized)
  camera.dispose();
  await assert.rejects(async () => {
    await camera.screenshot('input-facetime');
  }, /Client is disposed or not initialized/);

  // 4. Reject non-owned/unknown inputs
  const camera2 = new EmberstageNativeCamera(client);
  await camera2.initialize(validBinding);
  await assert.rejects(async () => {
    await camera2.screenshot('unknown-uuid-999');
  }, /is invalid or does not exist in OBS/);
});

test('Dual-camera z-order with interleaved user items index preservation', async () => {
  const client = new MockOBSClient();
  const camera = new EmberstageNativeCamera(client);
  await camera.initialize(validBinding);

  // Set up initial state with interleaved unrelated items:
  // Item 0: Unrelated (index 0)
  // Item 1: Slot B (index 1)
  // Item 2: Unrelated (index 2)
  // Item 3: Slot A (index 3)
  // Item 4: Graphics (index 4)
  client.state.programItems = [
    { sourceName: 'User-Item-0', sourceUuid: 'user-0-uuid', sceneItemId: 200, sceneItemIndex: 0 },
    { sourceName: 'Emberstage Camera B', sourceUuid: 'camera-b-uuid-1', sceneItemId: 102, sceneItemIndex: 1 },
    { sourceName: 'User-Item-1', sourceUuid: 'user-1-uuid', sceneItemId: 201, sceneItemIndex: 2 },
    { sourceName: 'Emberstage Camera A', sourceUuid: 'camera-a-uuid-1', sceneItemId: 101, sceneItemIndex: 3 },
    { sourceName: 'Emberstage Graphics', sourceUuid: 'graphics-uuid-1', sceneItemId: 103, sceneItemIndex: 4 }
  ];

  await assert.rejects(async () => {
    await camera.takeDual('input-facetime', 'input-logitech', { layout: 'split', transition: 'cut' });
  }, /Emberstage program contains unexpected items./);

  // Since it fails closed, all indices must remain completely untouched
  const finalItems = [...client.state.programItems].sort((a, b) => a.sceneItemIndex - b.sceneItemIndex);
  const user0 = finalItems.find(it => it.sceneItemId === 200);
  const user1 = finalItems.find(it => it.sceneItemId === 201);
  const slotA = finalItems.find(it => it.sceneItemId === 101);
  const slotB = finalItems.find(it => it.sceneItemId === 102);
  const graphics = finalItems.find(it => it.sceneItemId === 103);

  assert.equal(user0.sceneItemIndex, 0, 'User-Item-0 index must remain untouched');
  assert.equal(user1.sceneItemIndex, 2, 'User-Item-1 index must remain untouched');
  assert.equal(slotB.sceneItemIndex, 1, 'Slot B index must remain untouched');
  assert.equal(slotA.sceneItemIndex, 3, 'Slot A index must remain untouched');
  assert.equal(graphics.sceneItemIndex, 4, 'Graphics index must remain untouched');
});
