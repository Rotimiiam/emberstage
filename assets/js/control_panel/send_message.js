const channel = new BroadcastChannel("myChannel");
let lastSharedMessage = localStorage.getItem('savedMessage');
let lastSharedPosition = null;
try {
  lastSharedPosition = JSON.parse(localStorage.getItem('obs-bible-saved-message-payload') || 'null')?.position || null;
} catch (_) { /* Older saved messages have no placement metadata. */ }
channel.addEventListener('message', event => {
  if (typeof event.data?.messageContent === 'string') {
    lastSharedMessage = event.data.messageContent;
    lastSharedPosition = event.data.position || null;
  }
});
window.addEventListener('storage', event => {
  if (event.key === 'savedMessage') lastSharedMessage = event.newValue;
  if (event.key === 'obs-bible-saved-message-payload') {
    try { lastSharedPosition = JSON.parse(event.newValue || 'null')?.position || null; }
    catch (_) { lastSharedPosition = null; }
  }
});
const btnHistory = document.getElementById("history");
var historyOfText = [];
var historyOfBibleVerse = [];
const songVerseDiv = document.getElementById("song");
let currentSongIndex = 0;
let currentVerseIndex = -1;
var btnCopy = document.getElementById("copyHistoryButton");

let currentSectionIndex = -1;
let currentLineIndex = -1;
let isSongRunning = false;
let songIntervalId = null;

function getSongLayout() {
  let saved;
  try { saved = JSON.parse(localStorage.getItem(window.OBSBibleBroadcastBranding.SONG_LAYOUT_KEY)); } catch (_) {}
  return window.OBSBibleBroadcastBranding.sanitizeSongLayout(saved);
}

function isCompactSongLayout() {
  return window.OBSBibleBroadcastBranding.isCompactSongLayout(getSongLayout().layout);
}

function getSongDisplaySections() {
  return Array.from(document.querySelectorAll('#song-display .song-section'));
}

function getSongDisplayLines() {
  return Array.from(document.querySelectorAll('#song-display p'));
}

function isLineByLineSongMode() {
  return document.getElementById('obs-bible-display-song-line-by-line')?.checked === true;
}

function isCompactSongPagingMode() {
  return !isLineByLineSongMode() && isCompactSongLayout();
}

function getSongSectionStartIndex(section, lines = getSongDisplayLines()) {
  const firstLine = section?.querySelector?.('p');
  return firstLine ? lines.indexOf(firstLine) : -1;
}

function setSongNavButtonState(button, label, disabled) {
  if (!button) return;
  button.disabled = disabled;
  button.setAttribute('aria-label', label);
  button.title = label;
  if (button.dataset) button.dataset.tooltip = label;
}

function updateSongChunkControls() {
  const prevBtn = document.getElementById('prev-line');
  const nextBtn = document.getElementById('next-line');
  const indicator = document.getElementById('song-chunk-indicator');
  const sections = getSongDisplaySections();
  const lines = getSongDisplayLines();
  const singleLine = isLineByLineSongMode();
  const compactPaging = !singleLine && isCompactSongLayout();

  if (!prevBtn || !nextBtn) return;

  if (!sections.length || !lines.length) {
    setSongNavButtonState(prevBtn, 'No previous lyric available', true);
    setSongNavButtonState(nextBtn, 'No next lyric available', true);
    if (indicator) {
      indicator.hidden = true;
      indicator.textContent = '';
      indicator.removeAttribute('aria-label');
      indicator.removeAttribute('title');
    }
    return;
  }

  if (compactPaging) {
    const starts = songCueStarts();
    const fallbackStart = starts[0] ?? 0;
    const activeStart = starts.filter(index => index <= currentLineIndex).pop() ?? fallbackStart;
    const activeLine = lines[Math.max(0, activeStart)] || lines[0];
    const activeSection = activeLine?.closest('.song-section') || sections[currentSectionIndex] || sections[0];
    const sectionStart = getSongSectionStartIndex(activeSection, lines);
    const sectionLines = Array.from(activeSection?.querySelectorAll('p') || [], line => line.innerText);
    const sectionLineIndex = Math.max(0, activeStart - Math.max(0, sectionStart));
    const pagination = window.OBSBibleBroadcastBranding.songCuePagination({ lines: sectionLines, lineIndex: sectionLineIndex, singleLine: false }, getSongLayout().layout);
    const sectionLabel = activeSection?.dataset?.sectionLabel || activeSection?.dataset?.sectionType || 'Section';

    setSongNavButtonState(prevBtn, 'Go to previous song part', activeStart <= fallbackStart);
    setSongNavButtonState(nextBtn, 'Go to next song part', activeStart >= (starts[starts.length - 1] ?? fallbackStart));

    if (indicator) {
      indicator.hidden = false;
      indicator.textContent = `Part ${pagination.pageIndex + 1}/${pagination.pageCount}`;
      indicator.setAttribute('aria-label', `${sectionLabel} part ${pagination.pageIndex + 1} of ${pagination.pageCount}`);
      indicator.title = `${sectionLabel} · part ${pagination.pageIndex + 1} of ${pagination.pageCount}`;
    }
    return;
  }

  if (indicator) {
    indicator.hidden = true;
    indicator.textContent = '';
    indicator.removeAttribute('aria-label');
    indicator.removeAttribute('title');
  }

  if (singleLine) {
    const activeIndex = currentLineIndex < 0 ? 0 : Math.min(currentLineIndex, lines.length - 1);
    setSongNavButtonState(prevBtn, 'Go to previous lyric', activeIndex <= 0);
    setSongNavButtonState(nextBtn, 'Go to next lyric', activeIndex >= lines.length - 1);
    return;
  }

  const activeSectionIndex = currentSectionIndex < 0 ? 0 : Math.min(currentSectionIndex, sections.length - 1);
  setSongNavButtonState(prevBtn, 'Go to previous section', activeSectionIndex <= 0);
  setSongNavButtonState(nextBtn, 'Go to next section', activeSectionIndex >= sections.length - 1);
}

function syncSongLayoutControls() {
  const settings = getSongLayout();
  const select = document.getElementById('song-layout-select');
  if (select) {
    select.value = settings.layout;
    const position = document.getElementById('song-layout-position');
    position.value = settings.position;
    position.querySelector('[value="center"]').disabled = settings.layout === 'side-panel';
    document.getElementById('song-layout-position-label').hidden = !['lyric-card', 'side-panel'].includes(settings.layout);
    document.getElementById('song-layout-hint').textContent = isCompactSongLayout()
      ? 'Changes apply live. Two lines per part; Prev / Next moves through the verse.'
      : 'Changes apply live. Full verse / chorus.';
  }
  updateSongChunkControls();
}

const songSettingsChannel = new BroadcastChannel('settings');
function changeSongLayout() {
  const layout = document.getElementById('song-layout-select').value;
  let position = document.getElementById('song-layout-position').value;
  if (layout === 'side-panel' && position === 'center') position = 'left';
  const settings = window.OBSBibleBroadcastBranding.sanitizeSongLayout({ layout, position });
  localStorage.setItem(window.OBSBibleBroadcastBranding.SONG_LAYOUT_KEY, JSON.stringify(settings));
  songSettingsChannel.postMessage({ songLayout: settings });
  // Do not send a new lyric or touch visibility: the output restyles its LIVE payload.
  syncSongLayoutControls();
}
document.getElementById('song-layout-select')?.addEventListener('change', changeSongLayout);
document.getElementById('song-layout-position')?.addEventListener('change', changeSongLayout);
window.addEventListener('storage', event => {
  if (event.key === window.OBSBibleBroadcastBranding?.SONG_LAYOUT_KEY) syncSongLayoutControls();
});
if (document.getElementById('song-layout-select')) syncSongLayoutControls();

function sendSongCue(section, lineIndex, toggleIfLive) {
  const lines = Array.from(section.querySelectorAll('p'), line => line.innerText);
  const singleLine = isLineByLineSongMode();
  const song = { lines, lineIndex, singleLine };
  // Canonical cue content stays independent of its look, so clicking the live cue still toggles.
  const canonical = lines.slice(lineIndex, lineIndex + (singleLine ? 1 : 2)).join('\n');
  sendMessage(channel, sanitizeAndFormatMessage(canonical), toggleIfLive, { kind: 'song', song });
}

function songCueStarts() {
  const starts = [];
  let offset = 0;
  getSongDisplaySections().forEach(section => {
    const count = section.querySelectorAll('p').length;
    for (let i = 0; i < count; i += 2) starts.push(offset + i);
    offset += count;
  });
  return starts;
}

function parseMessageInput(input) {
  let position = null;
  let text = input ?? '';
  const match = text.match(/^\s*\[(top-left|top-center|top-right|middle-left|middle-center|middle-right|bottom-left|bottom-center|bottom-right|center)\]\s*/i);
  if (match) {
    position = match[1].toLowerCase();
    text = text.substring(match[0].length);
  }
  return { text, position };
}

function processMessage(inputMessage) {
  return sanitizeAndFormatMessage(inputMessage);
}

function sendMessage(senderChannel, message, toggleIfLive = false, options = {}){
  // Selection/focus can move independently of the actual shared output.
  if (toggleIfLive && message === lastSharedMessage && (options?.position || null) === lastSharedPosition && document.getElementById('toggle-display')?.checked) {
    document.getElementById('toggle-button-display')?.click();
    return false;
  }
  let fadeInCheckbox = document.getElementById("fade-in-checkbox");
  let messageToSend = {
    fadein: fadeInCheckbox ? fadeInCheckbox.checked : false,
    messageContent: message
  };
  if (options && typeof options === 'object') {
    if (typeof options.kind === 'string' && options.kind) {
      messageToSend.kind = options.kind;
    }
    if (typeof options.position === 'string' && options.position) {
      messageToSend.position = options.position;
    } else {
      messageToSend.position = null;
    }
    if (options.scripture && typeof options.scripture === 'object') {
      messageToSend.scripture = {
        reference: String(options.scripture.reference || '').trim(),
        verseText: String(options.scripture.verseText || '').replace(/\s+/g, ' ').trim(),
      };
    }
    if (options.kind === 'song') messageToSend.song = options.song;
  } else {
    messageToSend.position = null;
  }
  if (fadeInCheckbox) {
    localStorage.setItem("obs-bible-fadein-checkbox", fadeInCheckbox.checked);
  }
  senderChannel.postMessage(messageToSend);
  lastSharedMessage = message;
  lastSharedPosition = messageToSend.position || null;
  if (toggleIfLive) ensureSharedOutputVisible();
  return true;
}

document.getElementById("sendButton")?.addEventListener("click", () => {
  let messageInput = document.getElementById("messageInput")?.value || '';
  const { text, position } = parseMessageInput(messageInput);
  const message = processMessage(text);
  if (sendMessage(channel, message, true, { kind: 'text', position })) historyOfText.push(messageInput);
});

function doc_keyUp(e) {
  let lastSavedTab = localStorage.getItem("selectedTab");

  if (e.ctrlKey && e.code === 'ArrowDown' && lastSavedTab === "text") {
    let messageInput = document.getElementById("messageInput")?.value || '';
    const { text, position } = parseMessageInput(messageInput);
    const message = processMessage(text);
    sendMessage(channel, message, false, { kind: 'text', position });
    historyOfText.push(messageInput);
  }
}

function doc_spaceBarUp(e) {
  let lastSavedTab = localStorage.getItem("selectedTab");
  let spaceBarCheckBox = document.getElementById("spacebar-checkbox");
  if (spaceBarCheckBox) {
    localStorage.setItem("obs-bible-spacebar-checkbox", spaceBarCheckBox.checked);
  }

  if (e.code === 'Space' && lastSavedTab === "text" && spaceBarCheckBox && spaceBarCheckBox.checked === true) {
    let messageInput = document.getElementById("messageInput")?.value || '';
    const { text, position } = parseMessageInput(messageInput);
    const message = processMessage(text);
    sendMessage(channel, message, false, { kind: 'text', position });
    historyOfText.push(messageInput);
  }
}

// Helper to check if user is currently typing in an input
const isEditableActive = () => {
    const active = document.activeElement;
    if (!active) return false;
    const tag = active.tagName;
    return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || active.isContentEditable;
};

function scrollToElement(element) {
    const songContainer = document.getElementById('song');
    if (!songContainer || !element) return;
    // Lyric offsetTop is relative to its positioned verse, not the scroll pane.
    // Use viewport coordinates and leave already-visible cues where they are.
    const bounds = songContainer.getBoundingClientRect();
    const rect = element.getBoundingClientRect();
    const top = bounds.top + songContainer.clientTop;
    const bottom = top + songContainer.clientHeight;
    if (rect.top < top || rect.height > songContainer.clientHeight) {
        songContainer.scrollTop += rect.top - top;
    } else if (rect.bottom > bottom) {
        songContainer.scrollTop += rect.bottom - bottom;
    }
}

function selectSection(index, scroll = true, take = true, toggleIfLive = false) {
    const sections = getSongDisplaySections();
    if (sections.length === 0) return;
    
    if (index < 0) index = 0;
    if (index >= sections.length) index = sections.length - 1;
    
    currentSectionIndex = index;
    currentLineIndex = getSongDisplayLines().indexOf(sections[index].querySelector('p'));
    
    sections.forEach((s, idx) => {
        s.classList.toggle('selected', idx === index);
        s.querySelectorAll('p').forEach(p => p.classList.remove('selected'));
    });
    
    const activeSection = sections[index];
    activeSection.focus({ preventScroll: true });
    if (take) {
        sendSongCue(activeSection, 0, toggleIfLive);
        sections.forEach((section, sectionIndex) => section.classList.toggle('live', sectionIndex === index));
    }
    
    if (scroll) {
        scrollToElement(activeSection);
    }
    updateSongChunkControls();
}

function selectLine(index, scroll = true, take = true, toggleIfLive = false) {
    const lines = getSongDisplayLines();
    if (lines.length === 0) return;
    
    if (index < 0) index = 0;
    if (index >= lines.length) index = lines.length - 1;

    const singleLine = isLineByLineSongMode();
    if (!singleLine && isCompactSongLayout()) {
        const siblings = Array.from(lines[index].closest('.song-section').querySelectorAll('p'));
        index -= siblings.indexOf(lines[index]) % 2;
    }
    
    currentLineIndex = index;
    
    lines.forEach((l, idx) => {
        l.classList.toggle('selected', idx === index || (!singleLine && isCompactSongLayout() && idx === index + 1 && l.parentElement === lines[index].parentElement));
    });
    
    const activeLine = lines[index];
    const parentSection = activeLine.closest('.song-section');
    const sections = Array.from(document.querySelectorAll('#song-display .song-section'));
    sections.forEach(s => {
        s.classList.toggle('selected', s === parentSection);
    });
    
    if (parentSection) {
        currentSectionIndex = sections.indexOf(parentSection);
    }
    
    activeLine.focus({ preventScroll: true });
    if (take) {
        sendSongCue(parentSection, Array.from(parentSection.querySelectorAll('p')).indexOf(activeLine), toggleIfLive);
        lines.forEach((line, lineIndex) => line.classList.toggle('live', lineIndex === index || (!singleLine && isCompactSongLayout() && lineIndex === index + 1 && line.parentElement === activeLine.parentElement)));
    }
    
    if (scroll) {
        scrollToElement(activeLine);
    }
    updateSongChunkControls();
}

function handleNext(take = false) {
    take = take === true;
    const isLineByLine = isLineByLineSongMode();
    if (!isLineByLine && isCompactSongLayout()) {
        const next = songCueStarts().find(index => index > currentLineIndex);
        if (next !== undefined) selectLine(next, true, take);
        return;
    }
    if (isLineByLine) {
        const lines = document.querySelectorAll('#song-display p');
        if (lines.length === 0) return;
        if (currentLineIndex === -1) {
            selectLine(0, true, take);
        } else if (currentLineIndex < lines.length - 1) {
            selectLine(currentLineIndex + 1, true, take);
        }
    } else {
        const sections = document.querySelectorAll('#song-display .song-section');
        if (sections.length === 0) return;
        if (currentSectionIndex === -1) {
            selectSection(0, true, take);
        } else if (currentSectionIndex < sections.length - 1) {
            selectSection(currentSectionIndex + 1, true, take);
        }
    }
}

function handlePrev(take = false) {
    take = take === true;
    const isLineByLine = isLineByLineSongMode();
    if (!isLineByLine && isCompactSongLayout()) {
        const previous = songCueStarts().filter(index => index < currentLineIndex).pop();
        if (previous !== undefined) selectLine(previous, true, take);
        return;
    }
    if (isLineByLine) {
        const lines = document.querySelectorAll('#song-display p');
        if (lines.length === 0) return;
        if (currentLineIndex === -1) {
            selectLine(0, true, take);
        } else if (currentLineIndex > 0) {
            selectLine(currentLineIndex - 1, true, take);
        }
    } else {
        const sections = document.querySelectorAll('#song-display .song-section');
        if (sections.length === 0) return;
        if (currentSectionIndex === -1) {
            selectSection(0, true, take);
        } else if (currentSectionIndex > 0) {
            selectSection(currentSectionIndex - 1, true, take);
        }
    }
}

function handleHome() {
    const isLineByLine = isLineByLineSongMode();
    if (isLineByLine) {
        selectLine(0);
    } else {
        selectSection(0);
    }
}

function handleEnd() {
    const isLineByLine = isLineByLineSongMode();
    if (!isLineByLine && isCompactSongLayout()) {
        const last = songCueStarts().pop();
        if (last !== undefined) selectLine(last);
        return;
    }
    if (isLineByLine) {
        const lines = document.querySelectorAll('#song-display p');
        if (lines.length > 0) {
            selectLine(lines.length - 1);
        }
    } else {
        const sections = document.querySelectorAll('#song-display .song-section');
        if (sections.length > 0) {
            selectSection(sections.length - 1);
        }
    }
}

function toggleAutoAdvance() {
    const startBtn = document.getElementById('start-song-button');
    const durationInput = document.getElementById('song-line-duration');
    const timerElement = document.getElementById('countdown-timer');
    if (!startBtn || !durationInput) return;
    
    const timer = parseInt(durationInput.value, 10);
    if (isNaN(timer) || timer <= 0) return;
    
    if (!isSongRunning) {
        isSongRunning = true;
        startBtn.value = 'Stop';
        
        let timeLeft = timer;
        if (timerElement) timerElement.innerText = timeLeft + 's';
        
        songIntervalId = setInterval(() => {
            timeLeft--;
            if (timeLeft <= 0) {
                handleNext(true);
                timeLeft = parseInt(durationInput.value, 10) || timer;
            }
            if (timerElement) timerElement.innerText = timeLeft + 's';
        }, 1000);
    } else {
        stopAutoAdvance();
    }
}

function stopAutoAdvance() {
    isSongRunning = false;
    const startBtn = document.getElementById('start-song-button');
    if (startBtn) startBtn.value = 'Play Lyrics';
    
    if (songIntervalId) {
        clearInterval(songIntervalId);
        songIntervalId = null;
    }
    const timerElement = document.getElementById('countdown-timer');
    if (timerElement) timerElement.innerText = '0s';
}

const clearSongListeners = () => {
    stopAutoAdvance();
};

const initializeSongDisplayMode = (take = true) => {
    stopAutoAdvance();
    
    const songDisplay = document.getElementById("song-display");
    if (!songDisplay) return;
    
    const sections = Array.from(songDisplay.querySelectorAll('.song-section'));
    const lines = Array.from(songDisplay.querySelectorAll('p'));
    const isLineByLine = isLineByLineSongMode();
    
    if (sections.length === 0) {
        currentSectionIndex = -1;
        currentLineIndex = -1;
        updateSongChunkControls();
        return;
    }
    
    sections.forEach((section, index) => {
        const newSection = section.cloneNode(true);
        section.parentNode.replaceChild(newSection, section);
        newSection.tabIndex = isLineByLine ? -1 : 0;
        newSection.setAttribute('role', 'button');
        
        newSection.addEventListener('click', () => {
            const isLineByLine = isLineByLineSongMode();
            if (!isLineByLine && !isCompactSongLayout()) {
                selectSection(index, true, true, true);
            }
        });
        newSection.addEventListener('keydown', event => activateSharedCue(event, newSection));
    });
    
    const newSections = Array.from(songDisplay.querySelectorAll('.song-section'));
    const newLines = Array.from(songDisplay.querySelectorAll('p'));
    
    newLines.forEach((line, index) => {
        line.tabIndex = isLineByLine ? 0 : -1;
        line.setAttribute('role', 'button');
        line.addEventListener('click', (event) => {
            const isLineByLine = isLineByLineSongMode();
            if (isLineByLine || isCompactSongLayout()) {
                event.stopPropagation();
                selectLine(index, true, true, true);
            }
        });
        line.addEventListener('keydown', event => activateSharedCue(event, line));
    });
    
    const prevBtn = document.getElementById("prev-line");
    const nextBtn = document.getElementById("next-line");
    const startBtn = document.getElementById("start-song-button");

    if (prevBtn) {
        const newPrev = prevBtn.cloneNode(true);
        prevBtn.parentNode.replaceChild(newPrev, prevBtn);
        newPrev.addEventListener('click', () => handlePrev(true));
    }

    if (nextBtn) {
        const newNext = nextBtn.cloneNode(true);
        nextBtn.parentNode.replaceChild(newNext, nextBtn);
        newNext.addEventListener('click', () => handleNext(true));
    }

    if (startBtn) {
        const newStart = startBtn.cloneNode(true);
        startBtn.parentNode.replaceChild(newStart, startBtn);
        newStart.addEventListener('click', toggleAutoAdvance);
    }

    if (isLineByLine) {
        if (currentLineIndex < 0 || currentLineIndex >= newLines.length) {
            selectLine(0, false, take);
        } else {
            selectLine(currentLineIndex, false, take);
        }
    } else {
        if (currentSectionIndex < 0 || currentSectionIndex >= newSections.length) {
            selectSection(0, false, take);
        } else {
            selectSection(currentSectionIndex, false, take);
        }
    }
    updateSongChunkControls();
};

const displaySong = (take = true) => {
    initializeSongDisplayMode(take);
};

document.getElementById("obs-bible-display-song-line-by-line")?.addEventListener("change", () => {
    initializeSongDisplayMode();
});

// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++
// +++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++++

function displayBible() {
  let bibleVerseDiv = document.getElementById("bible-verse");
  if (!bibleVerseDiv) return;
  let pElements = bibleVerseDiv.querySelectorAll("p");
  let bibleVerses = Array.from(pElements);

  bibleVerses.forEach((verse, index) => {
    verse.tabIndex = 0;
    verse.setAttribute('role', 'button');
    verse.setAttribute('aria-label', `Show or hide ${verse.textContent.trim()}`);
    verse.onclick = () => selectBibleVerse(index, true, true, false);
    verse.onkeydown = event => activateSharedCue(event, verse);
  });
}

function selectBibleVerse(index, take = false, toggleIfLive = false, scroll = true) {
  const bibleVerseDiv = document.getElementById("bible-verse");
  const bibleVerses = Array.from(bibleVerseDiv?.querySelectorAll("p") || []);
  if (index < 0 || index >= bibleVerses.length) return;

  currentVerseIndex = index;
  const currentVerse = bibleVerses[index];
  bibleVerses.forEach((verse, verseIndex) => verse.classList.toggle("selected", verseIndex === index));
  currentVerse.focus({ preventScroll: true });

  const displayVerse = document.getElementById('bible');
  // Taking/toggling a cue must not reset the operator's scroll position.
  // Explicit navigation only reveals an off-screen verse, rather than recentering it.
  if (scroll && displayVerse) {
    const pane = displayVerse.getBoundingClientRect();
    const rect = currentVerse.getBoundingClientRect();
    const top = pane.top + displayVerse.clientTop;
    const bottom = top + displayVerse.clientHeight;
    if (rect.top < top) displayVerse.scrollTop += rect.top - top;
    else if (rect.bottom > bottom) displayVerse.scrollTop += rect.bottom - bottom;
  }

  if (!take) return;

  const message = currentVerse.innerHTML;
  const referenceNode = currentVerse.querySelector('span');
  const verseClone = currentVerse.cloneNode(true);
  verseClone.querySelector('span')?.remove();
  const sent = sendMessage(channel, message, toggleIfLive, {
    kind: 'scripture',
    scripture: {
      reference: referenceNode ? referenceNode.textContent : '',
      verseText: verseClone.textContent || '',
    },
  });
  bibleVerses.forEach((verse, verseIndex) => verse.classList.toggle("live", verseIndex === index));
  if (!sent) return;
  historyOfBibleVerse.push({ name: currentVerse.id, verse: message });
  historyOfText.push(message);
  if (historyOfBibleVerse.length > 20) historyOfBibleVerse.shift();
}

function ensureSharedOutputVisible() {
  const toggle = document.getElementById('toggle-display');
  if (toggle && !toggle.checked) document.getElementById('toggle-button-display')?.click();
}

function activateSharedCue(event, cue) {
  if (event.key !== 'Enter' && event.key !== ' ') return;
  event.preventDefault();
  event.stopPropagation();
  if (event.repeat) return;
  cue.click();
}

document.getElementById("prev-verse")?.addEventListener("click", (event) => {
  moveToPreviousVerse(event);
});

document.getElementById("next-verse")?.addEventListener("click", (event) => {
  moveToNextVerse(event);
});

function moveToNextVerse(event){
  let bibleVerseDiv = document.getElementById("bible-verse");
  if (!bibleVerseDiv) return;
  let pElements = bibleVerseDiv.querySelectorAll("p");
  let bibleVerses = Array.from(pElements);

  if (bibleVerses.length === 0) return;
  const nextIndex = currentVerseIndex < 0 ? 0 : Math.min(currentVerseIndex + 1, bibleVerses.length - 1);
  selectBibleVerse(nextIndex, false);
}

function moveToPreviousVerse(event){
  let bibleVerseDiv = document.getElementById("bible-verse");
  if (!bibleVerseDiv) return;
  let pElements = bibleVerseDiv.querySelectorAll("p");
  let bibleVerses = Array.from(pElements);

  if (bibleVerses.length === 0) return;
  const previousIndex = currentVerseIndex < 0 ? 0 : Math.max(currentVerseIndex - 1, 0);
  selectBibleVerse(previousIndex, false);
}

document.addEventListener("keydown", function(event) {
  if (isEditableActive()) {
    return;
  }
  
  let lastSavedTab = localStorage.getItem("selectedTab");
  if (lastSavedTab === "bibleText") {
    if (event.key === "ArrowRight") {
      event.preventDefault();
      moveToNextVerse(event);
    } else if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveToPreviousVerse(event);
    }
  } else if (lastSavedTab === "songs") {
    if (event.key === "ArrowDown") {
      event.preventDefault();
      handleNext();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      handlePrev();
    } else if (event.key === "Home") {
      event.preventDefault();
      handleHome();
    } else if (event.key === "End") {
      event.preventDefault();
      handleEnd();
    }
  }
});

btnHistory?.addEventListener("click", function () {
  let bblVerseDiv = document.getElementById("bible-verse");
  if (!bblVerseDiv) return;
  bblVerseDiv.innerHTML = "";
  historyOfBibleVerse.forEach(entry => {
    const pElement = document.createElement('p');
    pElement.id = entry.name;
    pElement.innerHTML = entry.verse;
    bblVerseDiv.appendChild(pElement);
  });
  displayBible();
});

btnCopy?.addEventListener("click", function () {
    let textToCopy;
    textToCopy = historyOfText.join("\n");

    textToCopy = textToCopy.replace(/<\/?[^>]+>/gi, '');

    let textarea = document.getElementById("messageInput");
    if (textarea) textarea.value = textToCopy;
});

btnCopy?.addEventListener("dblclick", function () {
  historyOfText = []
});

displayBible();
document.addEventListener('keyup', doc_keyUp, false);
document.addEventListener('keyup', doc_spaceBarUp, false);
