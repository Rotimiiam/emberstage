const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const branding = require('../assets/js/browser_source/broadcast_branding_shared.js');

// Load and extract parseMessageInput from send_message.js
const sendMessagePath = path.join(__dirname, '../assets/js/control_panel/send_message.js');
const sendMessageSource = fs.readFileSync(sendMessagePath, 'utf8');

// A robust way to extract and run parseMessageInput in Node
function getParseMessageInput() {
  const match = sendMessageSource.match(/function parseMessageInput\([\s\S]*?\n\}/);
  if (!match) throw new Error("Could not find parseMessageInput function in send_message.js");
  return new Function('input', match[0] + '\nreturn parseMessageInput(input);');
}

test('Text Positioning - parsing and literal fallback', () => {
  const parseMessageInput = getParseMessageInput();

  // 1. Parsing of valid positions
  assert.deepEqual(parseMessageInput('[top-left] Welcome'), { text: 'Welcome', position: 'top-left' });
  assert.deepEqual(parseMessageInput('  [center] Hello World  '), { text: 'Hello World  ', position: 'center' });
  assert.deepEqual(parseMessageInput('[bottom-right]Pastor John'), { text: 'Pastor John', position: 'bottom-right' });
  assert.deepEqual(parseMessageInput('[MIDDLE-LEFT] test'), { text: 'test', position: 'middle-left' });

  // 2. Unknown or invalid directives stay literal
  assert.deepEqual(parseMessageInput('[unknown-dir] Welcome'), { text: '[unknown-dir] Welcome', position: null });
  assert.deepEqual(parseMessageInput('[top-left-center] text'), { text: '[top-left-center] text', position: null });
  assert.deepEqual(parseMessageInput('Normal text without bracket'), { text: 'Normal text without bracket', position: null });
  assert.deepEqual(parseMessageInput('Welcome [top-left]'), { text: 'Welcome [top-left]', position: null });
});

test('Text Positioning - coerceMessagePayload preserves position metadata', () => {
  // 1. Valid position is preserved
  const p1 = branding.coerceMessagePayload({
    messageContent: 'Welcome',
    position: 'top-left'
  });
  assert.equal(p1.position, 'top-left');

  // 2. Missing position becomes null
  const p2 = branding.coerceMessagePayload({
    messageContent: 'Welcome'
  });
  assert.equal(p2.position, null);

  // 3. String coercion for literal strings (always has null position)
  const p3 = branding.coerceMessagePayload('Hello');
  assert.equal(p3.position, null);
});

test('Moving identical live text takes the new position instead of hiding it', () => {
  const fn = sendMessageSource.match(/function sendMessage\([\s\S]*?\n\}/)[0];
  const posted = [];
  let hides = 0;
  const send = new Function('document', 'localStorage', 'ensureSharedOutputVisible', `
    let lastSharedMessage = 'Welcome';
    let lastSharedPosition = 'top-left';
    ${fn}
    return sendMessage;
  `)({ getElementById(id) {
    if (id === 'toggle-display') return { checked: true };
    if (id === 'toggle-button-display') return { click() { hides++; } };
    return null;
  } }, { setItem() {} }, () => {});
  const channel = { postMessage(value) { posted.push(value); } };
  assert.equal(send(channel, 'Welcome', true, { position: 'bottom-right' }), true);
  assert.equal(hides, 0);
  assert.equal(posted[0].position, 'bottom-right');
  assert.equal(send(channel, 'Welcome', true, { position: 'bottom-right' }), false);
  assert.equal(hides, 1);
});

test('Text Positioning - DOM alignment rendering and reset rules', () => {
  // Mock DOM elements
  const bgStyle = {};
  const containerStyle = {};
  const msgStyle = {};

  const bgContainer = { style: bgStyle };
  const containerElem = { style: containerStyle };
  const messageElem = { style: msgStyle, classList: { remove() {}, add() {} }, offsetWidth: 100, hidden: false };

  // Set up node-like global environment briefly
  global.document = {
    getElementById(id) {
      if (id === 'bg-container') return bgContainer;
      if (id === 'container') return containerElem;
      if (id === 'messageDisplay') return messageElem;
      return null;
    }
  };
  global.localStorage = {
    getItem() { return 'center'; },
    setItem() {}
  };
  global.adjustFontSizeBasedOnScroll = () => {};
  global.setSafeMessageMarkup = () => {};

  // Load and run renderLegacyMessagePayload from browser_app.js source
  const browserAppPath = path.join(__dirname, '../assets/js/browser_source/browser_app.js');
  const browserAppSource = fs.readFileSync(browserAppPath, 'utf8');
  
  // Extract and compile renderLegacyMessagePayload
  const renderMatch = browserAppSource.match(/function renderLegacyMessagePayload\([\s\S]*?\n\}/);
  if (!renderMatch) throw new Error("Could not find renderLegacyMessagePayload in browser_app.js");
  
  // Mock helper dependencies inside browser_app.js scope for the eval
  const renderFn = new Function('message', 'providedMessageElem', `
    const getMessageElements = () => ({ messageElem: global.document.getElementById('messageDisplay'), containerElem: global.document.getElementById('container') });
    const setSafeMessageMarkup = global.setSafeMessageMarkup;
    const adjustFontSizeBasedOnScroll = global.adjustFontSizeBasedOnScroll;
    const localStorage = global.localStorage;
    ${browserAppSource.match(/function applySongLook\([\s\S]*?\n\}/)[0]}
    ${renderMatch[0]}
    renderLegacyMessagePayload(message, providedMessageElem);
  `);

  // Test 1: Rendering top-left position applies correct style properties
  renderFn({ messageContent: 'Welcome', position: 'top-left', kind: '' });
  assert.equal(bgStyle.justifyContent, 'flex-start');
  assert.equal(bgStyle.alignItems, 'flex-start');
  assert.equal(containerStyle.justifyContent, 'flex-start');
  assert.equal(containerStyle.alignItems, 'flex-start');
  assert.equal(msgStyle.textAlign, 'left');

  // Test 2: Rendering with no position resets styles
  renderFn({ messageContent: 'Welcome', position: null, kind: '' });
  assert.equal(bgStyle.justifyContent, '');
  assert.equal(bgStyle.alignItems, '');
  assert.equal(containerStyle.justifyContent, '');
  assert.equal(containerStyle.alignItems, '');
  assert.equal(msgStyle.textAlign, '');

  // Test 3: Scripture and Songs mode reset placement even if position metadata exists
  renderFn({ messageContent: 'John 3:16', position: 'top-left', kind: 'scripture' });
  assert.equal(bgStyle.justifyContent, '');
  assert.equal(bgStyle.alignItems, '');
  assert.equal(containerStyle.justifyContent, '');
  assert.equal(containerStyle.alignItems, '');
  assert.equal(msgStyle.textAlign, '');

  // Clean up globals
  delete global.document;
  delete global.localStorage;
  delete global.adjustFontSizeBasedOnScroll;
  delete global.setSafeMessageMarkup;
});
