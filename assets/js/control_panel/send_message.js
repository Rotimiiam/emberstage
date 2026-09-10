const channel = new BroadcastChannel("myChannel");
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

function processMessage(inputMessage) {
  return sanitizeAndFormatMessage(inputMessage);
}

function sendMessage(senderChannel, message){
  let fadeInCheckbox = document.getElementById("fade-in-checkbox");
  let messageToSend = {
    fadein: fadeInCheckbox ? fadeInCheckbox.checked : false,
    messageContent: message
  };
  if (fadeInCheckbox) {
    localStorage.setItem("obs-bible-fadein-checkbox", fadeInCheckbox.checked);
  }
  senderChannel.postMessage(messageToSend);
}

document.getElementById("sendButton")?.addEventListener("click", () => {
  let messageInput = document.getElementById("messageInput")?.value || '';
  const message = processMessage(messageInput);
  sendMessage(channel, message);
  historyOfText.push(message);
});

function doc_keyUp(e) {
  let lastSavedTab = localStorage.getItem("selectedTab");

  if (e.ctrlKey && e.code === 'ArrowDown' && lastSavedTab === "text") {
    let messageInput = document.getElementById("messageInput")?.value || '';
    const message = processMessage(messageInput);
    sendMessage(channel, message);
    historyOfText.push(message);
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
    const message = processMessage(messageInput);
    sendMessage(channel, message);
    historyOfText.push(message);
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
    const displayContainer = document.getElementById('song-display');
    if (!songContainer || !displayContainer || !element) return;
    
    const containerHeight = songContainer.offsetHeight;
    const elementTop = element.offsetTop;
    const elementHeight = element.offsetHeight;
    
    const scrollTop = elementTop - (containerHeight / 2) + (elementHeight / 2);
    songContainer.scrollTop = scrollTop;
}

function selectSection(index, scroll = true, take = true) {
    const sections = Array.from(document.querySelectorAll('#song-display .song-section'));
    if (sections.length === 0) return;
    
    if (index < 0) index = 0;
    if (index >= sections.length) index = sections.length - 1;
    
    currentSectionIndex = index;
    currentLineIndex = -1;
    
    sections.forEach((s, idx) => {
        s.classList.toggle('selected', idx === index);
        s.querySelectorAll('p').forEach(p => p.classList.remove('selected'));
    });
    
    const activeSection = sections[index];
    activeSection.focus({ preventScroll: true });
    if (take) {
        const text = activeSection.innerText;
        sendMessage(channel, sanitizeAndFormatMessage(text));
        sections.forEach((section, sectionIndex) => section.classList.toggle('live', sectionIndex === index));
    }
    
    if (scroll) {
        scrollToElement(activeSection);
    }
}

function selectLine(index, scroll = true, take = true) {
    const lines = Array.from(document.querySelectorAll('#song-display p'));
    if (lines.length === 0) return;
    
    if (index < 0) index = 0;
    if (index >= lines.length) index = lines.length - 1;
    
    currentLineIndex = index;
    
    lines.forEach((l, idx) => {
        l.classList.toggle('selected', idx === index);
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
        const text = activeLine.innerText;
        sendMessage(channel, sanitizeAndFormatMessage(text));
        lines.forEach((line, lineIndex) => line.classList.toggle('live', lineIndex === index));
    }
    
    if (scroll) {
        scrollToElement(activeLine);
    }
}

function handleNext(take = false) {
    const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
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
    const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
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
    const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
    if (isLineByLine) {
        selectLine(0);
    } else {
        selectSection(0);
    }
}

function handleEnd() {
    const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
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

const initializeSongDisplayMode = () => {
    stopAutoAdvance();
    
    const songDisplay = document.getElementById("song-display");
    if (!songDisplay) return;
    
    const sections = Array.from(songDisplay.querySelectorAll('.song-section'));
    const lines = Array.from(songDisplay.querySelectorAll('p'));
    const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
    
    if (sections.length === 0) {
        currentSectionIndex = -1;
        currentLineIndex = -1;
        return;
    }
    
    sections.forEach((section, index) => {
        const newSection = section.cloneNode(true);
        section.parentNode.replaceChild(newSection, section);
        newSection.tabIndex = isLineByLine ? -1 : 0;
        newSection.setAttribute('role', 'button');
        
        newSection.addEventListener('click', () => {
            const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
            if (!isLineByLine) {
                selectSection(index);
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
            const isLineByLine = document.getElementById("obs-bible-display-song-line-by-line")?.checked === true;
            if (isLineByLine) {
                event.stopPropagation();
                selectLine(index);
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
        newPrev.addEventListener('click', handlePrev);
    }

    if (nextBtn) {
        const newNext = nextBtn.cloneNode(true);
        nextBtn.parentNode.replaceChild(newNext, nextBtn);
        newNext.addEventListener('click', handleNext);
    }

    if (startBtn) {
        const newStart = startBtn.cloneNode(true);
        startBtn.parentNode.replaceChild(newStart, startBtn);
        newStart.addEventListener('click', toggleAutoAdvance);
    }

    if (isLineByLine) {
        if (currentLineIndex < 0 || currentLineIndex >= newLines.length) {
            selectLine(0, false);
        } else {
            selectLine(currentLineIndex, false);
        }
    } else {
        if (currentSectionIndex < 0 || currentSectionIndex >= newSections.length) {
            selectSection(0, false);
        } else {
            selectSection(currentSectionIndex, false);
        }
    }
};

const displaySong = () => {
    initializeSongDisplayMode();
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
    verse.setAttribute('aria-label', `Show ${verse.textContent.trim()}`);
    verse.addEventListener("click", () => selectBibleVerse(index, true));
    verse.addEventListener('keydown', event => activateSharedCue(event, verse));
  });
}

function selectBibleVerse(index, take = false) {
  const bibleVerseDiv = document.getElementById("bible-verse");
  const bibleVerses = Array.from(bibleVerseDiv?.querySelectorAll("p") || []);
  if (index < 0 || index >= bibleVerses.length) return;

  currentVerseIndex = index;
  const currentVerse = bibleVerses[index];
  bibleVerses.forEach((verse, verseIndex) => verse.classList.toggle("selected", verseIndex === index));
  currentVerse.focus({ preventScroll: true });

  const displayVerse = document.getElementById('bible');
  const verseHeight = currentVerse.offsetHeight;
  if (displayVerse) displayVerse.scrollTop = currentVerse.offsetTop - (verseHeight * 2);

  if (!take) return;

  const message = currentVerse.innerHTML;
  sendMessage(channel, message);
  bibleVerses.forEach((verse, verseIndex) => verse.classList.toggle("live", verseIndex === index));
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
  const toggle = document.getElementById('toggle-display');
  if (cue.classList.contains('selected') && toggle?.checked) {
    document.getElementById('toggle-button-display')?.click();
    return;
  }
  cue.click();
  ensureSharedOutputVisible();
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
    displayBible();
  });
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
