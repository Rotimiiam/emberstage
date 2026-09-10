(function () {
  'use strict';
  const app = document.getElementById('media-app');
  const channel = new BroadcastChannel('emberstage-media-v1');
  const items = [];
  const objectUrls = new Map();
  let selected = -1;
  let outputState = 'waiting', liveId = '';
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const button = (text, action, className = '') => { const node = el('button', className, text); node.type = 'button'; node.addEventListener('click', action); return node; };

  function getObjectUrl(item) {
    if (!objectUrls.has(item.id)) objectUrls.set(item.id, URL.createObjectURL(item.file));
    return objectUrls.get(item.id);
  }

  function releaseObjectUrls() {
    for (const url of objectUrls.values()) URL.revokeObjectURL(url);
    objectUrls.clear();
  }

  function previewFrame(item, index) {
    const frame = el('span', `source-preview source-preview-${item.kind}`);
    frame.setAttribute('aria-hidden', 'true');
    const indexChip = el('span', 'source-preview-index', String(index + 1).padStart(2, '0'));
    const note = el('span', 'source-preview-note', item.kind === 'image' ? 'Picture' : 'Preview');
    const url = getObjectUrl(item);

    if (item.kind === 'image') {
      const image = document.createElement('img');
      image.alt = '';
      image.decoding = 'async';
      image.src = url;
      frame.append(image, indexChip, note);
      return frame;
    }

    const video = document.createElement('video');
    video.muted = true;
    video.defaultMuted = true;
    video.autoplay = true;
    video.loop = true;
    video.playsInline = true;
    video.preload = 'metadata';
    video.src = url;
    video.setAttribute('aria-hidden', 'true');
    video.disablePictureInPicture = true;
    video.addEventListener('loadeddata', () => video.play().catch(() => {}), { once: true });
    frame.append(video, indexChip, note);
    return frame;
  }

  const header = el('header', 'deckbar');
  const brand = el('div', 'dock-brand-lockup');
  const brandLogo = document.createElement('img'); brandLogo.className = 'ember-brand-logo'; brandLogo.src = 'assets/brand/emberstage-logo.svg'; brandLogo.alt = '';
  const brandStack = el('div', 'dock-brand-stack');
  const brandWordmark = document.createElement('img'); brandWordmark.className = 'ember-brand-wordmark'; brandWordmark.src = 'assets/brand/emberstage-wordmark.svg'; brandWordmark.alt = 'Emberstage for OBS';
  brandStack.append(brandWordmark, el('span', 'dock-brand-kicker', 'Media dock'));
  brand.append(brandLogo, brandStack);
  header.append(brand, el('h1', '', 'Media'));
  const state = el('span', 'badge', 'OUTPUT'); header.append(state);
  const add = el('label', 'primary media-add', 'Add media');
  const input = el('input'); input.type = 'file'; input.multiple = true; input.hidden = true; add.append(input); header.append(add); app.append(header);
  const notice = el('div', 'notice'); notice.hidden = true; app.append(notice);
  const list = el('div', 'source-list owned-library'); list.setAttribute('aria-label', 'Emberstage media library'); app.append(list);
  const footer = el('footer', 'actionbar'); const selection = el('div', 'selection', 'Choose media');
  const fitLabel = el('label', 'check'); const fit = el('input'); fit.type = 'checkbox'; fitLabel.append(fit, document.createTextNode('Fill'));
  const muteLabel = el('label', 'check'); const mute = el('input'); mute.type = 'checkbox'; mute.checked = false; muteLabel.append(mute, document.createTextNode('Mute video'));
  const take = button('Show media', () => {
    const item = items[selected]; if (!item) return;
    if (outputState === 'live' && liveId === item.id) {
      channel.postMessage({ version: 1, type: 'hide' });
      return;
    }
    channel.postMessage({ version: 1, type: 'show', id: item.id, kind: item.kind, blob: item.file, fit: fit.checked ? 'cover' : 'contain', muted: mute.checked, loop: true });
  }, 'primary');
  footer.append(selection, fitLabel, muteLabel, take); app.append(footer);

  function render() {
    const focusedId = document.activeElement?.closest?.('.source-row')?.dataset.mediaId || '';
    list.replaceChildren();
    if (!items.length) {
      const empty = el('div', 'empty'); empty.append(el('strong', '', 'Add pictures or videos'), el('small', '', 'Files stay local and play through Emberstage Media Output.')); list.append(empty);
    }
    items.forEach((item, index) => {
      const row = button('', () => { selected = index; render(); }, 'source-row'); row.setAttribute('aria-pressed', String(index === selected));
      row.dataset.mediaId = item.id;
      row.addEventListener('keydown', event => {
        if (event.key !== 'Enter' && event.key !== ' ') return;
        event.preventDefault(); event.stopPropagation();
        if (selected !== index) {
          selected = index; render();
          requestAnimationFrame(() => list.querySelector(`[data-media-id="${item.id}"]`)?.focus());
          return;
        }
        take.click();
      });
      row.append(previewFrame(item, index));
      const copy = el('span', 'source-copy'); copy.append(el('span', 'source-name', item.name), el('span', 'source-meta', item.kind === 'image' ? 'Picture' : 'Video'));
      const rowState = liveId === item.id && outputState === 'live' ? 'LIVE' : index === selected ? 'SELECTED' : item.kind.toUpperCase();
      row.append(copy, el('span', `badge${rowState === 'LIVE' ? ' on' : ''}`, rowState)); list.append(row);
    });
    const item = items[selected]; selection.textContent = item?.name || 'Choose media'; take.disabled = !item || outputState === 'waiting';
    take.textContent = outputState === 'live' && item?.id === liveId ? 'Hide media' : 'Show media';
    state.textContent = outputState === 'live' ? 'LIVE' : outputState === 'hidden' ? 'HIDDEN' : outputState === 'switching' ? 'LOADING' : outputState === 'error' ? 'MEDIA ERROR' : 'WAITING'; state.classList.toggle('on', outputState === 'live');
    if (focusedId) requestAnimationFrame(() => list.querySelector(`[data-media-id="${focusedId}"]`)?.focus({ preventScroll: true }));
  }

  input.addEventListener('change', () => {
    const skipped = [];
    for (const file of input.files) {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const imageExtension = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'avif'].includes(extension);
      const videoExtension = ['mp4', 'm4v', 'webm', 'ogv', 'mov'].includes(extension);
      const kind = file.type.startsWith('image/') || imageExtension ? 'image' : file.type.startsWith('video/') || videoExtension ? 'video' : '';
      if (kind) items.push({ id: crypto.randomUUID(), name: file.name, kind, file });
      else skipped.push(file.name);
    }
    notice.textContent = skipped.length ? `Could not add ${skipped.join(', ')}. Use MP4 (H.264/AAC), WebM, or Ogg video.` : '';
    notice.hidden = skipped.length === 0;
    if (selected < 0 && items.length) selected = 0;
    input.value = ''; render();
  });
  channel.onmessage = ({ data }) => {
    if (data?.version !== 1) return;
    if (data.type === 'ready') { outputState = 'hidden'; render(); }
    if (data.type === 'status') {
      outputState = data.state; liveId = data.id || liveId;
      if (data.state === 'error') {
        notice.textContent = 'This video codec cannot play in the OBS browser. Convert it to MP4 with H.264 video and AAC audio, then add it again.';
        notice.hidden = false;
      }
      render();
    }
  };
  add.tabIndex = 0;
  add.addEventListener('keydown', event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); input.click(); } });
  channel.postMessage({ version: 1, type: 'ping' });
  addEventListener('pagehide', () => { releaseObjectUrls(); channel.close(); });
  render();
})();
