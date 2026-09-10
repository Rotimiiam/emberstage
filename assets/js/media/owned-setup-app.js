(function () {
  'use strict';
  const app = document.getElementById('media-app');
  const media = new BroadcastChannel('emberstage-media-v1');
  const camera = new BroadcastChannel('emberstage-camera-v1');
  const states = { media: 'checking', camera: 'checking' };
  const el = (tag, className, text) => { const node = document.createElement(tag); if (className) node.className = className; if (text !== undefined) node.textContent = text; return node; };
  const header = el('header', 'deckbar');
  const brand = el('div', 'dock-brand-lockup');
  const brandLogo = document.createElement('img'); brandLogo.className = 'ember-brand-logo'; brandLogo.src = 'assets/brand/emberstage-logo.svg'; brandLogo.alt = '';
  const brandStack = el('div', 'dock-brand-stack');
  const brandWordmark = document.createElement('img'); brandWordmark.className = 'ember-brand-wordmark'; brandWordmark.src = 'assets/brand/emberstage-wordmark.svg'; brandWordmark.alt = 'Emberstage for OBS';
  brandStack.append(brandWordmark, el('span', 'dock-brand-kicker', 'Setup dock'));
  brand.append(brandLogo, brandStack);
  header.append(brand, el('h1', '', 'Output status'), el('span', 'badge on', 'LOCAL')); app.append(header);
  const grid = el('div', 'setup-scroll'); const panel = el('section', 'setup-section wide'); grid.append(panel); app.append(grid);
  const heading = el('h2'); heading.append(el('span', 'step', 'AUTO'), document.createTextNode('Emberstage-owned outputs')); panel.append(heading);
  panel.append(el('p', '', 'Text, pictures, videos and cameras are sent directly to dedicated Emberstage browser outputs. No WebSocket address or password is required.'));
  const list = el('div', 'mapping-list'); panel.append(list);
  function render() {
    list.replaceChildren();
    for (const [name, state] of [['Text output', 'ready'], ['Media output', states.media], ['Camera output', states.camera]]) {
      const row = el('div', 'mapping-row'); const copy = el('span', 'source-copy'); copy.append(el('span', 'source-name', name), el('span', 'source-meta', state === 'checking' ? 'Waiting for output' : state));
      row.append(copy, el('span', `badge${['ready', 'live', 'hidden'].includes(state) ? ' on' : ''}`, state.toUpperCase())); list.append(row);
    }
  }
  media.onmessage = ({ data }) => { if (data?.version === 1 && ['ready', 'status'].includes(data.type)) { states.media = data.type === 'ready' ? 'ready' : data.state; render(); } };
  camera.onmessage = ({ data }) => { if (data?.version === 1 && ['ready', 'status'].includes(data.type)) { states.camera = data.type === 'ready' ? 'ready' : data.state; render(); } };
  media.postMessage({ version: 1, type: 'ping' }); camera.postMessage({ version: 1, type: 'ping' });
  setTimeout(() => { render(); }, 750);
  addEventListener('pagehide', () => { media.close(); camera.close(); });
  render();
})();
