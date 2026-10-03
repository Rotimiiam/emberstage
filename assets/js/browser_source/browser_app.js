function getMessageElements(messageId = 'messageDisplay') {
  const messageElem = document.getElementById(messageId);
  const containerElem = document.getElementById('container') || messageElem?.parentElement;

  return { messageElem, containerElem };
}

const MEASURE_NODE_ID = 'obs-bible-measure-node';

function getResponsiveFontCaps() {
  const viewportWidth = window.innerWidth || 1280;
  const viewportHeight = window.innerHeight || 720;

  const minFontSize = Math.max(24, Math.min(34, Math.round(viewportHeight * 0.033)));
  const maxByHeight = Math.round(viewportHeight * 0.1);
  const maxByWidth = Math.round(viewportWidth * 0.056);
  const maxFontSize = Math.max(56, Math.min(92, maxByHeight, maxByWidth));

  return { minFontSize, maxFontSize };
}

function getMeasureNode() {
  let measureNode = document.getElementById(MEASURE_NODE_ID);

  if (!measureNode) {
    measureNode = document.createElement('div');
    measureNode.id = MEASURE_NODE_ID;
    measureNode.setAttribute('aria-hidden', 'true');
    document.body.appendChild(measureNode);
  }

  return measureNode;
}

function applyReferenceStyles(measureNode) {
  const spans = measureNode.querySelectorAll('span');
  spans.forEach((span) => {
    span.style.display = 'block';
    span.style.marginBottom = '0.28em';
    span.style.fontSize = '0.42em';
    span.style.lineHeight = '1.1';
    span.style.letterSpacing = '0.16em';
    span.style.textTransform = 'uppercase';
    span.style.fontFamily = '"Segoe UI", "Trebuchet MS", sans-serif';
    span.style.fontWeight = '800';
  });
}

function syncMeasureNodeStyles(messageElem, containerElem) {
  const measureNode = getMeasureNode();
  const computed = window.getComputedStyle(messageElem);
  const availableWidth = Math.max(
    1,
    Math.floor(messageElem.clientWidth || containerElem.clientWidth || containerElem.getBoundingClientRect().width || 1)
  );

  measureNode.innerHTML = messageElem.innerHTML;
  measureNode.style.position = 'fixed';
  measureNode.style.left = '-10000px';
  measureNode.style.top = '0';
  measureNode.style.visibility = 'hidden';
  measureNode.style.pointerEvents = 'none';
  measureNode.style.zIndex = '-1';
  measureNode.style.margin = '0';
  measureNode.style.width = `${availableWidth}px`;
  measureNode.style.maxWidth = `${availableWidth}px`;
  measureNode.style.maxHeight = 'none';
  measureNode.style.height = 'auto';
  measureNode.style.overflow = 'visible';
  measureNode.style.boxSizing = computed.boxSizing;
  measureNode.style.paddingTop = computed.paddingTop;
  measureNode.style.paddingRight = computed.paddingRight;
  measureNode.style.paddingBottom = computed.paddingBottom;
  measureNode.style.paddingLeft = computed.paddingLeft;
  measureNode.style.borderTopWidth = computed.borderTopWidth;
  measureNode.style.borderRightWidth = computed.borderRightWidth;
  measureNode.style.borderBottomWidth = computed.borderBottomWidth;
  measureNode.style.borderLeftWidth = computed.borderLeftWidth;
  measureNode.style.borderTopStyle = computed.borderTopStyle;
  measureNode.style.borderRightStyle = computed.borderRightStyle;
  measureNode.style.borderBottomStyle = computed.borderBottomStyle;
  measureNode.style.borderLeftStyle = computed.borderLeftStyle;
  measureNode.style.fontFamily = computed.fontFamily;
  measureNode.style.fontWeight = computed.fontWeight;
  measureNode.style.fontStyle = computed.fontStyle;
  measureNode.style.lineHeight = computed.lineHeight;
  measureNode.style.letterSpacing = computed.letterSpacing;
  measureNode.style.wordSpacing = computed.wordSpacing;
  measureNode.style.textTransform = computed.textTransform;
  measureNode.style.textAlign = computed.textAlign;
  measureNode.style.textDecoration = computed.textDecoration;
  measureNode.style.whiteSpace = computed.whiteSpace;
  measureNode.style.overflowWrap = computed.overflowWrap;
  measureNode.style.wordBreak = computed.wordBreak;
  measureNode.style.hyphens = computed.hyphens;
  measureNode.style.webkitTextStroke = messageElem.style.webkitTextStroke || computed.webkitTextStroke;
  measureNode.style.textShadow = messageElem.style.textShadow || computed.textShadow;

  applyReferenceStyles(measureNode);
  return measureNode;
}

function measureContentAtFontSize(messageElem, containerElem, fontSize) {
  const measureNode = syncMeasureNodeStyles(messageElem, containerElem);
  const availableWidth = Math.max(1, Math.floor(messageElem.clientWidth || containerElem.clientWidth || 1));
  const containerStyle = window.getComputedStyle(containerElem);
  const availableHeight = Math.max(1, Math.floor((containerElem.clientHeight || containerElem.getBoundingClientRect().height || 1)
    - (parseFloat(containerStyle.paddingTop) || 0) - (parseFloat(containerStyle.paddingBottom) || 0)));

  measureNode.style.fontSize = `${fontSize}px`;

  return {
    overflowsWidth: Math.ceil(measureNode.scrollWidth) > Math.floor(availableWidth + 1),
    overflowsHeight: Math.ceil(measureNode.scrollHeight) > Math.floor(availableHeight + 1),
    availableWidth,
    availableHeight,
  };
}

function messageOverflows(messageElem, containerElem) {
  if (!messageElem || !containerElem) {
    return false;
  }

  const measured = measureContentAtFontSize(
    messageElem,
    containerElem,
    Number.parseFloat(messageElem.style.fontSize || window.getComputedStyle(messageElem).fontSize || '0')
  );

  return measured.overflowsWidth || measured.overflowsHeight;
}

function sanitizeMessageMarkup(markup) {
  const template = document.createElement('template');
  template.innerHTML = String(markup ?? '');
  const fragment = document.createDocumentFragment();
  const allowedElements = new Set(['BR', 'SPAN', 'EM']);
  const blockedElements = new Set(['SCRIPT', 'STYLE', 'IFRAME', 'OBJECT', 'EMBED', 'SVG', 'MATH']);

  const appendSafeNode = (sourceNode, destination) => {
    if (sourceNode.nodeType === Node.TEXT_NODE) {
      destination.appendChild(document.createTextNode(sourceNode.textContent || ''));
      return;
    }
    if (sourceNode.nodeType !== Node.ELEMENT_NODE) return;
    if (blockedElements.has(sourceNode.tagName)) return;

    if (!allowedElements.has(sourceNode.tagName)) {
      sourceNode.childNodes.forEach((child) => appendSafeNode(child, destination));
      return;
    }

    const safeElement = document.createElement(sourceNode.tagName.toLowerCase());
    sourceNode.childNodes.forEach((child) => appendSafeNode(child, safeElement));
    destination.appendChild(safeElement);
  };

  template.content.childNodes.forEach((node) => appendSafeNode(node, fragment));
  return fragment;
}

function setSafeMessageMarkup(messageElem, markup) {
  messageElem.replaceChildren(sanitizeMessageMarkup(markup));
}

let currentOutputPayload = null;
function getOutputSongLayout() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(window.OBSBibleBroadcastBranding.SONG_LAYOUT_KEY)); } catch (_) {}
  return window.OBSBibleBroadcastBranding.sanitizeSongLayout(saved);
}

function applySongLook(message) {
  const background = document.getElementById('bg-container');
  if (!background?.dataset) return;
  if (message.kind !== 'song') {
    delete background.dataset.songLayout;
    delete background.dataset.songPosition;
    return;
  }
  const settings = getOutputSongLayout();
  background.dataset.songLayout = settings.layout;
  background.dataset.songPosition = settings.position;
}

function refreshSongLayout(settings) {
  const api = window.OBSBibleBroadcastBranding;
  if (settings) localStorage.setItem(api.SONG_LAYOUT_KEY, JSON.stringify(api.sanitizeSongLayout(settings)));
  if (currentOutputPayload?.kind === 'song') {
    renderLegacyMessagePayload({ ...currentOutputPayload, fadein: false });
  }
}
window.addEventListener('storage', event => {
  if (event.key === window.OBSBibleBroadcastBranding?.SONG_LAYOUT_KEY) refreshSongLayout();
});

function renderLegacyMessagePayload(message, providedMessageElem) {
  const messageElem = providedMessageElem || getMessageElements('messageDisplay').messageElem;
  if (!messageElem) {
    return;
  }

  const bgContainer = document.getElementById('bg-container');
  const containerElem = document.getElementById('container') || messageElem?.parentElement;

  // Always reset to standard styles first, so scripture, songs or default positions are clean!
  applySongLook(message);
  if (message.kind === 'song' && message.song) {
    const lines = window.OBSBibleBroadcastBranding.songCueLines(message.song, getOutputSongLayout().layout);
    const escape = text => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
    message = { ...message, messageContent: lines.map(escape).join('<br>') };
  }
  if (bgContainer) {
    bgContainer.style.justifyContent = '';
    bgContainer.style.alignItems = '';
  }
  if (containerElem) {
    containerElem.style.justifyContent = '';
    containerElem.style.alignItems = '';
  }
  if (messageElem) {
    messageElem.style.textAlign = '';
  }

  const isScriptureOrSong = message.kind === 'scripture' || message.kind === 'song';
  const pos = (!isScriptureOrSong && message.position) ? String(message.position).toLowerCase() : null;

  if (pos) {
    let bgJustify = 'center';
    let bgAlign = 'flex-end';
    let containerJustify = 'center';
    let containerAlign = 'flex-end';
    let textAlign = localStorage.getItem('textAlign') || 'center';

    if (pos === 'top-left') {
      bgJustify = 'flex-start'; bgAlign = 'flex-start';
      containerJustify = 'flex-start'; containerAlign = 'flex-start';
      textAlign = 'left';
    } else if (pos === 'top-center') {
      bgJustify = 'center'; bgAlign = 'flex-start';
      containerJustify = 'center'; containerAlign = 'flex-start';
      textAlign = 'center';
    } else if (pos === 'top-right') {
      bgJustify = 'flex-end'; bgAlign = 'flex-start';
      containerJustify = 'flex-end'; containerAlign = 'flex-start';
      textAlign = 'right';
    } else if (pos === 'middle-left') {
      bgJustify = 'flex-start'; bgAlign = 'center';
      containerJustify = 'flex-start'; containerAlign = 'center';
      textAlign = 'left';
    } else if (pos === 'middle-center' || pos === 'center') {
      bgJustify = 'center'; bgAlign = 'center';
      containerJustify = 'center'; containerAlign = 'center';
      textAlign = 'center';
    } else if (pos === 'middle-right') {
      bgJustify = 'flex-end'; bgAlign = 'center';
      containerJustify = 'flex-end'; containerAlign = 'center';
      textAlign = 'right';
    } else if (pos === 'bottom-left') {
      bgJustify = 'flex-start'; bgAlign = 'flex-end';
      containerJustify = 'flex-start'; containerAlign = 'flex-end';
      textAlign = 'left';
    } else if (pos === 'bottom-center') {
      bgJustify = 'center'; bgAlign = 'flex-end';
      containerJustify = 'center'; containerAlign = 'flex-end';
      textAlign = 'center';
    } else if (pos === 'bottom-right') {
      bgJustify = 'flex-end'; bgAlign = 'flex-end';
      containerJustify = 'flex-end'; containerAlign = 'flex-end';
      textAlign = 'right';
    }

    if (bgContainer) {
      bgContainer.style.justifyContent = bgJustify;
      bgContainer.style.alignItems = bgAlign;
    }
    if (containerElem) {
      containerElem.style.justifyContent = containerJustify;
      containerElem.style.alignItems = containerAlign;
    }
    if (messageElem) {
      messageElem.style.textAlign = textAlign;
    }
  }

  messageElem.hidden = false;

  if (message.fadein === true) {
    messageElem.classList.remove('fade-in');
    messageElem.style.display = 'none';
    setSafeMessageMarkup(messageElem, message.messageContent);
    void messageElem.offsetWidth;
    messageElem.classList.add('fade-in');
    messageElem.style.display = 'block';
  } else {
    setSafeMessageMarkup(messageElem, message.messageContent);
  }
  adjustFontSizeBasedOnScroll();
}

var updateMessage = (messageId, message) => {
  const { messageElem } = getMessageElements(messageId);
  if (!messageElem) {
    return;
  }

  const normalizedMessage = window.OBSBibleBroadcastBranding
    ? window.OBSBibleBroadcastBranding.coerceMessagePayload(message)
    : (typeof message === 'object' ? message : { fadein: false, messageContent: String(message || '') });
  currentOutputPayload = normalizedMessage;
  applySongLook(normalizedMessage);

  localStorage.setItem('savedMessage', normalizedMessage.messageContent || '');
  try {
    const payloadKey = window.OBSBibleBroadcastBranding?.STORAGE_KEYS?.payload || 'obs-bible-saved-message-payload';
    localStorage.setItem(payloadKey, JSON.stringify(normalizedMessage));
  } catch (_) {
    // Ignore storage quota issues.
  }

  if (window.obsBibleBroadcasting?.syncBroadcastPayload?.(normalizedMessage)) {
    return;
  }

  if (window.obsBibleBroadcasting?.deactivateBroadcastLayer) {
    window.obsBibleBroadcasting.deactivateBroadcastLayer();
  }

  renderLegacyMessagePayload(normalizedMessage, messageElem);
};

function adjustFontSizeBasedOnScroll() {
  const { messageElem: message, containerElem: container } = getMessageElements();

  if (!message || !container) {
    return '0px';
  }

  const content = (message.textContent || '').trim();
  if (!content) {
    message.style.fontSize = '';
    return '0px';
  }

  const { minFontSize, maxFontSize } = getResponsiveFontCaps();
  let low = minFontSize;
  let high = maxFontSize;
  let bestFit = minFontSize;

  message.style.fontSize = `${minFontSize}px`;

  while (low <= high) {
    const midFontSize = Math.floor((low + high) / 2);
    message.style.fontSize = `${midFontSize}px`;

    if (messageOverflows(message, container)) {
      high = midFontSize - 1;
    } else {
      bestFit = midFontSize;
      low = midFontSize + 1;
    }
  }

  message.style.fontSize = `${bestFit}px`;
  return `${bestFit}px`;
}

window.adjustFontSizeBasedOnScroll = adjustFontSizeBasedOnScroll;
window.updateMessage = updateMessage;
window.renderLegacyMessagePayload = renderLegacyMessagePayload;

function handleMutation(mutationsList) {
  for (var mutation of mutationsList) {
    if (mutation.type === 'childList' && mutation.target.id === 'messageDisplay') {
      adjustFontSizeBasedOnScroll();
    }
  }
}

const messageTarget = document.getElementById('messageDisplay');
if (messageTarget) {
  const observer = new MutationObserver(handleMutation);
  observer.observe(messageTarget, { childList: true, subtree: true, characterData: true });
}

window.addEventListener('resize', adjustFontSizeBasedOnScroll);
