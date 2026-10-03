/* Native OBS camera backend for Emberstage.
   Controls native scene elements and handles transitions and layouts. */

(function (root) {
  'use strict';

  // Do not duplicate LayoutHelper fallback here.
  // We assume root.EmberstageLayoutHelper exists.
  function getLayoutHelper() {
    const helper = root.EmberstageLayoutHelper;
    if (!helper) {
      throw new Error('EmberstageNativeCamera: EmberstageLayoutHelper is not loaded.');
    }
    return helper;
  }

  function isValidVideoInput(item, binding) {
    if (!item) return false;
    const uuid = item.inputUuid || item.uuid;
    const kind = (item.inputKind || item.kind || '').replace(/_v\d+$/, '');

    // Exclude owned sources
    if (uuid === binding.program.uuid || uuid === binding.graphics.uuid) return false;
    if (binding.slots.some((slot) => slot.uuid === uuid)) return false;

    // Accept every input kind, including unknown plugins. Scenes and groups
    // are containers, not inputs, and could recursively contain our program.
    return !['group', 'scene'].includes(kind);
  }

  class EmberstageNativeCamera {
    constructor(client) {
      if (!client) {
        throw new Error('EmberstageNativeCamera: OBS client is required.');
      }
      this.client = client;
      this.initialized = false;
      this.verified = false;
      this.transitioning = false;

      this.binding = null;
      this.inputs = [];
      this.allInputs = [];

      this.activeSlotIndex = 0; // 0 for slot A, 1 for slot B
      this.activeInputUuid = null;
      this.live = false;

      this.currentPreset = 'full';
      this.currentCorner = 'bottom-right';
      this.currentFit = 'cover';

      this.dualLayout = null;
      this.dualCorner = null;

      this.baseWidth = 1920;
      this.baseHeight = 1080;

      this.programSceneItemIds = {}; // Map of sourceUuid -> sceneItemId in program scene
      this.unsubscribes = [];
    }

    async initialize(binding) {
      if (!binding) {
        if (typeof window !== 'undefined' && window.EmberstageNativeInstall) {
          binding = window.EmberstageNativeInstall;
        } else if (typeof globalThis !== 'undefined' && globalThis.EmberstageNativeInstall) {
          binding = globalThis.EmberstageNativeInstall;
        }
      }

      if (!binding) {
        throw new Error('EmberstageNativeCamera: No binding provided.');
      }

      if (binding.version !== 1) {
        throw new Error(`EmberstageNativeCamera: Unsupported binding version ${binding.version}`);
      }

      if (
        !binding.collection ||
        !binding.program ||
        !binding.program.uuid ||
        !binding.program.name ||
        !binding.slots ||
        binding.slots.length !== 2 ||
        !binding.graphics ||
        !binding.graphics.uuid ||
        !binding.graphics.name
      ) {
        throw new Error('EmberstageNativeCamera: Invalid binding structure.');
      }

      const slotA = binding.slots[0];
      const slotB = binding.slots[1];
      if (
        typeof slotA.uuid !== 'string' ||
        typeof slotB.uuid !== 'string' ||
        !slotA.uuid ||
        !slotB.uuid ||
        slotA.uuid === slotB.uuid
      ) {
        throw new Error('EmberstageNativeCamera: Slots must have distinct valid UUID strings.');
      }

      this.binding = binding;
      this.initialized = true;
      this.verified = false;
      this.setupListeners();

      await this.refresh();
    }

    setupListeners() {
      if (this.unsubscribes) {
        for (const unsub of this.unsubscribes) unsub();
      }
      this.unsubscribes = [];

      const handleCollectionChange = (event) => {
        if (event && event.currentSceneCollectionName !== this.binding?.collection) {
          this.verified = false;
        }
      };

      const handleDisconnect = () => {
        this.verified = false;
        this.initialized = false;
      };

      this.unsubscribes.push(this.client.on('event', ({ type, data }) => {
        if (type === 'CurrentSceneCollectionChanging') this.verified = false;
        if (type === 'CurrentSceneCollectionChanged') handleCollectionChange(data);
      }));
      this.unsubscribes.push(this.client.on('status', (status) => {
        if (status && status.state === 'disconnected') {
          handleDisconnect();
        }
      }));
    }

    async refresh() {
      this.verified = false;
      if (!this.initialized) {
        throw new Error('EmberstageNativeCamera: Call initialize(binding) first.');
      }

      if (!this.client || !this.client.ready) {
        throw new Error('EmberstageNativeCamera: OBS client is not connected.');
      }

      // 1. Verify available requests if GetVersion is supported
      let availableRequests = [];
      try {
        const versionRes = await this.client.request('GetVersion');
        availableRequests = versionRes.availableRequests || [];
      } catch (err) {
        throw new Error(`EmberstageNativeCamera: GetVersion RPC failed: ${err.message}`);
      }

      if (availableRequests.length > 0) {
        const requiredRequests = [
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
          'GetSourceScreenshot'
        ];
        for (const req of requiredRequests) {
          if (!availableRequests.includes(req)) {
            throw new Error(`EmberstageNativeCamera: OBS does not support required request '${req}'`);
          }
        }
      }

      // 2. Verify current scene collection
      const collectionRes = await this.client.request('GetSceneCollectionList');
      if (collectionRes.currentSceneCollectionName !== this.binding.collection) {
        throw new Error(`EmberstageNativeCamera: Scene collection mismatch. Expected '${this.binding.collection}', got '${collectionRes.currentSceneCollectionName}'`);
      }

      // 3. Verify scenes exist
      const sceneListRes = await this.client.request('GetSceneList');
      const scenes = sceneListRes.scenes || [];

      const programScene = scenes.find((s) => s.sceneUuid === this.binding.program.uuid);
      if (!programScene || programScene.sceneName !== this.binding.program.name) {
        throw new Error(`EmberstageNativeCamera: Program scene mismatch. Expected '${this.binding.program.name}' with UUID '${this.binding.program.uuid}'`);
      }

      for (const slot of this.binding.slots) {
        const slotScene = scenes.find((s) => s.sceneUuid === slot.uuid);
        if (!slotScene || slotScene.sceneName !== slot.name) {
          throw new Error(`EmberstageNativeCamera: Slot scene mismatch. Expected '${slot.name}' with UUID '${slot.uuid}'`);
        }
      }

      // 4. Verify program scene items structure and order (using sceneItemIndex)
      const programItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: this.binding.program.uuid });
      const items = programItemsRes.sceneItems || [];

      const slotAItem = items.find((it) => it.sourceUuid === this.binding.slots[0].uuid);
      const slotBItem = items.find((it) => it.sourceUuid === this.binding.slots[1].uuid);
      const graphicsItem = items.find((it) => it.sourceUuid === this.binding.graphics.uuid);

      if (items.length !== 3 || new Set(items.map(item => item.sourceUuid)).size !== 3 || !slotAItem || !slotBItem || !graphicsItem) {
        throw new Error('EmberstageNativeCamera: Program scene is missing required items.');
      }

      if (graphicsItem.sceneItemIndex <= slotAItem.sceneItemIndex || graphicsItem.sceneItemIndex <= slotBItem.sceneItemIndex) {
        throw new Error('EmberstageNativeCamera: Graphics source must be on top of camera slots.');
      }

      // Cache program scene item IDs for future operations
      this.programSceneItemIds = {};
      this.programSceneItemIds[this.binding.slots[0].uuid] = slotAItem.sceneItemId;
      this.programSceneItemIds[this.binding.slots[1].uuid] = slotBItem.sceneItemId;
      this.programSceneItemIds[this.binding.graphics.uuid] = graphicsItem.sceneItemId;

      // 5. Verify graphics browser source and URL basename
      const graphicsSettingsRes = await this.client.request('GetInputSettings', { inputUuid: this.binding.graphics.uuid });
      const normalizedInputKind = (graphicsSettingsRes.inputKind || '').replace(/_v\d+$/, '');
      if (normalizedInputKind !== 'browser_source') {
        throw new Error(`EmberstageNativeCamera: Graphics input is of incorrect kind. Expected 'browser_source', got '${graphicsSettingsRes.inputKind}'`);
      }

      const url = graphicsSettingsRes.inputSettings?.url || '';
      const basename = url.replace(/\\/g, '/').split('/').pop();
      if (basename !== 'emberstage_output.html') {
        throw new Error(`EmberstageNativeCamera: Graphics input URL must point to 'emberstage_output.html', found: '${url}'`);
      }

      // 6. Read canvas dimensions
      const videoRes = await this.client.request('GetVideoSettings');
      this.baseWidth = videoRes.baseWidth || 1920;
      this.baseHeight = videoRes.baseHeight || 1080;

      // 7. Inventory discovery, filter and classification
      const inputsRes = await this.client.request('GetInputList');
      const allInputs = inputsRes.inputs || [];

      // Expose filtered sensible lists using isValidVideoInput
      this.allInputs = allInputs.filter((item) => isValidVideoInput(item, this.binding));
      this.inputs = this.allInputs;

      for (const slot of this.binding.slots) {
        const { sceneItems = [] } = await this.client.request('GetSceneItemList', { sceneUuid: slot.uuid });
        if (sceneItems.length > 1 || sceneItems.some(item => !this.allInputs.some(input => input.inputUuid === item.sourceUuid))) {
          throw new Error('Emberstage camera helper contains unexpected items. Restore its installed structure before continuing.');
        }
        const filter = await this.client.request('GetSourceFilter', { sourceUuid: slot.uuid, filterName: 'Emberstage Opacity' });
        if (filter.filterKind !== 'color_filter_v2' || !filter.filterEnabled || !Number.isFinite(filter.filterSettings?.opacity)) {
          throw new Error('Emberstage camera opacity filter is missing or changed.');
        }
      }

      // 8. Read active slot based on actual enabled program scene items
      const enabledResA = await this.client.request('GetSceneItemEnabled', {
        sceneUuid: this.binding.program.uuid,
        sceneItemId: slotAItem.sceneItemId
      });
      const enabledResB = await this.client.request('GetSceneItemEnabled', {
        sceneUuid: this.binding.program.uuid,
        sceneItemId: slotBItem.sceneItemId
      });

      const isEnabledA = !!enabledResA.sceneItemEnabled;
      const isEnabledB = !!enabledResB.sceneItemEnabled;

      if (isEnabledA && isEnabledB) {
        this.dual = true;
        const slotAItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: this.binding.slots[0].uuid });
        const slotBItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: this.binding.slots[1].uuid });
        const slotAItems = slotAItemsRes.sceneItems || [];
        const slotBItems = slotBItemsRes.sceneItems || [];
        
        const cameraInSlotA = slotAItems[0]?.sourceUuid || null;
        const cameraInSlotB = slotBItems[0]?.sourceUuid || null;
        
        if (cameraInSlotA && !this.allInputs.some((inp) => inp.inputUuid === cameraInSlotA)) {
          throw new Error(`EmberstageNativeCamera: Slot A contains unknown or invalid input UUID '${cameraInSlotA}'.`);
        }
        if (cameraInSlotB && !this.allInputs.some((inp) => inp.inputUuid === cameraInSlotB)) {
          throw new Error(`EmberstageNativeCamera: Slot B contains unknown or invalid input UUID '${cameraInSlotB}'.`);
        }
        
        this.activeLeftUuid = cameraInSlotA;
        this.activeRightUuid = cameraInSlotB;
        this.activeSlotIndex = 0;
        this.activeInputUuid = null;
        this.live = !!(cameraInSlotA && cameraInSlotB);

        // Infer dualLayout and dualCorner
        this.dualLayout = 'split';
        this.dualCorner = 'bottom-right';

        try {
          const [slotATransRes, slotBTransRes] = await Promise.all([
            this.client.request('GetSceneItemTransform', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItem.sceneItemId }),
            this.client.request('GetSceneItemTransform', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItem.sceneItemId })
          ]);
          const transA = slotATransRes.sceneItemTransform;
          const transB = slotBTransRes.sceneItemTransform;

          const canvasWidth = this.baseWidth;
          const canvasHeight = this.baseHeight;

          if (Math.abs(transB.positionX - canvasWidth / 2) < 2.0 && Math.abs(transB.positionY) < 2.0) {
            this.dualLayout = 'split';
            this.dualCorner = 'bottom-right';
          } else {
            this.dualLayout = 'inset';
            const helper = getLayoutHelper();
            let bestCorner = 'bottom-right';
            let minError = Infinity;
            for (const corner of ['top-left', 'top-right', 'bottom-left', 'bottom-right']) {
              const geom = helper.getLayoutGeometry('camera-inset', corner);
              const expectedX = (geom.camera.left / 100) * canvasWidth;
              const expectedY = (geom.camera.top / 100) * canvasHeight;
              const err = Math.abs(transB.positionX - expectedX) + Math.abs(transB.positionY - expectedY);
              if (err < minError) {
                minError = err;
                bestCorner = corner;
              }
            }
            if (minError < 10.0) {
              this.dualCorner = bestCorner;
            } else {
              this.dualCorner = 'bottom-right';
            }
          }
        } catch (err) {
          // ignore error, default split / bottom-right is fine
        }
      } else {
        this.dual = false;
        this.activeLeftUuid = null;
        this.activeRightUuid = null;
        this.dualLayout = null;
        this.dualCorner = null;

        let activeIndex = 0;
        if (isEnabledB) {
          activeIndex = 1;
        } else if (isEnabledA) {
          activeIndex = 0;
        } else {
          activeIndex = 0; // default to 0 but live will be false
        }

        this.activeSlotIndex = activeIndex;

        // Verify filter settings of the chosen active slot
        const activeSlotUuid = this.binding.slots[activeIndex].uuid;
        const filterRes = await this.client.request('GetSourceFilter', {
          sourceUuid: activeSlotUuid,
          filterName: 'Emberstage Opacity'
        });

        if (filterRes.filterKind !== 'color_filter_v2') {
          throw new Error(`EmberstageNativeCamera: Filter 'Emberstage Opacity' on active slot is of invalid kind '${filterRes.filterKind}'.`);
        }
        if (!filterRes.filterEnabled) {
          throw new Error("EmberstageNativeCamera: Filter 'Emberstage Opacity' on active slot is disabled.");
        }

        const opacity = filterRes.filterSettings?.opacity;
        if (typeof opacity !== 'number' || !Number.isFinite(opacity)) {
          throw new Error('EmberstageNativeCamera: Filter opacity on active slot is not a finite number.');
        }

        // Check slot items. Max one item allowed.
        const slotItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: activeSlotUuid });
        const activeSlotItems = slotItemsRes.sceneItems || [];
        if (activeSlotItems.length > 1) {
          throw new Error(`EmberstageNativeCamera: Active slot scene contains more than one item: ${activeSlotItems.length}`);
        }

        const cameraInActiveSlot = activeSlotItems[0]?.sourceUuid || null;
        if (cameraInActiveSlot && !this.allInputs.some((inp) => inp.inputUuid === cameraInActiveSlot)) {
          throw new Error(`EmberstageNativeCamera: Slot contains unknown or invalid input UUID '${cameraInActiveSlot}'.`);
        }

        this.activeInputUuid = cameraInActiveSlot;
        this.live = (isEnabledA || isEnabledB) && !!this.activeInputUuid;
      }

      this.verified = true;
    }

    async connect() {
      return this.refresh();
    }

    async revalidate() {
      if (!this.initialized || !this.verified) {
        throw new Error('EmberstageNativeCamera: Camera backend is not initialized or verified. Call refresh() first.');
      }

      const collectionRes = await this.client.request('GetSceneCollectionList');
      if (collectionRes.currentSceneCollectionName !== this.binding.collection) {
        this.verified = false;
        throw new Error('EmberstageNativeCamera: Scene collection has changed.');
      }

      const programItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: this.binding.program.uuid });
      const items = programItemsRes.sceneItems || [];

      if (items.length !== 3 || new Set(items.map(item => item.sourceUuid)).size !== 3) {
        this.verified = false;
        throw new Error('Emberstage program contains unexpected items.');
      }
      for (const [uuid, cachedItemId] of Object.entries(this.programSceneItemIds)) {
        const item = items.find((it) => it.sceneItemId === cachedItemId);
        if (!item || item.sourceUuid !== uuid) {
          this.verified = false;
          throw new Error('EmberstageNativeCamera: Scene item configuration changed or was deleted.');
        }
      }
      const graphics = items.find(item => item.sourceUuid === this.binding.graphics.uuid);
      if (items.some(item => item !== graphics && item.sceneItemIndex >= graphics.sceneItemIndex)) {
        this.verified = false;
        throw new Error('Emberstage graphics must remain above both camera helpers.');
      }
      for (const slot of this.binding.slots) {
        const { sceneItems = [] } = await this.client.request('GetSceneItemList', { sceneUuid: slot.uuid });
        if (sceneItems.length > 1 || sceneItems.some(item => !this.allInputs.some(input => input.inputUuid === item.sourceUuid))) {
          this.verified = false;
          throw new Error('Emberstage camera helper membership changed.');
        }
      }
    }

    async take(inputUuid, options = {}) {
      if (this.transitioning) {
        throw new Error('EmberstageNativeCamera: A transition is already in progress.');
      }

      const fit = options.fit || 'cover';
      if (!['cover', 'contain'].includes(fit)) throw new Error('Unsupported camera framing.');
      const transition = options.transition || 'cut';
      let duration = options.duration !== undefined ? options.duration : 300;

      if (!['cut', 'fade', 'dip'].includes(transition)) {
        throw new Error(`EmberstageNativeCamera: Invalid transition '${transition}'`);
      }

      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        throw new Error(`EmberstageNativeCamera: Invalid duration value '${duration}'`);
      }

      // Bound duration
      if (duration < 150) duration = 150;
      if (duration > 500) duration = 500;

      this.transitioning = true;
      const priorDual = this.dual;
      const priorActiveLeft = this.activeLeftUuid;
      const priorActiveRight = this.activeRightUuid;
      const priorDualLayout = this.dualLayout;
      const priorDualCorner = this.dualCorner;
      this.dual = false;
      this.activeLeftUuid = null;
      this.activeRightUuid = null;
      this.dualLayout = null;
      this.dualCorner = null;

      try {
        await this.revalidate();

        // Fresh GetInputList check
        const inputsRes = await this.client.request('GetInputList');
        const freshAllInputs = inputsRes.inputs || [];
        const targetInput = freshAllInputs.find((inp) => inp.inputUuid === inputUuid);

        if (!targetInput || !isValidVideoInput(targetInput, this.binding)) {
          throw new Error(`EmberstageNativeCamera: Input UUID '${inputUuid}' is invalid or does not exist in OBS.`);
        }

        // Also update inventory cache
        this.allInputs = freshAllInputs.filter((item) => isValidVideoInput(item, this.binding));
        this.inputs = this.allInputs;

        this.currentFit = fit;

        const activeSlotIndexBefore = this.activeSlotIndex;
        const inactiveSlotIndex = 1 - this.activeSlotIndex;
        const inactiveSlot = this.binding.slots[inactiveSlotIndex];
        const activeSlot = this.binding.slots[this.activeSlotIndex];

        const slotA = this.binding.slots[0];
        const slotB = this.binding.slots[1];
        const slotAItemId = this.programSceneItemIds[slotA.uuid];
        const slotBItemId = this.programSceneItemIds[slotB.uuid];
        const inactiveSlotItemId = this.programSceneItemIds[inactiveSlot.uuid];
        const activeSlotItemId = this.programSceneItemIds[activeSlot.uuid];

        const priorState = {
          slotAItem: null,
          slotBItem: null,
          slotAProgramEnabled: null,
          slotBProgramEnabled: null,
          slotAProgramTransform: null,
          slotBProgramTransform: null,
          slotAFilterSettings: null,
          slotBFilterSettings: null,
        };

        if (priorDual) {
          // Record the full prior dual state for rollback and transition
          const [slotAProgRes, slotBProgRes] = await Promise.all([
            this.client.request('GetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItemId }),
            this.client.request('GetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItemId })
          ]);
          priorState.slotAProgramEnabled = slotAProgRes.sceneItemEnabled;
          priorState.slotBProgramEnabled = slotBProgRes.sceneItemEnabled;

          const [slotAProgTrans, slotBProgTrans] = await Promise.all([
            this.client.request('GetSceneItemTransform', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItemId }),
            this.client.request('GetSceneItemTransform', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItemId })
          ]);
          priorState.slotAProgramTransform = slotAProgTrans.sceneItemTransform;
          priorState.slotBProgramTransform = slotBProgTrans.sceneItemTransform;

          const [slotAFilterRes, slotBFilterRes] = await Promise.all([
            this.client.request('GetSourceFilter', { sourceUuid: slotA.uuid, filterName: 'Emberstage Opacity' }).catch(() => null),
            this.client.request('GetSourceFilter', { sourceUuid: slotB.uuid, filterName: 'Emberstage Opacity' }).catch(() => null)
          ]);
          priorState.slotAFilterSettings = slotAFilterRes ? slotAFilterRes.filterSettings : { opacity: 1.0, brightness: 0.0 };
          priorState.slotBFilterSettings = slotBFilterRes ? slotBFilterRes.filterSettings : { opacity: 1.0, brightness: 0.0 };

          const [slotAItemsRes, slotBItemsRes] = await Promise.all([
            this.client.request('GetSceneItemList', { sceneUuid: slotA.uuid }),
            this.client.request('GetSceneItemList', { sceneUuid: slotB.uuid })
          ]);
          const slotAItems = slotAItemsRes.sceneItems || [];
          const slotBItems = slotBItemsRes.sceneItems || [];

          if (slotAItems.length > 0) {
            const item = slotAItems[0];
            const trans = await this.client.request('GetSceneItemTransform', { sceneUuid: slotA.uuid, sceneItemId: item.sceneItemId });
            priorState.slotAItem = {
              sourceUuid: item.sourceUuid,
              sceneItemId: item.sceneItemId,
              enabled: item.sceneItemEnabled,
              transform: trans.sceneItemTransform
            };
          }
          if (slotBItems.length > 0) {
            const item = slotBItems[0];
            const trans = await this.client.request('GetSceneItemTransform', { sceneUuid: slotB.uuid, sceneItemId: item.sceneItemId });
            priorState.slotBItem = {
              sourceUuid: item.sourceUuid,
              sceneItemId: item.sceneItemId,
              enabled: item.sceneItemEnabled,
              transform: trans.sceneItemTransform
            };
          }
        }

        let createdSceneItemId = null;
        let oldLiveState = this.live;

        try {
          const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
          const isCut = transition === 'cut' || prefersReducedMotion;

          if (priorDual) {
            // Fade/dip out both slots from dual layout first if live
            if (oldLiveState && !isCut) {
              const fadeOutDuration = duration / 2;
              const startOut = Date.now();
              while (true) {
                if (!this.initialized || !this.verified) {
                  throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
                }
                const elapsed = Date.now() - startOut;
                const t = Math.min(1.0, elapsed / fadeOutDuration);

                let opacity = 1.0 - t;
                let brightness = 0.0;

                if (transition === 'dip') {
                  opacity = 1.0 - t;
                  brightness = -t * 2;
                }

                await Promise.all(this.binding.slots.map(slot =>
                  this.client.request('SetSourceFilterSettings', {
                    sourceUuid: slot.uuid,
                    filterName: 'Emberstage Opacity',
                    filterSettings: { opacity, brightness }
                  })
                ));

                if (t >= 1.0) {
                  break;
                }
                await new Promise((res) => setTimeout(res, 30));
              }
            }

            // Prepare inactiveSlot with target input
            const inactiveItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: inactiveSlot.uuid });
            const inactiveItems = inactiveItemsRes.sceneItems || [];
            if (inactiveItems.length > 1) {
              throw new Error(`EmberstageNativeCamera: Inactive slot scene has more than one item: ${inactiveItems.length}`);
            }

            let cameraItemId = null;
            if (inactiveItems.length === 1) {
              const existingItem = inactiveItems[0];
              if (existingItem.sourceUuid === inputUuid) {
                cameraItemId = existingItem.sceneItemId;
              } else {
                await this.client.request('RemoveSceneItem', { sceneUuid: inactiveSlot.uuid, sceneItemId: existingItem.sceneItemId });
              }
            }

            // Set inactive slot's opacity to 0.0 before creating/enabling
            await this.client.request('SetSourceFilterSettings', {
              sourceUuid: inactiveSlot.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 0.0, brightness: 0.0 }
            });

            if (cameraItemId === null) {
              const createRes = await this.client.request('CreateSceneItem', {
                sceneUuid: inactiveSlot.uuid,
                sourceUuid: inputUuid,
                sceneItemEnabled: false
              });
              cameraItemId = createRes.sceneItemId;
              createdSceneItemId = cameraItemId;
            }

            // Apply transforms
            const helper = getLayoutHelper();
            const geom = helper.getLayoutGeometry(this.currentPreset, this.currentCorner);
            const canvasWidth = this.baseWidth;
            const canvasHeight = this.baseHeight;

            const x = (geom.camera.left / 100) * canvasWidth;
            const y = (geom.camera.top / 100) * canvasHeight;

            await this.client.request('SetSceneItemTransform', {
              sceneUuid: this.binding.program.uuid,
              sceneItemId: inactiveSlotItemId,
              sceneItemTransform: {
                positionX: x,
                positionY: y,
                boundsType: 'OBS_BOUNDS_NONE',
                scaleX: 1.0,
                scaleY: 1.0,
                cropTop: 0,
                cropBottom: 0,
                cropLeft: 0,
                cropRight: 0
              }
            });

            await this.client.request('SetSceneItemTransform', {
              sceneUuid: this.binding.program.uuid,
              sceneItemId: activeSlotItemId,
              sceneItemTransform: {
                positionX: x,
                positionY: y,
                boundsType: 'OBS_BOUNDS_NONE',
                scaleX: 1.0,
                scaleY: 1.0,
                cropTop: 0,
                cropBottom: 0,
                cropLeft: 0,
                cropRight: 0
              }
            });

            const w = (geom.camera.width / 100) * canvasWidth;
            const h = (geom.camera.height / 100) * canvasHeight;
            await this.client.request('SetSceneItemTransform', {
              sceneUuid: inactiveSlot.uuid,
              sceneItemId: cameraItemId,
              sceneItemTransform: {
                positionX: 0,
                positionY: 0,
                boundsType: fit === 'cover' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER',
                boundsWidth: w,
                boundsHeight: h,
                cropToBounds: true,
                alignment: 5
              }
            });

            await this.client.request('SetSceneItemEnabled', {
              sceneUuid: inactiveSlot.uuid,
              sceneItemId: cameraItemId,
              sceneItemEnabled: true
            });

            if (isCut) {
              await Promise.all([
                this.client.request('SetSourceFilterSettings', {
                  sourceUuid: inactiveSlot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity: 1.0, brightness: 0.0 }
                }),
                this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: inactiveSlotItemId,
                  sceneItemEnabled: true
                }),
                this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: activeSlotItemId,
                  sceneItemEnabled: false
                })
              ]);
            } else {
              await Promise.all([
                this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: inactiveSlotItemId,
                  sceneItemEnabled: true
                }),
                this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: activeSlotItemId,
                  sceneItemEnabled: false
                })
              ]);

              const fadeInDuration = oldLiveState ? duration / 2 : duration;
              const startIn = Date.now();
              while (true) {
                if (!this.initialized || !this.verified) {
                  throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
                }
                const elapsed = Date.now() - startIn;
                const t = Math.min(1.0, elapsed / fadeInDuration);

                let opacity = t;
                let brightness = 0.0;

                if (transition === 'dip') {
                  opacity = t;
                  brightness = -(1.0 - t) * 2;
                }

                await this.client.request('SetSourceFilterSettings', {
                  sourceUuid: inactiveSlot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity, brightness }
                });

                if (t >= 1.0) {
                  break;
                }
                await new Promise((res) => setTimeout(res, 30));
              }
            }

            // Clean up the other slot
            const oldItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: activeSlot.uuid });
            const oldItems = oldItemsRes.sceneItems || [];
            for (const item of oldItems) {
              await this.client.request('RemoveSceneItem', { sceneUuid: activeSlot.uuid, sceneItemId: item.sceneItemId });
            }

            this.activeSlotIndex = inactiveSlotIndex;
            this.activeInputUuid = inputUuid;
            this.live = true;
          } else {
            // 1. Check inactive slot items. Must have at most 1 item.
            const inactiveItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: inactiveSlot.uuid });
            const inactiveItems = inactiveItemsRes.sceneItems || [];
            if (inactiveItems.length > 1) {
              throw new Error(`EmberstageNativeCamera: Inactive slot scene has more than one item: ${inactiveItems.length}`);
            }

            let cameraItemId = null;
            if (inactiveItems.length === 1) {
              const existingItem = inactiveItems[0];
              if (existingItem.sourceUuid === inputUuid) {
                // Reference reuse!
                cameraItemId = existingItem.sceneItemId;
              } else {
                // Remove old camera
                await this.client.request('RemoveSceneItem', { sceneUuid: inactiveSlot.uuid, sceneItemId: existingItem.sceneItemId });
              }
            }

            // 2. Set opacity to 0.0 before creating/enabling
            await this.client.request('SetSourceFilterSettings', {
              sourceUuid: inactiveSlot.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 0.0, brightness: 0.0 }
            });

            // 3. Create camera item if not reused
            if (cameraItemId === null) {
              const createRes = await this.client.request('CreateSceneItem', {
                sceneUuid: inactiveSlot.uuid,
                sourceUuid: inputUuid,
                sceneItemEnabled: false
              });
              cameraItemId = createRes.sceneItemId;
              createdSceneItemId = cameraItemId; // store for rollback
            }

            // 4. Apply transforms to both inner camera & outer slot
            const helper = getLayoutHelper();
            const geom = helper.getLayoutGeometry(this.currentPreset, this.currentCorner);

            // Outer slot: translation only, scale=1, crop=0
            const canvasWidth = this.baseWidth;
            const canvasHeight = this.baseHeight;

            const x = (geom.camera.left / 100) * canvasWidth;
            const y = (geom.camera.top / 100) * canvasHeight;

            // Apply outer wrapper layout to inactive slot in program scene
            const inactiveSlotItemId = this.programSceneItemIds[inactiveSlot.uuid];
            await this.client.request('SetSceneItemTransform', {
              sceneUuid: this.binding.program.uuid,
              sceneItemId: inactiveSlotItemId,
              sceneItemTransform: {
                positionX: x,
                positionY: y,
                boundsType: 'OBS_BOUNDS_NONE',
                scaleX: 1.0,
                scaleY: 1.0,
                cropTop: 0,
                cropBottom: 0,
                cropLeft: 0,
                cropRight: 0
              }
            });

            // Apply outer wrapper layout to active slot in program scene too
            const activeSlotItemId = this.programSceneItemIds[activeSlot.uuid];
            const activeX = (geom.camera.left / 100) * canvasWidth;
            const activeY = (geom.camera.top / 100) * canvasHeight;
            await this.client.request('SetSceneItemTransform', {
              sceneUuid: this.binding.program.uuid,
              sceneItemId: activeSlotItemId,
              sceneItemTransform: {
                positionX: activeX,
                positionY: activeY,
                boundsType: 'OBS_BOUNDS_NONE',
                scaleX: 1.0,
                scaleY: 1.0,
                cropTop: 0,
                cropBottom: 0,
                cropLeft: 0,
                cropRight: 0
              }
            });

            // Apply inner camera layout to inactive slot camera item
            const w = (geom.camera.width / 100) * canvasWidth;
            const h = (geom.camera.height / 100) * canvasHeight;
            await this.client.request('SetSceneItemTransform', {
              sceneUuid: inactiveSlot.uuid,
              sceneItemId: cameraItemId,
              sceneItemTransform: {
                positionX: 0,
                positionY: 0,
                boundsType: fit === 'cover' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER',
                boundsWidth: w,
                boundsHeight: h,
                cropToBounds: true,
                alignment: 5
              }
            });

            // 5. Enable camera inside inactive slot
            await this.client.request('SetSceneItemEnabled', {
              sceneUuid: inactiveSlot.uuid,
              sceneItemId: cameraItemId,
              sceneItemEnabled: true
            });

            // 6. Enable the outer slot in program scene
            await this.client.request('SetSceneItemEnabled', {
              sceneUuid: this.binding.program.uuid,
              sceneItemId: inactiveSlotItemId,
              sceneItemEnabled: true
            });

            // 7. Transition loop (serialized, awaited, bounded loop)
            if (transition === 'cut') {
              await Promise.all([
                this.client.request('SetSourceFilterSettings', {
                  sourceUuid: inactiveSlot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity: 1.0, brightness: 0.0 }
                }),
                this.client.request('SetSourceFilterSettings', {
                  sourceUuid: activeSlot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity: 0.0 }
                })
              ]);
            } else {
              // fade / dip
              const start = Date.now();
              const { sceneItems } = await this.client.request('GetSceneItemList', { sceneUuid: this.binding.program.uuid });
              const incomingAbove = sceneItems.find(item => item.sourceUuid === inactiveSlot.uuid).sceneItemIndex > sceneItems.find(item => item.sourceUuid === activeSlot.uuid).sceneItemIndex;
              while (true) {
                if (!this.initialized || !this.verified) {
                  throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
                }
                const elapsed = Date.now() - start;
                const t = Math.min(1.0, elapsed / duration);

                let opacityActive = 1.0;
                let opacityInactive = 0.0;
                let brightnessActive = 0, brightnessInactive = 0;

                if (transition === 'fade') {
                  opacityActive = incomingAbove ? 1 : 1 - t;
                  opacityInactive = incomingAbove ? t : 1;
                } else if (transition === 'dip') {
                  if (t <= 0.5) {
                    opacityActive = 1.0;
                    opacityInactive = 0.0;
                    brightnessActive = -t * 2;
                  } else {
                    opacityActive = 0.0;
                    opacityInactive = 1.0;
                    brightnessInactive = -(1 - t) * 2;
                  }
                }

                await Promise.all([
                  this.client.request('SetSourceFilterSettings', {
                    sourceUuid: activeSlot.uuid,
                    filterName: 'Emberstage Opacity',
                    filterSettings: { opacity: opacityActive, brightness: brightnessActive }
                  }),
                  this.client.request('SetSourceFilterSettings', {
                    sourceUuid: inactiveSlot.uuid,
                    filterName: 'Emberstage Opacity',
                    filterSettings: { opacity: opacityInactive, brightness: brightnessInactive }
                  })
                ]);

                if (t >= 1.0) {
                  break;
                }

                await new Promise((res) => setTimeout(res, 30));
              }
            }

            // 8. Disable old active slot in program scene
            await this.client.request('SetSceneItemEnabled', {
              sceneUuid: this.binding.program.uuid,
              sceneItemId: activeSlotItemId,
              sceneItemEnabled: false
            });

            // 9. Clean up old active slot camera item (remove if exists)
            const oldItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: activeSlot.uuid });
            const oldItems = oldItemsRes.sceneItems || [];
            for (const item of oldItems) {
              await this.client.request('RemoveSceneItem', { sceneUuid: activeSlot.uuid, sceneItemId: item.sceneItemId });
            }

            this.activeSlotIndex = inactiveSlotIndex;
            this.activeInputUuid = inputUuid;
            this.live = true;
          }
        } catch (err) {
          // Fail-safe rollback: Preserve old live, remove ONLY exact created scene item
          this.live = oldLiveState;
          this.activeSlotIndex = activeSlotIndexBefore;
          if (priorDual) {
            this.dual = true;
            this.activeLeftUuid = priorActiveLeft;
            this.activeRightUuid = priorActiveRight;
            this.dualLayout = priorDualLayout;
            this.dualCorner = priorDualCorner;
          }

          if (this.initialized && this.verified) {
            try {
              if (priorDual) {
                // Restore dual state
                // 1. Restore Slot A items
                const currentAItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: slotA.uuid });
                const currentAItems = currentAItemsRes.sceneItems || [];
                if (priorState.slotAItem) {
                  const match = currentAItems.find(it => it.sourceUuid === priorState.slotAItem.sourceUuid);
                  if (match) {
                    await this.client.request('SetSceneItemTransform', {
                      sceneUuid: slotA.uuid,
                      sceneItemId: match.sceneItemId,
                      sceneItemTransform: priorState.slotAItem.transform
                    });
                    await this.client.request('SetSceneItemEnabled', {
                      sceneUuid: slotA.uuid,
                      sceneItemId: match.sceneItemId,
                      sceneItemEnabled: priorState.slotAItem.enabled
                    });
                    for (const it of currentAItems) {
                      if (it.sceneItemId !== match.sceneItemId) {
                        await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: it.sceneItemId });
                      }
                    }
                  } else {
                    for (const it of currentAItems) {
                      await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: it.sceneItemId });
                    }
                    const createA = await this.client.request('CreateSceneItem', {
                      sceneUuid: slotA.uuid,
                      sourceUuid: priorState.slotAItem.sourceUuid,
                      sceneItemEnabled: priorState.slotAItem.enabled
                    });
                    await this.client.request('SetSceneItemTransform', {
                      sceneUuid: slotA.uuid,
                      sceneItemId: createA.sceneItemId,
                      sceneItemTransform: priorState.slotAItem.transform
                    });
                  }
                } else {
                  for (const it of currentAItems) {
                    await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: it.sceneItemId });
                  }
                }

                // 2. Restore Slot B items
                const currentBItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: slotB.uuid });
                const currentBItems = currentBItemsRes.sceneItems || [];
                if (priorState.slotBItem) {
                  const match = currentBItems.find(it => it.sourceUuid === priorState.slotBItem.sourceUuid);
                  if (match) {
                    await this.client.request('SetSceneItemTransform', {
                      sceneUuid: slotB.uuid,
                      sceneItemId: match.sceneItemId,
                      sceneItemTransform: priorState.slotBItem.transform
                    });
                    await this.client.request('SetSceneItemEnabled', {
                      sceneUuid: slotB.uuid,
                      sceneItemId: match.sceneItemId,
                      sceneItemEnabled: priorState.slotBItem.enabled
                    });
                    for (const it of currentBItems) {
                      if (it.sceneItemId !== match.sceneItemId) {
                        await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: it.sceneItemId });
                      }
                    }
                  } else {
                    for (const it of currentBItems) {
                      await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: it.sceneItemId });
                    }
                    const createB = await this.client.request('CreateSceneItem', {
                      sceneUuid: slotB.uuid,
                      sourceUuid: priorState.slotBItem.sourceUuid,
                      sceneItemEnabled: priorState.slotBItem.enabled
                    });
                    await this.client.request('SetSceneItemTransform', {
                      sceneUuid: slotB.uuid,
                      sceneItemId: createB.sceneItemId,
                      sceneItemTransform: priorState.slotBItem.transform
                    });
                  }
                } else {
                  for (const it of currentBItems) {
                    await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: it.sceneItemId });
                  }
                }

                // 3. Restore outer slot program properties
                await Promise.all([
                  this.client.request('SetSceneItemTransform', {
                    sceneUuid: this.binding.program.uuid,
                    sceneItemId: slotAItemId,
                    sceneItemTransform: priorState.slotAProgramTransform
                  }),
                  this.client.request('SetSceneItemTransform', {
                    sceneUuid: this.binding.program.uuid,
                    sceneItemId: slotBItemId,
                    sceneItemTransform: priorState.slotBProgramTransform
                  }),
                  this.client.request('SetSceneItemEnabled', {
                    sceneUuid: this.binding.program.uuid,
                    sceneItemId: slotAItemId,
                    sceneItemEnabled: priorState.slotAProgramEnabled
                  }),
                  this.client.request('SetSceneItemEnabled', {
                    sceneUuid: this.binding.program.uuid,
                    sceneItemId: slotBItemId,
                    sceneItemEnabled: priorState.slotBProgramEnabled
                  }),
                  this.client.request('SetSourceFilterSettings', {
                    sourceUuid: slotA.uuid,
                    filterName: 'Emberstage Opacity',
                    filterSettings: priorState.slotAFilterSettings
                  }),
                  this.client.request('SetSourceFilterSettings', {
                    sourceUuid: slotB.uuid,
                    filterName: 'Emberstage Opacity',
                    filterSettings: priorState.slotBFilterSettings
                  })
                ]);
              } else {
                // Restore old active slot/inactive slot single camera rollback
                if (createdSceneItemId !== null) {
                  await this.client.request('RemoveSceneItem', {
                    sceneUuid: inactiveSlot.uuid,
                    sceneItemId: createdSceneItemId
                  });
                }

                // Restore old active slot visibility in program
                const activeSlotItemId = this.programSceneItemIds[activeSlot.uuid];
                await this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: activeSlotItemId,
                  sceneItemEnabled: oldLiveState
                });

                await this.client.request('SetSourceFilterSettings', {
                  sourceUuid: activeSlot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity: 1.0, brightness: 0.0 }
                });

                // Disable inactive slot
                const inactiveSlotItemId = this.programSceneItemIds[inactiveSlot.uuid];
                await this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: inactiveSlotItemId,
                  sceneItemEnabled: false
                });

                await this.client.request('SetSourceFilterSettings', {
                  sourceUuid: inactiveSlot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity: 0.0, brightness: 0.0 }
                });
              }
            } catch (_) {
              // If rollback fails, state is uncertain! Abort/unverify!
              this.verified = false;
            }
          }

          throw err;
        }
      } finally {
        this.transitioning = false;
      }
    }

    async hide(options = {}) {
      if (this.transitioning) {
        throw new Error('EmberstageNativeCamera: Cannot hide while transition in progress.');
      }

      this.transitioning = true;

      const priorLive = this.live;
      const priorDual = this.dual;
      const priorActiveLeft = this.activeLeftUuid;
      const priorActiveRight = this.activeRightUuid;
      const priorDualLayout = this.dualLayout;
      const priorDualCorner = this.dualCorner;

      try {
        await this.revalidate();

        const transition = options.transition || 'cut';
        let duration = options.duration !== undefined ? options.duration : 300;

        if (!['cut', 'fade', 'dip'].includes(transition)) {
          throw new Error(`EmberstageNativeCamera: Invalid transition '${transition}'`);
        }

        if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
          throw new Error(`EmberstageNativeCamera: Invalid duration value '${duration}'`);
        }

        // Bound duration
        if (duration < 150) duration = 150;
        if (duration > 500) duration = 500;

        const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const isCut = transition === 'cut' || prefersReducedMotion;

        if (isCut) {
          const requests = [];
          for (const slot of this.binding.slots) {
            const slotItemId = this.programSceneItemIds[slot.uuid];
            if (slotItemId !== undefined) {
              requests.push(
                this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: slotItemId,
                  sceneItemEnabled: false
                })
              );
            }
          }
          await Promise.all(requests);
        } else {
          const slotsToFade = this.dual ? this.binding.slots : [this.binding.slots[this.activeSlotIndex]];
          const start = Date.now();
          while (true) {
            if (!this.initialized || !this.verified) {
              throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
            }

            const elapsed = Date.now() - start;
            const t = Math.min(1.0, elapsed / duration);

            let opacity = 1.0;
            let brightness = 0.0;

            if (transition === 'fade') {
              opacity = 1 - t;
            } else if (transition === 'dip') {
              if (t <= 0.5) {
                opacity = 1.0;
                brightness = -t * 2;
              } else {
                opacity = 0.0;
                brightness = 0.0;
              }
            }

            const requests = slotsToFade.map(slot =>
              this.client.request('SetSourceFilterSettings', {
                sourceUuid: slot.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: { opacity, brightness }
              })
            );
            await Promise.all(requests);

            if (t >= 1.0) {
              break;
            }

            await new Promise((res) => setTimeout(res, 30));
          }

          if (!this.initialized || !this.verified) {
            throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
          }

          const requests = [];
          for (const slot of this.binding.slots) {
            const slotItemId = this.programSceneItemIds[slot.uuid];
            if (slotItemId !== undefined) {
              requests.push(
                this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: slotItemId,
                  sceneItemEnabled: false
                })
              );
            }
          }
          await Promise.all(requests);

          if (!this.initialized || !this.verified) {
            throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
          }

          // Add a brief delay to allow the graphics thread to fully process the scene item disabling
          // before we restore filter opacities back to 1.0. This prevents any single-frame full-opacity flash!
          await new Promise((res) => setTimeout(res, 100));

          // Restore settings for next use
          const restoreRequests = slotsToFade.map(slot =>
            this.client.request('SetSourceFilterSettings', {
              sourceUuid: slot.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 1.0, brightness: 0.0 }
            })
          );
          await Promise.all(restoreRequests);
        }

        this.dual = false;
        this.activeLeftUuid = null;
        this.activeRightUuid = null;
        this.activeInputUuid = null;
        this.live = false;
        this.dualLayout = null;
        this.dualCorner = null;
      } catch (err) {
        this.live = priorLive;
        this.dual = priorDual;
        this.activeLeftUuid = priorActiveLeft;
        this.activeRightUuid = priorActiveRight;
        this.dualLayout = priorDualLayout;
        this.dualCorner = priorDualCorner;

        if (this.initialized && this.verified) {
          try {
            if (priorDual) {
              await Promise.all(this.binding.slots.map(async (slot) => {
                const slotItemId = this.programSceneItemIds[slot.uuid];
                await this.client.request('SetSceneItemEnabled', {
                  sceneUuid: this.binding.program.uuid,
                  sceneItemId: slotItemId,
                  sceneItemEnabled: priorLive
                });
                await this.client.request('SetSourceFilterSettings', {
                  sourceUuid: slot.uuid,
                  filterName: 'Emberstage Opacity',
                  filterSettings: { opacity: 1.0, brightness: 0.0 }
                });
              }));
            } else {
              const activeSlot = this.binding.slots[this.activeSlotIndex];
              const activeSlotItemId = this.programSceneItemIds[activeSlot.uuid];
              await this.client.request('SetSceneItemEnabled', {
                sceneUuid: this.binding.program.uuid,
                sceneItemId: activeSlotItemId,
                sceneItemEnabled: priorLive
              });
              await this.client.request('SetSourceFilterSettings', {
                sourceUuid: activeSlot.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: { opacity: 1.0, brightness: 0.0 }
              });
            }
          } catch (_) {
            this.verified = false;
          }
        }
        throw err;
      } finally {
        this.transitioning = false;
      }
    }

    async layout(options = {}) {
      if (this.transitioning) {
        throw new Error('EmberstageNativeCamera: Cannot apply layout while transition in progress.');
      }

      if (this.dual) {
        // If dual-camera is active, layout changes shouldn't collapse the dual camera.
        // We can just revalidate or do a no-op.
        await this.revalidate();
        return;
      }

      const preset = options.preset || 'full';
      const corner = options.corner || 'bottom-right';
      const transition = options.transition || 'cut';
      let duration = options.duration !== undefined ? options.duration : 300;

      // Validate inputs first
      if (!['full', 'split-left', 'split-right', 'camera-inset'].includes(preset)) {
        throw new Error(`EmberstageNativeCamera: Invalid preset '${preset}'`);
      }
      if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(corner)) {
        throw new Error(`EmberstageNativeCamera: Invalid corner '${corner}'`);
      }
      if (!['cut', 'fade', 'dip'].includes(transition)) {
        throw new Error(`EmberstageNativeCamera: Invalid transition '${transition}'`);
      }
      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        throw new Error(`EmberstageNativeCamera: Invalid duration value '${duration}'`);
      }

      // Bound duration
      if (duration < 150) duration = 150;
      if (duration > 500) duration = 500;

      const oldPreset = this.currentPreset || 'full';
      const oldCorner = this.currentCorner || 'bottom-right';

      if (preset === oldPreset && corner === oldCorner) {
        // Unchanged layout no-op should revalidate only, NO writes
        await this.revalidate();
        return;
      }

      const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const isCut = transition === 'cut' || prefersReducedMotion;

      this.transitioning = true;

      try {
        await this.revalidate();

        const helper = getLayoutHelper();
        const geomStart = helper.getLayoutGeometry(oldPreset, oldCorner);
        const geomEnd = helper.getLayoutGeometry(preset, corner);

        if (isCut) {
          await this._applyLayoutGeometry(geomEnd);
        } else {
          const start = Date.now();
          while (true) {
            if (!this.initialized || !this.verified) {
              throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
            }

            const elapsed = Date.now() - start;
            const t = Math.min(1.0, elapsed / duration);

            const geomInterp = {
              camera: {
                left: geomStart.camera.left + (geomEnd.camera.left - geomStart.camera.left) * t,
                top: geomStart.camera.top + (geomEnd.camera.top - geomStart.camera.top) * t,
                width: geomStart.camera.width + (geomEnd.camera.width - geomStart.camera.width) * t,
                height: geomStart.camera.height + (geomEnd.camera.height - geomStart.camera.height) * t
              }
            };

            await this._applyLayoutGeometry(geomInterp);

            if (t >= 1.0) {
              break;
            }

            await new Promise((res) => setTimeout(res, 30));
          }
        }

        // Only commit currentPreset after success!
        this.currentPreset = preset;
        this.currentCorner = corner;
      } catch (err) {
        if (this.initialized && this.verified) {
          try {
            const helper = getLayoutHelper();
            const geomStart = helper.getLayoutGeometry(oldPreset, oldCorner);
            await this._applyLayoutGeometry(geomStart);
          } catch (_) {
            this.verified = false;
          }
        }
        throw err;
      } finally {
        this.transitioning = false;
      }
    }

    async _applyLayoutGeometry(geom) {
      if (!this.initialized || !this.verified) {
        throw new Error('EmberstageNativeCamera: Instance disposed or unverified before layout write.');
      }

      const canvasWidth = this.baseWidth;
      const canvasHeight = this.baseHeight;
      const fit = this.currentFit || 'cover';

      // 1. Await reads first
      const slotItemsData = [];
      for (let i = 0; i < this.binding.slots.length; i++) {
        const slot = this.binding.slots[i];
        const slotItemId = this.programSceneItemIds[slot.uuid];

        if (slotItemId !== undefined) {
          const slotItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: slot.uuid });
          
          // Verify live state immediately after read!
          if (!this.initialized || !this.verified) {
            throw new Error('EmberstageNativeCamera: Instance disposed or unverified during layout read.');
          }

          slotItemsData.push({
            slot,
            slotItemId,
            items: slotItemsRes.sceneItems || []
          });
        }
      }

      // 2. Await mutations promptly
      for (const data of slotItemsData) {
        const { slot, slotItemId, items } = data;
        const x = (geom.camera.left / 100) * canvasWidth;
        const y = (geom.camera.top / 100) * canvasHeight;

        // Outer Slot Transform: Wrapper Translation Only
        await this.client.request('SetSceneItemTransform', {
          sceneUuid: this.binding.program.uuid,
          sceneItemId: slotItemId,
          sceneItemTransform: {
            positionX: x,
            positionY: y,
            boundsType: 'OBS_BOUNDS_NONE',
            scaleX: 1.0,
            scaleY: 1.0,
            cropTop: 0,
            cropBottom: 0,
            cropLeft: 0,
            cropRight: 0
          }
        });

        // Verify live state before next dispatch
        if (!this.initialized || !this.verified) {
          throw new Error('EmberstageNativeCamera: Instance disposed or unverified during layout write.');
        }

        // Verify membership with allInputs identities
        const validItems = items.filter(item => {
          const uuid = item.inputUuid || item.sourceUuid || item.uuid;
          return this.allInputs.some(input => (input.inputUuid || input.uuid) === uuid);
        });

        if (validItems.length === 1) {
          const w = (geom.camera.width / 100) * canvasWidth;
          const h = (geom.camera.height / 100) * canvasHeight;
          
          await this.client.request('SetSceneItemTransform', {
            sceneUuid: slot.uuid,
            sceneItemId: validItems[0].sceneItemId,
            sceneItemTransform: {
              positionX: 0,
              positionY: 0,
              boundsType: fit === 'cover' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER',
              boundsWidth: w,
              boundsHeight: h,
              cropToBounds: true,
              alignment: 5
            }
          });

          // Verify live state after next dispatch
          if (!this.initialized || !this.verified) {
            throw new Error('EmberstageNativeCamera: Instance disposed or unverified during layout write.');
          }
        }
      }

      // Graphics already compose media and scripture internally over the full canvas.
      const graphicsItemId = this.programSceneItemIds[this.binding.graphics.uuid];
      if (graphicsItemId !== undefined) {
        const x = 0, y = 0, w = canvasWidth, h = canvasHeight;

        await this.client.request('SetSceneItemTransform', {
          sceneUuid: this.binding.program.uuid,
          sceneItemId: graphicsItemId,
          sceneItemTransform: {
            positionX: x,
            positionY: y,
            boundsType: 'OBS_BOUNDS_SCALE_INNER',
            boundsWidth: w,
            boundsHeight: h,
            cropToBounds: true,
            alignment: 5
          }
        });
      }
    }

    async takeDual(leftUuid, rightUuid, options = {}) {
      if (this.transitioning) {
        throw new Error('EmberstageNativeCamera: A transition is already in progress.');
      }

      if (leftUuid === rightUuid) {
        throw new Error('EmberstageNativeCamera: Left and right cameras must be different.');
      }

      const fit = options.fit || 'cover';
      if (!['cover', 'contain'].includes(fit)) throw new Error('Unsupported camera framing.');
      const transition = options.transition || 'cut';
      let duration = options.duration !== undefined ? options.duration : 300;

      if (!['cut', 'fade', 'dip'].includes(transition)) {
        throw new Error(`EmberstageNativeCamera: Invalid transition '${transition}'`);
      }

      if (typeof duration !== 'number' || !Number.isFinite(duration) || duration < 0) {
        throw new Error(`EmberstageNativeCamera: Invalid duration value '${duration}'`);
      }

      if (duration < 150) duration = 150;
      if (duration > 500) duration = 500;

      const layout = options.layout || 'split';
      if (!['split', 'inset'].includes(layout)) {
        throw new Error(`EmberstageNativeCamera: Invalid layout '${layout}'`);
      }
      const corner = options.corner || 'bottom-right';
      if (!['top-left', 'top-right', 'bottom-left', 'bottom-right'].includes(corner)) {
        throw new Error(`EmberstageNativeCamera: Invalid corner '${corner}'`);
      }

      this.transitioning = true;

      const priorLive = this.live;
      const priorDual = this.dual;
      const priorActiveLeft = this.activeLeftUuid;
      const priorActiveRight = this.activeRightUuid;
      const priorActiveSlotIndex = this.activeSlotIndex;
      const priorActiveInputUuid = this.activeInputUuid;
      const priorDualLayout = this.dualLayout;
      const priorDualCorner = this.dualCorner;

      const slotA = this.binding.slots[0];
      const slotB = this.binding.slots[1];
      const slotAItemId = this.programSceneItemIds[slotA.uuid];
      const slotBItemId = this.programSceneItemIds[slotB.uuid];
      const graphicsItemId = this.programSceneItemIds[this.binding.graphics.uuid];

      const priorState = {
        slotAItem: null,
        slotBItem: null,
        slotAProgramEnabled: null,
        slotBProgramEnabled: null,
        slotAProgramTransform: null,
        slotBProgramTransform: null,
        slotAFilterSettings: null,
        slotBFilterSettings: null,
      };

      try {
        await this.revalidate();

        // 1. Record the full prior state before any OBS mutations
        const [slotAProgRes, slotBProgRes] = await Promise.all([
          this.client.request('GetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItemId }),
          this.client.request('GetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItemId })
        ]);
        priorState.slotAProgramEnabled = slotAProgRes.sceneItemEnabled;
        priorState.slotBProgramEnabled = slotBProgRes.sceneItemEnabled;

        const [slotAProgTrans, slotBProgTrans] = await Promise.all([
          this.client.request('GetSceneItemTransform', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItemId }),
          this.client.request('GetSceneItemTransform', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItemId })
        ]);
        priorState.slotAProgramTransform = slotAProgTrans.sceneItemTransform;
        priorState.slotBProgramTransform = slotBProgTrans.sceneItemTransform;

        const [slotAFilterRes, slotBFilterRes] = await Promise.all([
          this.client.request('GetSourceFilter', { sourceUuid: slotA.uuid, filterName: 'Emberstage Opacity' }).catch(() => null),
          this.client.request('GetSourceFilter', { sourceUuid: slotB.uuid, filterName: 'Emberstage Opacity' }).catch(() => null)
        ]);
        priorState.slotAFilterSettings = slotAFilterRes ? slotAFilterRes.filterSettings : { opacity: 1.0, brightness: 0.0 };
        priorState.slotBFilterSettings = slotBFilterRes ? slotBFilterRes.filterSettings : { opacity: 1.0, brightness: 0.0 };

        const [slotAItemsRes, slotBItemsRes] = await Promise.all([
          this.client.request('GetSceneItemList', { sceneUuid: slotA.uuid }),
          this.client.request('GetSceneItemList', { sceneUuid: slotB.uuid })
        ]);
        const slotAItems = slotAItemsRes.sceneItems || [];
        const slotBItems = slotBItemsRes.sceneItems || [];

        if (slotAItems.length > 0) {
          const item = slotAItems[0];
          const trans = await this.client.request('GetSceneItemTransform', { sceneUuid: slotA.uuid, sceneItemId: item.sceneItemId });
          priorState.slotAItem = {
            sourceUuid: item.sourceUuid,
            sceneItemId: item.sceneItemId,
            enabled: item.sceneItemEnabled,
            transform: trans.sceneItemTransform
          };
        }
        if (slotBItems.length > 0) {
          const item = slotBItems[0];
          const trans = await this.client.request('GetSceneItemTransform', { sceneUuid: slotB.uuid, sceneItemId: item.sceneItemId });
          priorState.slotBItem = {
            sourceUuid: item.sourceUuid,
            sceneItemId: item.sceneItemId,
            enabled: item.sceneItemEnabled,
            transform: trans.sceneItemTransform
          };
        }

        // Fresh GetInputList check
        const inputsRes = await this.client.request('GetInputList');
        const freshAllInputs = inputsRes.inputs || [];
        
        const leftInput = freshAllInputs.find((inp) => inp.inputUuid === leftUuid);
        const rightInput = freshAllInputs.find((inp) => inp.inputUuid === rightUuid);

        if (!leftInput || !isValidVideoInput(leftInput, this.binding)) {
          throw new Error(`EmberstageNativeCamera: Left input UUID '${leftUuid}' is invalid or does not exist in OBS.`);
        }
        if (!rightInput || !isValidVideoInput(rightInput, this.binding)) {
          throw new Error(`EmberstageNativeCamera: Right input UUID '${rightUuid}' is invalid or does not exist in OBS.`);
        }

        this.allInputs = freshAllInputs.filter((item) => isValidVideoInput(item, this.binding));
        this.inputs = this.allInputs;
        this.currentFit = fit;

        const prefersReducedMotion = typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
        const isCut = transition === 'cut' || prefersReducedMotion;

        // 2. Fade/Dip transition: fade out prior active slot(s) first
        if (!isCut && priorLive) {
          const slotsToFadeOut = priorDual ? this.binding.slots : [this.binding.slots[priorActiveSlotIndex]];
          const fadeOutDuration = duration / 2;
          const startOut = Date.now();
          while (true) {
            if (!this.initialized || !this.verified) {
              throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
            }
            const elapsed = Date.now() - startOut;
            const t = Math.min(1.0, elapsed / fadeOutDuration);

            let opacity = 1.0 - t;
            let brightness = 0.0;

            if (transition === 'dip') {
              opacity = 1.0 - t;
              brightness = -t * 2;
            }

            await Promise.all(slotsToFadeOut.map(slot =>
              this.client.request('SetSourceFilterSettings', {
                sourceUuid: slot.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: { opacity, brightness }
              })
            ));

            if (t >= 1.0) {
              break;
            }
            await new Promise((res) => setTimeout(res, 30));
          }
        }

        // 3. Prepare both slots with target inputs
        let itemAId = null;
        if (slotAItems.length === 1 && slotAItems[0].sourceUuid === leftUuid) {
          itemAId = slotAItems[0].sceneItemId;
        } else {
          for (const item of slotAItems) {
            await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: item.sceneItemId });
          }
        }

        let itemBId = null;
        if (slotBItems.length === 1 && slotBItems[0].sourceUuid === rightUuid) {
          itemBId = slotBItems[0].sceneItemId;
        } else {
          for (const item of slotBItems) {
            await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: item.sceneItemId });
          }
        }

        if (itemAId === null) {
          const createA = await this.client.request('CreateSceneItem', {
            sceneUuid: slotA.uuid,
            sourceUuid: leftUuid,
            sceneItemEnabled: false
          });
          itemAId = createA.sceneItemId;
        }
        if (itemBId === null) {
          const createB = await this.client.request('CreateSceneItem', {
            sceneUuid: slotB.uuid,
            sourceUuid: rightUuid,
            sceneItemEnabled: false
          });
          itemBId = createB.sceneItemId;
        }

        const canvasWidth = this.baseWidth;
        const canvasHeight = this.baseHeight;

        let slotAOuterTransform = {
          positionX: 0,
          positionY: 0,
          boundsType: 'OBS_BOUNDS_NONE',
          scaleX: 1.0,
          scaleY: 1.0,
          cropTop: 0,
          cropBottom: 0,
          cropLeft: 0,
          cropRight: 0
        };
        let slotAInnerTransform = {
          positionX: 0,
          positionY: 0,
          boundsType: fit === 'cover' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER',
          boundsWidth: canvasWidth,
          boundsHeight: canvasHeight,
          cropToBounds: true,
          alignment: 5
        };

        let slotBOuterTransform = {
          positionX: 0,
          positionY: 0,
          boundsType: 'OBS_BOUNDS_NONE',
          scaleX: 1.0,
          scaleY: 1.0,
          cropTop: 0,
          cropBottom: 0,
          cropLeft: 0,
          cropRight: 0
        };
        let slotBInnerTransform = {
          positionX: 0,
          positionY: 0,
          boundsType: fit === 'cover' ? 'OBS_BOUNDS_SCALE_OUTER' : 'OBS_BOUNDS_SCALE_INNER',
          boundsWidth: canvasWidth,
          boundsHeight: canvasHeight,
          cropToBounds: true,
          alignment: 5
        };

        if (layout === 'split') {
          slotAInnerTransform.boundsWidth = canvasWidth / 2;
          slotAInnerTransform.boundsHeight = canvasHeight;

          slotBOuterTransform.positionX = canvasWidth / 2;
          slotBOuterTransform.positionY = 0;
          slotBInnerTransform.boundsWidth = canvasWidth / 2;
          slotBInnerTransform.boundsHeight = canvasHeight;
        } else if (layout === 'inset') {
          slotAInnerTransform.boundsWidth = canvasWidth;
          slotAInnerTransform.boundsHeight = canvasHeight;

          const helper = getLayoutHelper();
          const geom = helper.getLayoutGeometry('camera-inset', corner);
          const B_x = (geom.camera.left / 100) * canvasWidth;
          const B_y = (geom.camera.top / 100) * canvasHeight;
          const B_w = (geom.camera.width / 100) * canvasWidth;
          const B_h = (geom.camera.height / 100) * canvasHeight;

          slotBOuterTransform.positionX = B_x;
          slotBOuterTransform.positionY = B_y;
          slotBInnerTransform.boundsWidth = B_w;
          slotBInnerTransform.boundsHeight = B_h;
        }

        // Apply program scene item transforms
        await Promise.all([
          this.client.request('SetSceneItemTransform', {
            sceneUuid: this.binding.program.uuid,
            sceneItemId: slotAItemId,
            sceneItemTransform: slotAOuterTransform
          }),
          this.client.request('SetSceneItemTransform', {
            sceneUuid: this.binding.program.uuid,
            sceneItemId: slotBItemId,
            sceneItemTransform: slotBOuterTransform
          })
        ]);

        // Apply slot scene item transforms
        await Promise.all([
          this.client.request('SetSceneItemTransform', {
            sceneUuid: slotA.uuid,
            sceneItemId: itemAId,
            sceneItemTransform: slotAInnerTransform
          }),
          this.client.request('SetSceneItemTransform', {
            sceneUuid: slotB.uuid,
            sceneItemId: itemBId,
            sceneItemTransform: slotBInnerTransform
          })
        ]);

        // Establish compositing z-order
        const programItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: this.binding.program.uuid });
        const items = programItemsRes.sceneItems || [];
        const itemA = items.find(it => it.sceneItemId === slotAItemId);
        const itemB = items.find(it => it.sceneItemId === slotBItemId);
        const itemGraphics = items.find(it => it.sceneItemId === graphicsItemId);

        if (!itemA || !itemB || !itemGraphics) {
          throw new Error('EmberstageNativeCamera: Failed to find required scene items in program.');
        }

        const priorAIndex = itemA.sceneItemIndex;
        const priorBIndex = itemB.sceneItemIndex;
        const priorGraphicsIndex = itemGraphics.sceneItemIndex;

        const sortedIndices = [priorAIndex, priorBIndex, priorGraphicsIndex].sort((a, b) => a - b);
        const targetAIndex = sortedIndices[0];
        const targetBIndex = sortedIndices[1];
        const targetGraphicsIndex = sortedIndices[2];

        const orderToApply = [
          { id: slotAItemId, idx: targetAIndex },
          { id: slotBItemId, idx: targetBIndex },
          { id: graphicsItemId, idx: targetGraphicsIndex }
        ].sort((a, b) => a.idx - b.idx);

        for (const item of orderToApply) {
          await this.client.request('SetSceneItemIndex', {
            sceneUuid: this.binding.program.uuid,
            sceneItemId: item.id,
            sceneItemIndex: item.idx
          });
        }

        if (!isCut) {
          // Set filters to 0.0 sequentially BEFORE enabling anything inside slots to avoid flashes
          await Promise.all([
            this.client.request('SetSourceFilterSettings', {
              sourceUuid: slotA.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 0.0, brightness: transition === 'dip' ? -2.0 : 0.0 }
            }),
            this.client.request('SetSourceFilterSettings', {
              sourceUuid: slotB.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 0.0, brightness: transition === 'dip' ? -2.0 : 0.0 }
            })
          ]);
        }

        // Enable inputs inside slots
        await Promise.all([
          this.client.request('SetSceneItemEnabled', { sceneUuid: slotA.uuid, sceneItemId: itemAId, sceneItemEnabled: true }),
          this.client.request('SetSceneItemEnabled', { sceneUuid: slotB.uuid, sceneItemId: itemBId, sceneItemEnabled: true })
        ]);

        if (isCut) {
          await Promise.all([
            this.client.request('SetSourceFilterSettings', {
              sourceUuid: slotA.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 1.0, brightness: 0.0 }
            }),
            this.client.request('SetSourceFilterSettings', {
              sourceUuid: slotB.uuid,
              filterName: 'Emberstage Opacity',
              filterSettings: { opacity: 1.0, brightness: 0.0 }
            }),
            this.client.request('SetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItemId, sceneItemEnabled: true }),
            this.client.request('SetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItemId, sceneItemEnabled: true })
          ]);
        } else {
          await Promise.all([
            this.client.request('SetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotAItemId, sceneItemEnabled: true }),
            this.client.request('SetSceneItemEnabled', { sceneUuid: this.binding.program.uuid, sceneItemId: slotBItemId, sceneItemEnabled: true })
          ]);

          const fadeInDuration = priorLive ? duration / 2 : duration;
          const startIn = Date.now();
          while (true) {
            if (!this.initialized || !this.verified) {
              throw new Error('EmberstageNativeCamera: Instance disposed or unverified during transition.');
            }

            const elapsed = Date.now() - startIn;
            const t = Math.min(1.0, elapsed / fadeInDuration);

            let opacity = t;
            let brightness = 0.0;

            if (transition === 'dip') {
              opacity = t;
              brightness = -(1.0 - t) * 2;
            }

            await Promise.all([
              this.client.request('SetSourceFilterSettings', {
                sourceUuid: slotA.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: { opacity, brightness }
              }),
              this.client.request('SetSourceFilterSettings', {
                sourceUuid: slotB.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: { opacity, brightness }
              })
            ]);

            if (t >= 1.0) {
              break;
            }
            await new Promise((res) => setTimeout(res, 30));
          }
        }

        this.dual = true;
        this.activeLeftUuid = leftUuid;
        this.activeRightUuid = rightUuid;
        this.dualLayout = layout;
        this.dualCorner = corner;
        this.live = true;

      } catch (err) {
        this.live = priorLive;
        this.dual = priorDual;
        this.activeLeftUuid = priorActiveLeft;
        this.activeRightUuid = priorActiveRight;
        this.activeSlotIndex = priorActiveSlotIndex;
        this.activeInputUuid = priorActiveInputUuid;
        this.dualLayout = priorDualLayout;
        this.dualCorner = priorDualCorner;

        if (this.initialized && this.verified) {
          try {
            // Restore Slot A items
            const currentAItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: slotA.uuid });
            const currentAItems = currentAItemsRes.sceneItems || [];
            if (priorState.slotAItem) {
              const match = currentAItems.find(it => it.sourceUuid === priorState.slotAItem.sourceUuid);
              if (match) {
                await this.client.request('SetSceneItemTransform', {
                  sceneUuid: slotA.uuid,
                  sceneItemId: match.sceneItemId,
                  sceneItemTransform: priorState.slotAItem.transform
                });
                await this.client.request('SetSceneItemEnabled', {
                  sceneUuid: slotA.uuid,
                  sceneItemId: match.sceneItemId,
                  sceneItemEnabled: priorState.slotAItem.enabled
                });
                for (const it of currentAItems) {
                  if (it.sceneItemId !== match.sceneItemId) {
                    await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: it.sceneItemId });
                  }
                }
              } else {
                for (const it of currentAItems) {
                  await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: it.sceneItemId });
                }
                const createA = await this.client.request('CreateSceneItem', {
                  sceneUuid: slotA.uuid,
                  sourceUuid: priorState.slotAItem.sourceUuid,
                  sceneItemEnabled: priorState.slotAItem.enabled
                });
                await this.client.request('SetSceneItemTransform', {
                  sceneUuid: slotA.uuid,
                  sceneItemId: createA.sceneItemId,
                  sceneItemTransform: priorState.slotAItem.transform
                });
              }
            } else {
              for (const it of currentAItems) {
                await this.client.request('RemoveSceneItem', { sceneUuid: slotA.uuid, sceneItemId: it.sceneItemId });
              }
            }

            // Restore Slot B items
            const currentBItemsRes = await this.client.request('GetSceneItemList', { sceneUuid: slotB.uuid });
            const currentBItems = currentBItemsRes.sceneItems || [];
            if (priorState.slotBItem) {
              const match = currentBItems.find(it => it.sourceUuid === priorState.slotBItem.sourceUuid);
              if (match) {
                await this.client.request('SetSceneItemTransform', {
                  sceneUuid: slotB.uuid,
                  sceneItemId: match.sceneItemId,
                  sceneItemTransform: priorState.slotBItem.transform
                });
                await this.client.request('SetSceneItemEnabled', {
                  sceneUuid: slotB.uuid,
                  sceneItemId: match.sceneItemId,
                  sceneItemEnabled: priorState.slotBItem.enabled
                });
                for (const it of currentBItems) {
                  if (it.sceneItemId !== match.sceneItemId) {
                    await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: it.sceneItemId });
                  }
                }
              } else {
                for (const it of currentBItems) {
                  await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: it.sceneItemId });
                }
                const createB = await this.client.request('CreateSceneItem', {
                  sceneUuid: slotB.uuid,
                  sourceUuid: priorState.slotBItem.sourceUuid,
                  sceneItemEnabled: priorState.slotBItem.enabled
                });
                await this.client.request('SetSceneItemTransform', {
                  sceneUuid: slotB.uuid,
                  sceneItemId: createB.sceneItemId,
                  sceneItemTransform: priorState.slotBItem.transform
                });
              }
            } else {
              for (const it of currentBItems) {
                await this.client.request('RemoveSceneItem', { sceneUuid: slotB.uuid, sceneItemId: it.sceneItemId });
              }
            }

            // Restore prior indexes on rollback
            const toRestore = [
              { id: slotAItemId, idx: priorAIndex },
              { id: slotBItemId, idx: priorBIndex },
              { id: graphicsItemId, idx: priorGraphicsIndex }
            ].sort((a, b) => a.idx - b.idx);
            for (const item of toRestore) {
              await this.client.request('SetSceneItemIndex', {
                sceneUuid: this.binding.program.uuid,
                sceneItemId: item.id,
                sceneItemIndex: item.idx
              });
            }

            // Restore outer program properties
            await Promise.all([
              this.client.request('SetSceneItemTransform', {
                sceneUuid: this.binding.program.uuid,
                sceneItemId: slotAItemId,
                sceneItemTransform: priorState.slotAProgramTransform
              }),
              this.client.request('SetSceneItemTransform', {
                sceneUuid: this.binding.program.uuid,
                sceneItemId: slotBItemId,
                sceneItemTransform: priorState.slotBProgramTransform
              }),
              this.client.request('SetSceneItemEnabled', {
                sceneUuid: this.binding.program.uuid,
                sceneItemId: slotAItemId,
                sceneItemEnabled: priorState.slotAProgramEnabled
              }),
              this.client.request('SetSceneItemEnabled', {
                sceneUuid: this.binding.program.uuid,
                sceneItemId: slotBItemId,
                sceneItemEnabled: priorState.slotBProgramEnabled
              }),
              this.client.request('SetSourceFilterSettings', {
                sourceUuid: slotA.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: priorState.slotAFilterSettings
              }),
              this.client.request('SetSourceFilterSettings', {
                sourceUuid: slotB.uuid,
                filterName: 'Emberstage Opacity',
                filterSettings: priorState.slotBFilterSettings
              })
            ]);
          } catch (_) {
            this.verified = false;
          }
        }
        throw err;
      } finally {
        this.transitioning = false;
      }
    }

    async screenshot(inputUuid) {
      if (!this.initialized) {
        throw new Error('EmberstageNativeCamera: Client is disposed or not initialized.');
      }
      if (!this.verified) {
        throw new Error('EmberstageNativeCamera: Client is not verified.');
      }
      if (this.transitioning) {
        throw new Error('EmberstageNativeCamera: Cannot take screenshot while transition in progress.');
      }

      const exists = this.allInputs.some((inp) => inp.inputUuid === inputUuid);
      if (!exists) {
        throw new Error(`EmberstageNativeCamera: Input UUID '${inputUuid}' is invalid or does not exist in OBS.`);
      }

      const res = await this.client.request('GetSourceScreenshot', {
        sourceUuid: inputUuid,
        imageFormat: 'jpeg',
        imageWidth: 320,
        imageCompressionQuality: 60
      });

      return res.imageData;
    }

    dispose() {
      this.initialized = false;
      this.verified = false;
      this.transitioning = false;
      this.inputs = [];
      this.allInputs = [];
      this.dualLayout = null;
      this.dualCorner = null;
      if (this.unsubscribes) {
        for (const unsub of this.unsubscribes) unsub();
        this.unsubscribes = [];
      }
    }
  }

  root.EmberstageNativeCamera = EmberstageNativeCamera;
  if (typeof module !== 'undefined') {
    module.exports = EmberstageNativeCamera;
  }
})(typeof window !== 'undefined' ? window : globalThis);
