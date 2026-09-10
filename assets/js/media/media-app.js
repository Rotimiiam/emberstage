(function () {
  'use strict';
  const demo = new URLSearchParams(location.search).get('demo') === '1';
  const page = document.body.dataset.deck;
  const title = { mixer: 'Legacy mixer', pictures: 'Legacy pictures', media: 'Media', cameras: 'Cameras', setup: 'Setup' }[page];
  const app = document.getElementById('media-app');
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, className = '') => { const node = el('button', className, text); node.type = 'button'; if (action) node.addEventListener('click', action); return node; };
  const help = (label, ...paragraphs) => {
    const details = el('details', 'help'); details.append(el('summary', '', label));
    const content = el('div', 'help-content');
    for (const text of paragraphs) content.append(el('p', '', text));
    details.append(content); return details;
  };
  let storage;
  try { storage = demo ? null : window.localStorage; } catch (_) { /* Read-only browser context. */ }
  const settings = new MediaDeck.Settings({ storage, demo, events: window });
  const client = demo ? new DemoOBS() : new OBSClient();
  const deck = new MediaDeck.Deck(client, settings);
  const shots = new MediaDeck.Screenshots(client);
  let category = page === 'pictures' ? 'pictures' : page === 'media' ? 'videos' : 'cameras';
  const isMediaDock = page === 'media';
  const isCameraDock = page === 'cameras';
  const isListDock = ['mixer', 'media', 'cameras'].includes(page);
  const isPictureGrid = page === 'pictures';
  let filter = '', thumbnails = false, running = false, refreshing = false, refreshAgain = false, refreshTimer;
  let previewToken = 0, observer, mediaStatus = '', statusState = 'disconnected';
  let reviewChoices = {};
  app.replaceChildren();

  const bar = el('header', 'deckbar');
  const brand = el('div', 'dock-brand-lockup');
  const brandLogo = document.createElement('img'); brandLogo.className = 'ember-brand-logo'; brandLogo.src = 'assets/brand/emberstage-logo.svg'; brandLogo.alt = '';
  const brandStack = el('div', 'dock-brand-stack');
  const brandWordmark = document.createElement('img'); brandWordmark.className = 'ember-brand-wordmark'; brandWordmark.src = 'assets/brand/emberstage-wordmark.svg'; brandWordmark.alt = 'Emberstage for OBS';
  brandStack.append(brandWordmark, el('span', 'dock-brand-kicker', `${title} dock`));
  brand.append(brandLogo, brandStack);
  bar.append(brand, el('h1', '', title));
  if (demo) { const badge = el('span', 'badge demo', 'DEMO'); badge.title = 'Isolated fixtures. No OBS connection or saved settings.'; bar.append(badge); }
  const targetWrap = el('label', 'target-wrap');
  targetWrap.append(el('span', 'muted target-label', 'Output'));
  const target = el('select'); target.setAttribute('aria-label', 'Shared output scene');
  targetWrap.append(target); bar.append(targetWrap);
  const programBadge = el('span', 'badge program-badge'); bar.append(programBadge);
  const connection = button('', () => {
    if (demo) return;
    dialog.showModal(); form.querySelector('input[type=password]').focus();
  }, 'connection');
  bar.append(connection);
  const setupLink = el('a', 'setup-link', page === 'setup' ? 'Mixer' : 'Setup');
  setupLink.href = (page === 'setup' ? 'video_mixer.html' : 'media_setup.html') + (demo ? '?demo=1' : ''); bar.append(setupLink);
  if (page !== 'setup') {
    const guide = help('Help',
      'Select a source to preview it. Take changes only included sources in the same category; it does not switch scenes. Review mappings in Setup.',
      'Media contains videos and pictures. Cameras stay in their own dock. Selecting never changes output; Take or Show is always explicit.',
      'Show adds a picture. Exclusive hides other included Pictures; leave it off to preserve overlays and logos. Hide affects only the selected picture.',
      'Play, Pause, Stop and Restart affect that input in every scene that uses it. Snapshots and media times are sampled, not live video.',
      'Hidden groups, nested scenes and repeated containers may be blocked. Review the source path in Setup; do not include ambiguous items.',
      'OBS-wide hotkeys require a separately installed native Lua integration and bindings in OBS Settings → Hotkeys. These pages do not install it.');
    guide.classList.add('dock-help'); bar.append(guide);
  }
  app.append(bar);
  const notice = el('div', 'notice'); notice.setAttribute('role', 'status'); notice.hidden = true; app.append(notice);
  const announcement = el('span', 'sr-only'); announcement.setAttribute('role', 'status'); app.append(announcement);
  function conciseError(text) {
    if (/partial|unknown.*state|state is unknown/i.test(text)) return 'State uncertain. Check OBS before retrying.';
    if (/exclusive.*unsafe/i.test(text)) return 'Exclusive blocked. Review included sources in Setup.';
    if (/parent group.*hidden/i.test(text)) return 'Group hidden. Enable it in OBS, then refresh.';
    if (/nested|multiple containers/i.test(text)) return 'Source blocked. Review its path in Setup.';
    if (/identity changed|structure.*changed|target changed|scene.*changed/i.test(text)) return 'Source changed. Refresh and review in Setup.';
    if (/timed out/i.test(text)) return 'OBS timed out. Refresh before retrying.';
    if (/authentication failed/i.test(text)) return 'Wrong OBS password. Try again.';
    if (/failed \(OBS/i.test(text)) return 'OBS rejected the action. Refresh and check OBS.';
    return text;
  }
  function message(text, error = false) {
    notice.replaceChildren(); notice.hidden = !error || !text;
    announcement.textContent = error ? '' : text;
    if (error && text) {
      const short = conciseError(text); notice.setAttribute('role', 'alert'); notice.append(el('span', '', short));
      if (short !== text) notice.append(help('Details', text));
    }
  }
  function fail(error) { message(error?.message || 'Action failed. Check OBS, then refresh.', true); }

  const dialog = el('dialog'); dialog.setAttribute('aria-label', 'Connect to OBS');
  const dialogHead = el('div', 'dialog-head'); dialogHead.append(el('h2', '', 'Connect to OBS'), button('Close', () => dialog.close())); dialog.append(dialogHead);
  function connectionForm() {
    const form = el('form', 'connection-form');
    const urlLabel = el('label', 'field'); urlLabel.append(el('span', '', 'WebSocket address'));
    const url = el('input'); url.type = 'url'; url.required = true; url.value = settings.value.url; url.spellcheck = false; url.autocomplete = 'off'; urlLabel.append(url);
    const passwordLabel = el('label', 'field'); passwordLabel.append(el('span', '', 'OBS WebSocket password'));
    const password = el('input'); password.type = 'password'; password.autocomplete = 'off'; password.placeholder = 'OBS password'; passwordLabel.append(password);
    const remoteLabel = el('label', 'check'); const remote = el('input'); remote.type = 'checkbox'; remote.checked = settings.value.allowRemote;
    remoteLabel.append(remote, document.createTextNode('Allow remote wss://'));
    const error = el('div', 'form-error'); error.setAttribute('role', 'alert');
    const actions = el('div', 'form-actions'); const connect = button('Connect', null, 'primary'); connect.type = 'submit';
    const disconnect = button('Disconnect', () => { client.disconnect(); password.value = ''; shots.clear(); render(); }); actions.append(connect, disconnect);
    form.append(urlLabel, passwordLabel, remoteLabel, help('Password not saved', 'Your password stays in this page’s memory only. It is not saved, shared between docks, logged, or included in exports. Connect each dock separately. Connecting never changes OBS output.'), error, actions);
    form.addEventListener('submit', async event => {
      event.preventDefault(); if (demo) return;
      error.textContent = ''; connect.disabled = true;
      try {
        await client.connect({ url: url.value.trim(), password: password.value, allowRemote: remote.checked });
        password.value = '';
        settings.update({ url: url.value.trim(), allowRemote: remote.checked });
        shots.clear(); await refresh(); dialog.close();
      } catch (err) { error.textContent = conciseError(err.message); error.title = err.message; }
      finally { password.value = ''; connect.disabled = false; render(); }
    });
    if (demo) for (const input of form.querySelectorAll('input,button')) input.disabled = true;
    return form;
  }
  const form = connectionForm(); dialog.append(form); app.append(dialog);

  target.addEventListener('change', () => {
    const scene = deck.scenes.find(scene => (scene.sceneUuid || scene.sceneName) === target.value);
    try { deck.chooseScene(scene); reviewChoices = {}; shots.clear(); refresh(); } catch (error) { fail(error); }
  });
  async function refresh() {
    if (!client.ready) { render(); return; }
    if (refreshing || running) { refreshAgain = true; return; }
    refreshing = true; renderBar();
    try { await deck.refresh(); render(); }
    catch (error) { deck.items = []; deck.selectedKey = null; fail(error); render(); }
    finally {
      refreshing = false; renderBar(); renderActions(); renderMappings();
      if (refreshAgain && client.ready && !running) { refreshAgain = false; scheduleRefresh(); }
    }
  }
  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => { if (client.ready) refresh(); }, 180);
  }
  async function act(operation, success) {
    if (running || refreshing) return;
    running = true; message(''); renderBar(); renderActions();
    try { await operation(); message(success); }
    catch (error) { fail(error); }
    finally { running = false; render(); if (refreshAgain) { refreshAgain = false; scheduleRefresh(); } }
  }
  function renderBar() {
    app.classList.toggle('is-disconnected', !client.ready);
    target.replaceChildren(); const empty = el('option', '', 'Choose output…'); empty.value = ''; target.append(empty);
    for (const scene of deck.scenes) { const option = el('option', '', scene.sceneName); option.value = scene.sceneUuid || scene.sceneName; target.append(option); }
    target.value = deck.scene ? deck.scene.sceneUuid || deck.scene.sceneName : '';
    target.title = deck.scene?.sceneName || 'Shared output scene; selecting it does not switch program';
    target.disabled = !client.ready || running || refreshing;
    connection.replaceChildren(el('span', 'dot'), document.createTextNode(client.ready ? 'OBS' : statusState === 'connecting' ? 'Connecting…' : 'Connect'));
    connection.hidden = demo; connection.title = client.ready ? 'Connected to OBS · connection settings' : 'Connect to OBS'; connection.setAttribute('aria-label', connection.title);
    connection.classList.toggle('connected', client.ready); connection.disabled = demo;
    programBadge.textContent = deck.scene && deck.program === deck.scene.sceneName ? 'ON PROGRAM' : 'OFF PROGRAM';
    programBadge.classList.toggle('on', deck.scene?.sceneName === deck.program); programBadge.hidden = !client.ready || !deck.scene;
  }
  function displayedCategory(item) { return deck.reviewed(item) ? deck.category(item) : MediaDeck.classify(item.inputKind); }
  function reason(item) {
    if (!item) return 'Select source';
    if (item.blocked) return item.blocked;
    if (!deck.reviewed(item) || deck.category(item) === 'excluded') return 'Review in Setup';
    return item.sceneItemEnabled ? 'Enabled' : 'Hidden';
  }
  function emptyState() {
    const node = el('div', 'empty');
    if (!client.ready) {
      node.classList.add('disconnected-empty');
      const copy = el('span', 'empty-copy');
      copy.append(el('strong', '', 'Connect to OBS'), el('small', '', 'Load mapped sources from your local OBS session.'));
      node.append(copy, button('Connect', () => connection.click(), 'primary empty-connect'));
      return node;
    }
    node.append(el('strong', '', !client.ready ? 'Connect to OBS' : !deck.scene ? 'Choose output' : filter ? 'No matches' : 'No sources'));
    node.title = !client.ready ? 'Add sources in OBS, then connect.' : !deck.scene ? 'Choose the shared target above; this does not switch the program scene.' : 'Add sources in OBS or review categories in Setup.';
    return node;
  }
  let list, count, selection, take, hide, exclusive, preview, previewName, snapshotButton, transport, transportState;
  if (page !== 'setup') {
    const toolbar = el('div', 'toolbar');
    if (page === 'mixer' || isMediaDock) {
      const tabs = el('div', 'tabs'); tabs.setAttribute('aria-label', 'Source categories');
      const choices = isMediaDock ? [['videos', 'Videos'], ['pictures', 'Pictures']] : [['cameras', 'Cameras'], ['videos', 'Videos']];
      for (const [id, label] of choices) {
        const tab = button(label, () => { category = id; deck.select(null); mediaStatus = ''; previewToken++; render(); });
        tab.dataset.category = id; tabs.append(tab);
      }
      toolbar.append(tabs);
    }
    const search = el('input'); search.type = 'search'; search.placeholder = isPictureGrid ? 'Find a picture…' : isCameraDock ? 'Find a camera…' : 'Find a source…'; search.setAttribute('aria-label', 'Filter sources');
    search.addEventListener('input', () => { filter = search.value.toLowerCase(); renderList(); }); toolbar.append(search);
    count = el('span', 'counter'); toolbar.append(count);
    if (isPictureGrid) {
      const thumbLabel = el('label', 'check'); const thumbCheck = el('input'); thumbCheck.type = 'checkbox'; thumbCheck.checked = false;
      thumbCheck.addEventListener('change', () => { thumbnails = thumbCheck.checked; if (!thumbnails) shots.clear(); renderList(); }); thumbLabel.append(thumbCheck, document.createTextNode('Thumbnails')); toolbar.append(thumbLabel);
    }
    toolbar.append(button('Refresh', () => { shots.clear(); refresh(); }, 'quiet')); app.append(toolbar);
    if (isListDock) {
      const work = el('div', 'workarea'); list = el('div', 'source-list'); list.setAttribute('aria-label', 'Available sources');
      const panel = el('aside', 'preview'); preview = el('div', 'snapshot'); preview.setAttribute('aria-label', 'Local source snapshot');
      const caption = el('div', 'preview-caption'); previewName = el('span', 'badge', 'SNAPSHOT'); previewName.title = 'Still image, not live video'; previewName.setAttribute('aria-label', 'Snapshot, not live video'); snapshotButton = button('Update', () => updatePreview(true)); snapshotButton.title = 'Request a new snapshot'; caption.append(previewName, snapshotButton);
      transport = el('div', 'transport'); transport.hidden = true;
      for (const [action, label] of [['PLAY', 'Play'], ['PAUSE', 'Pause'], ['STOP', 'Stop'], ['RESTART', 'Restart']]) {
        const control = button(label, () => act(async () => { const status = await deck.transport(deck.selectedKey, action); mediaStatus = formatStatus(status); }, 'Media updated'));
        control.title = 'Controls this input in every scene that uses it'; control.setAttribute('aria-label', `${label} · affects this input in every scene`); transport.append(control);
      }
      transportState = el('span', 'transport-status'); transport.append(transportState);
      panel.append(preview, caption, transport); work.append(list, panel); app.append(work);
    } else { list = el('div', 'pictures-area'); list.setAttribute('aria-label', 'Available pictures'); app.append(list); }
    const actions = el('footer', 'actionbar'); selection = el('div', 'selection'); selection.setAttribute('aria-live', 'polite'); actions.append(selection);
    if (isPictureGrid || isMediaDock) {
      const exclusiveLabel = el('label', 'check'); exclusive = el('input'); exclusive.type = 'checkbox'; exclusive.checked = false;
      exclusiveLabel.append(exclusive, document.createTextNode('Exclusive')); exclusiveLabel.title = 'When showing a picture, hide only the other included Pictures. OFF preserves overlays and logos.'; exclusive.setAttribute('aria-label', 'Exclusive: Show hides other included Pictures. Leave off to preserve overlays and logos.'); actions.append(exclusiveLabel);
      hide = button('Hide', () => act(() => deck.visibility(deck.selectedKey, false), 'Hidden')); hide.title = 'Hide selected picture'; hide.setAttribute('aria-label', 'Hide selected picture'); actions.append(hide);
    }
    take = button(isPictureGrid ? 'Show' : 'Take', () => act(
      () => deck.visibility(deck.selectedKey, true, category === 'cameras' || category === 'videos' || exclusive.checked),
      'Visibility updated'), 'primary');
    take.title = isPictureGrid ? 'Show selected picture. Exclusive also hides other included Pictures.' : 'Show selected source and hide other included sources in this category. Does not switch scenes.';
    take.setAttribute('aria-label', `${take.textContent}. ${take.title}`); actions.append(take); app.append(actions);
  }
  function renderList() {
    if (!list) return;
    observer?.disconnect();
    const scroll = list.scrollTop;
    const focusKey = list.contains(document.activeElement) ? document.activeElement.dataset.key : null;
    list.replaceChildren();
    const items = client.ready ? deck.items.filter(item => displayedCategory(item) === category && `${item.sourceName} ${item.path.join(' ')}`.toLowerCase().includes(filter)) : [];
    count.textContent = `${items.length}`; count.title = `${items.length} sources; no fixed source limit`;
    if (!items.length) { list.append(emptyState()); return; }
    const grid = isPictureGrid ? el('div', 'picture-grid') : list;
    if (grid !== list) list.append(grid);
    if (isPictureGrid && thumbnails && 'IntersectionObserver' in window) {
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) if (entry.isIntersecting) {
          observer.unobserve(entry.target);
          const item = items.find(item => deck.key(item) === entry.target.dataset.key);
          if (item) loadThumbnail(entry.target, item);
        }
      }, { root: list, rootMargin: '30px' });
    }
    for (const [index, item] of items.entries()) {
      const key = deck.key(item);
      const row = button('', () => { deck.select(key); mediaStatus = ''; renderList(); renderActions(); updatePreview(); }, isPictureGrid ? 'picture' : 'source-row');
      row.dataset.key = key; row.setAttribute('aria-pressed', String(key === deck.selectedKey)); row.title = `${item.path.join(' / ')} · ${reason(item)}`; row.setAttribute('aria-label', `${item.sourceName} · ${reason(item)}`);
      if (isPictureGrid) {
        const thumb = el('span', `thumb${demo ? ' demo-art' : ''}`, String(index + 1).padStart(2, '0')); row.append(thumb);
        row.append(el('span', 'source-name', item.sourceName), el('span', `picture-state${item.sceneItemEnabled ? ' on' : ''}`, item.blocked ? 'Blocked' : !deck.reviewed(item) ? 'Review' : item.sceneItemEnabled ? 'Enabled' : 'Hidden'));
      } else {
        row.append(el('span', 'source-number', String(index + 1).padStart(2, '0')));
        const copy = el('span', 'source-copy'); copy.append(el('span', 'source-name', item.sourceName));
        if (item.path.length > 1) copy.append(el('span', 'source-meta', item.path.slice(0, -1).join(' / ')));
        row.append(copy, el('span', `badge${item.sceneItemEnabled ? ' on' : ''}`, item.blocked ? 'Blocked' : !deck.reviewed(item) ? 'Review' : item.sceneItemEnabled ? 'Enabled' : 'Hidden'));
      }
      grid.append(row);
      if (isPictureGrid && thumbnails) {
        if (observer) observer.observe(row); else if (index < 12) loadThumbnail(row, item);
      }
    }
    list.scrollTop = scroll;
    if (focusKey) for (const row of list.querySelectorAll('button')) if (row.dataset.key === focusKey) row.focus({ preventScroll: true });
  }
  async function loadThumbnail(row, item) {
    if (demo) return;
    const data = await shots.get(item.sourceName, `${deck.key(item)}:${MediaDeck.signature(item)}`);
    if (!data || !row.isConnected || !thumbnails) return;
    const image = el('img'); image.alt = ''; image.src = data; row.querySelector('.thumb').replaceChildren(image);
  }
  function formatStatus(status) {
    return `${(status.mediaState || 'Unknown').replace('OBS_MEDIA_STATE_', '').toLowerCase()} · ${Math.floor((status.mediaCursor || 0) / 1000)} / ${Math.floor((status.mediaDuration || 0) / 1000)}s`;
  }
  async function updatePreview(force = false) {
    if (!preview) return;
    const token = ++previewToken; const item = deck.selected();
    preview.replaceChildren(el('span', 'snapshot-copy', item ? 'Loading…' : 'Select source'));
    preview.classList.toggle('demo-art', demo && !!item);
    if (!item || !client.ready) return;
    if (demo) preview.replaceChildren(el('span', 'snapshot-copy', item.sourceName));
    const identity = `${deck.key(item)}:${MediaDeck.signature(item)}`;
    if (force) shots.cache.delete(identity);
    if (!demo) {
      const image = await shots.get(item.sourceName, identity);
      if (token !== previewToken || !client.ready) return;
      if (image) { const img = el('img'); img.alt = `Snapshot of ${item.sourceName}`; img.src = image; preview.replaceChildren(img); }
      else preview.replaceChildren(el('span', 'snapshot-copy', 'Snapshot unavailable'));
    }
    if (MediaDeck.nativeMedia(item.inputKind)) {
      try {
        const status = await client.request('GetMediaInputStatus', { inputName: item.sourceName });
        if (token === previewToken) { mediaStatus = formatStatus(status); renderActions(); }
      } catch (error) { if (token === previewToken) { mediaStatus = conciseError(error.message); renderActions(); } }
    }
  }
  function renderActions() {
    if (!selection) return;
    const item = client.ready ? deck.selected() : null;
    selection.replaceChildren(document.createTextNode(item?.sourceName || 'Select source'));
    if (item) selection.append(el('small', '', item.blocked ? 'Blocked · Setup' : reason(item)));
    selection.title = item ? `${item.sourceName} · ${reason(item)}` : '';
    selection.setAttribute('aria-label', item ? `${item.sourceName} · ${reason(item)}` : 'Select source');
    const disabled = running || refreshing || !item || !!item.blocked || deck.category(item) === 'excluded';
    take.disabled = disabled; if (hide) hide.disabled = disabled;
    if (isListDock) {
      take.textContent = running ? 'Working…' : category === 'cameras' ? 'Take camera' : category === 'videos' ? 'Take video' : 'Show picture';
      if (exclusive?.parentElement) exclusive.parentElement.hidden = category !== 'pictures';
      if (hide) hide.hidden = category !== 'pictures';
      snapshotButton.disabled = !item || !client.ready;
      transport.hidden = !item || !MediaDeck.nativeMedia(item.inputKind);
      for (const control of transport.querySelectorAll('button')) control.disabled = disabled;
      transportState.textContent = mediaStatus;
      transportState.title = 'Last sampled media status, not a live clock. Transport affects this input in every scene.';
    } else { take.textContent = running ? 'Working…' : 'Show'; }
    take.setAttribute('aria-label', `${take.textContent}. ${take.title}`);
  }
  let mappingList, reviewButton, mappingSummary;
  if (page === 'setup') {
    const scroll = el('div', 'setup-scroll'); const grid = el('div', 'setup-grid'); scroll.append(grid); app.append(scroll);
    function section(step, heading, wide = false) {
      const panel = el('section', `setup-section${wide ? ' wide' : ''}`); const h = el('h2'); h.append(el('span', 'step', step), document.createTextNode(heading)); panel.append(h); grid.append(panel); return panel;
    }
    const connectPanel = section('01', 'Connect');
    connectPanel.append(help('OBS setup', 'Add cameras, Media Sources, images and one browser source for Scripture + Songs in OBS. Enable Tools → WebSocket Server Settings.'));
    connectPanel.append(connectionForm());
    const mappingPanel = section('02', 'Review sources');
    mappingPanel.append(help('Mapping help', 'Choose the output scene above, check categories, then save. Unknown types stay excluded. Take hides only other included sources in its own category.', 'Nested scenes, repeated containers and hidden parent groups are blocked. Inspect the full source path before including an item; enable hidden groups in OBS before refreshing.'));
    mappingList = el('div', 'mapping-list'); mappingPanel.append(mappingList);
    const footer = el('div', 'mapping-footer'); mappingSummary = el('small');
    reviewButton = button('Save review', () => {
      try { deck.review(reviewChoices); message('Review saved'); renderMappings(); }
      catch (error) { fail(error); }
    }, 'primary'); footer.append(mappingSummary, button('Refresh', () => { reviewChoices = {}; refresh(); }), reviewButton); mappingPanel.append(footer);
    const docks = section('03', 'Add docks', true);
    docks.append(help('Install help', 'In OBS: Docks → Custom Browser Docks. Add each name and URL. Serve all docks and the browser output on the same localhost origin and browser storage context.', 'Place the shared browser source in your output scene. Set background opacity to 0 for transparent Scripture + Songs. Choosing a target here does not move or create sources.'));
    const urls = [
      ['Text', 'control_panel.html'], ['Media', 'media_dock.html'], ['Cameras', 'camera_dock.html'],
      ['Setup (optional)', 'media_setup.html'], ['Shared transparent output', 'browser_source.html']
    ];
    for (const [label, path] of urls) {
      const row = el('div', 'url-row'); const field = el('label'); field.append(document.createTextNode(label));
      const input = el('input'); input.readOnly = true; input.value = new URL(path, location.href).href; field.append(input); row.append(field);
      row.append(button('Copy', async () => {
        try { await navigator.clipboard.writeText(input.value); message(`${label} URL copied`); }
        catch (_) { input.focus(); input.select(); message('Press Ctrl+C to copy the selected URL.', true); }
      })); docks.append(row);
    }
    const hotkeys = section('04', 'Hotkeys', true);
    const details = el('details', 'help'); const summary = el('summary', '', 'Native integration required'); details.append(summary);
    details.append(el('p', '', 'OBS-wide shortcuts must be registered by a native OBS Lua script (obs_hotkey_register_frontend), then bound in OBS Settings → Hotkeys. These pages do not install a script or claim system-wide keyboard access. Browser shortcuts are not a replacement.'));
    const actions = el('div', 'hotkey-list');
    for (const label of ['Scripture: previous / next', 'Songs: previous / next section', 'Text output: show / hide', 'Media: take selected / show picture']) actions.append(el('span', '', label));
    details.append(actions, el('p', '', 'Planned binding groups above are a checklist, not active registrations. Only bind entries after your supported native integration appears in OBS. No hotkeys are silently assigned.'));
    hotkeys.append(details);
    const exportPanel = section('05', 'Settings', true);
    exportPanel.append(help('Export help', 'Exports contain the connection address, scene identity and source mappings, never your password. No account, billing, OAuth or platform streaming is configured here.'));
    exportPanel.append(button('Export settings', () => {
      const url = URL.createObjectURL(new Blob([settings.export()], { type: 'application/json' }));
      const link = el('a'); link.href = url; link.download = demo ? 'obs-docks-demo.json' : 'obs-docks-settings.json'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000); message('Settings exported');
    }));
  }
  function renderMappings() {
    if (!mappingList) return;
    mappingList.replaceChildren();
    if (!client.ready || !deck.scene || !deck.items.length) { mappingList.append(emptyState()); reviewButton.disabled = true; mappingSummary.textContent = ''; return; }
    const nextChoices = {};
    for (const item of deck.items) {
      const key = deck.key(item); const row = el('label', 'mapping-row'); const copy = el('span', 'source-copy');
      copy.append(el('span', 'source-name', item.sourceName));
      if (item.path.length > 1) copy.append(el('span', 'source-meta', item.path.slice(0, -1).join(' / ')));
      if (item.blocked) copy.append(help('Blocked', item.blocked));
      row.title = `${item.path.join(' / ')} · #${item.sceneItemId} · ${item.inputKind}`;
      const choice = el('select'); choice.setAttribute('aria-label', `Category for ${item.sourceName}, item ${item.sceneItemId}`);
      for (const [value, label] of [['excluded', 'Excluded'], ['cameras', 'Cameras'], ['videos', 'Videos'], ['pictures', 'Pictures']]) { const option = el('option', '', label); option.value = value; choice.append(option); }
      choice.value = item.blocked ? 'excluded' : reviewChoices[key] || (deck.reviewed(item) ? deck.category(item) : MediaDeck.classify(item.inputKind));
      choice.disabled = !!item.blocked; nextChoices[key] = choice.value;
      choice.addEventListener('change', () => { reviewChoices[key] = choice.value; mappingSummary.textContent = 'Unsaved review'; });
      row.append(copy, choice); mappingList.append(row);
    }
    reviewChoices = nextChoices; reviewButton.disabled = running || refreshing;
    mappingSummary.textContent = `${deck.items.length} sources · ${deck.items.filter(item => deck.reviewed(item)).length} reviewed`;
  }
  function render() {
    renderBar();
    for (const tab of app.querySelectorAll('[data-category]')) tab.setAttribute('aria-pressed', String(tab.dataset.category === category));
    renderList(); renderActions(); renderMappings();
    if (preview && (!deck.selected() || !client.ready)) { previewToken++; preview.classList.remove('demo-art'); preview.replaceChildren(el('span', 'snapshot-copy', 'Select source')); }
  }
  client.on('status', event => {
    statusState = event.state;
    if (event.state === 'disconnected') {
      previewToken++; shots.clear(); deck.items = []; deck.selectedKey = null; deck.scenes = []; deck.scene = null;
      if (page !== 'setup') message('Offline');
    }
    render();
  });
  client.on('event', event => {
    if (/Scene|Input|CurrentProgram|CurrentPreview/.test(event.type)) scheduleRefresh();
    if (/SceneCollection/.test(event.type)) { deck.selectedKey = null; shots.clear(); }
    if (/MediaInput/.test(event.type) && event.data.inputName === deck.selected()?.sourceName) {
      const name = event.data.inputName;
      client.request('GetMediaInputStatus', { inputName: name }).then(status => {
        if (deck.selected()?.sourceName === name) { mediaStatus = formatStatus(status); renderActions(); }
      }, fail);
    }
  });
  settings.on(() => {
    // Only shared local configuration changes; never connect or take a source here.
    reviewChoices = {}; deck.selectedKey = null; previewToken++;
    if (client.ready) scheduleRefresh(); else render();
  });
  window.addEventListener('pagehide', () => { clearTimeout(refreshTimer); observer?.disconnect(); client.disconnect(); });
  render();
  if (demo) {
    (async () => {
      await client.connect(); await deck.refresh(); deck.chooseScene(deck.scenes[0]); await deck.refresh();
      const choices = {}; for (const item of deck.items) choices[deck.key(item)] = MediaDeck.classify(item.inputKind);
      deck.review(choices); render();
    })().catch(fail);
  } else if (!storage) message('Storage unavailable. Settings cannot be saved or shared.', true);
})();
