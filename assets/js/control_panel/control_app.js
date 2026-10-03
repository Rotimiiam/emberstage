const bblVerseDiv = document.getElementById("bible-verse");
const tabButtons = Array.from(document.getElementsByClassName("tab-button"));
const settingsTabButtons = Array.from(document.getElementsByClassName("settings-tab-button"));
const outputStatus = document.getElementById("output-status");
const standaloneDock = new URLSearchParams(window.location.search).get("dock");
const pinnedControlTab = { scripture: "bibleText", songs: "songs" }[standaloneDock] || null;
let activeControlTab = pinnedControlTab || "text";
// Integration hook for native adapters and legacy send_message handlers. Never use
// another dock's selectedTab storage value to decide what this window is showing.
window.getActiveControlTab = () => activeControlTab;
window.OBSControlView = Object.freeze({ getActiveTab: () => activeControlTab, dock: pinnedControlTab });
window.addEventListener("storage", event => {
  if (event.key !== "obs-bible-animationData" || !event.newValue) return;
  try {
    const state = JSON.parse(event.newValue);
    const toggle = document.getElementById("toggle-display");
    if (toggle && ["flex", "none"].includes(state.display)) {
      toggle.checked = state.display === "flex";
      syncOutputStatus();
    }
  } catch (_) { /* Ignore incomplete settings, never rebroadcast a storage event. */ }
});
if (pinnedControlTab) {
  document.body.dataset.dock = standaloneDock;
  document.title = `${standaloneDock === "scripture" ? "Scripture" : "Songs"} · Emberstage for OBS`;
  tabButtons.forEach(button => {
    button.hidden = button.value !== pinnedControlTab && button.value !== "setBg";
  });
  document.addEventListener("keyup", event => {
    // Pinned docks never send the hidden manual Text editor through legacy keyup handlers.
    if (event.code === "Space" || (event.ctrlKey && event.code === "ArrowDown")) event.stopImmediatePropagation();
  }, true);
}

document.addEventListener("keydown", event => {
  if (event.ctrlKey || event.altKey || event.metaKey || event.target?.closest?.("input, textarea, select, [contenteditable='true']")) return;

  const activeTab = window.getActiveControlTab();
  const targetId = activeTab === "bibleText"
    ? { ArrowLeft: "prev-verse", ArrowRight: "next-verse" }[event.key]
    : activeTab === "songs"
      ? { ArrowUp: "prev-line", ArrowDown: "next-line" }[event.key]
      : null;

  if (!targetId) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  document.getElementById(targetId)?.click();
}, true);

function updateDockLayoutClasses() {
  const viewportWidth = Math.max(window.innerWidth || 0, document.documentElement.clientWidth || 0);
  const viewportHeight = Math.max(window.innerHeight || 0, document.documentElement.clientHeight || 0);
  const body = document.body;

  if (!body) {
    return;
  }

  const isShort = viewportHeight <= 360;
  const isCompact = viewportWidth <= 450 || viewportHeight <= 620;
  const isTiny = viewportHeight <= 280 || viewportWidth <= 340;
  const dockScale = Math.max(0.72, Math.min(1, Math.min(viewportWidth / 390, viewportHeight / 720)));

  body.classList.toggle("dock-short", isShort);
  body.classList.toggle("dock-compact", isCompact);
  body.classList.toggle("dock-tiny", isTiny);
  body.style.setProperty("--dock-w", `${viewportWidth}px`);
  body.style.setProperty("--dock-h", `${viewportHeight}px`);
  if (!body.dataset.uiScale) body.style.setProperty("--dock-scale", `${dockScale}`);
}

function observeDockViewport() {
  updateDockLayoutClasses();
  window.addEventListener("resize", updateDockLayoutClasses);

  if (typeof ResizeObserver !== "undefined") {
    const resizeObserver = new ResizeObserver(() => {
      updateDockLayoutClasses();
    });
    resizeObserver.observe(document.documentElement);
  }
}

function initDockScale() {
  if (!window.EmberstageDockScale) {
    return;
  }

  window.EmberstageDockScale.init({
    root: document.body,
    control: "control-dock-scale",
    output: "control-dock-scale-value",
    storageKey: "obs-bible:text:ui-scale",
    defaultValue: 100,
    min: 70,
    max: 120,
    step: 1
  });
}

function syncOutputStatus() {
  const toggleDisplay = document.getElementById("toggle-display");
  const toggleButton = document.getElementById("toggle-button-display");
  const toggleActionChip = document.getElementById("toggle-action-chip");
  if (!toggleDisplay || !outputStatus) {
    return;
  }

  const isLive = toggleDisplay.checked === true;
  const actionText = isLive ? "Hide text" : "Show text";
  const buttonLabel = `${actionText} shared Scripture and Songs output`;
  outputStatus.textContent = isLive ? "Text live" : "Text hidden";
  if (toggleActionChip) toggleActionChip.textContent = isLive ? "Hide" : "Show";
  toggleButton?.setAttribute("aria-pressed", String(isLive));
  toggleButton?.setAttribute("aria-label", buttonLabel);
  toggleButton?.setAttribute("title", buttonLabel);
  document.body.classList.toggle("output-live", isLive);
}


function openTab(tabName) {
  if (pinnedControlTab && tabName !== pinnedControlTab && tabName !== "setBg") tabName = pinnedControlTab;
  var tabs = document.getElementsByClassName("tab-area");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].style.display = "none";
    tabs[i].classList.remove("selected");
  }
  var selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.style.display = "flex";
    activeControlTab = tabName;
    if (!pinnedControlTab) localStorage.setItem("selectedTab", tabName);
    tabButtons.forEach(button => {
      const selected = button.value === tabName;
      button.classList.toggle("selected-tab", selected);
      button.setAttribute("aria-selected", String(selected));
    });
  }
}

function openSettingTab(tabName) {
  var tabs = document.getElementsByClassName("settings-tab-area");
  for (var i = 0; i < tabs.length; i++) {
    tabs[i].style.display = "none";
    tabs[i].classList.remove("selected-setting-tab");
  }
  var selectedTab = document.getElementById(tabName);
  if (selectedTab) {
    selectedTab.style.display = "flex";
    localStorage.setItem("obs-bible-selectedSettingTab", tabName);
  }
}


tabButtons.forEach(button => {
    button.addEventListener("click", () => {
        openTab(button.value);

        // Remove 'selected' class from all buttons
        Array.from(tabButtons).forEach(btn => {
            if (btn !== button) {
                btn.classList.remove("selected-tab");
            }
        });

        // Add 'selected' class to the clicked button
        button.classList.add("selected-tab");
    });
});

settingsTabButtons.forEach(button => {
    button.addEventListener("click", () => {
        openSettingTab(button.dataset.settings);

        // Remove 'selected' class from all buttons
        settingsTabButtons.forEach(btn => {
            if (btn !== button) {
                btn.classList.remove("selected-setting-tab");
            }
        });

        // Add 'selected' class to the clicked button
        button.classList.add("selected-setting-tab");
    });
});

// Function to retrieve and open the previously selected tab from local storage
function openSavedTab() {
  var savedTab = pinnedControlTab || localStorage.getItem("selectedTab");
  var savedSettingsTab = localStorage.getItem("obs-bible-selectedSettingTab");
  if (savedTab) {
    openTab(savedTab);
    tabButtons.forEach(button => {
      if(button.value === savedTab){
        button.classList.add("selected-tab");
      }
    });
  } else {
    openTab("text");
    tabButtons.forEach(button => {
      if(button.value === "text"){
        button.classList.add("selected-tab");
      }
    });
  }
  if (savedSettingsTab) {
    openSettingTab(savedSettingsTab);
    settingsTabButtons.forEach(settingsButton => {
      if(settingsButton.dataset.settings === savedSettingsTab){
        settingsButton.classList.add("selected-setting-tab");
      }
    });
  } else {
    openSettingTab("settings-general");
    settingsTabButtons.forEach(settingsButton => {
      if(settingsButton.dataset.settings === "settings-general"){
        settingsButton.classList.add("selected-setting-tab");
      }
    });
  }
}

// Call the function to open the saved tab when the webpage loads
window.onload = function() {
  observeDockViewport();
  initDockScale();
  openSavedTab();
  syncOutputStatus();

  document.getElementById("toggle-button-display")?.addEventListener("click", () => {
    window.requestAnimationFrame(syncOutputStatus);
  });

  // get the bible Translation
  const bibleVersionSelect = document.getElementById('bible-version');
  const savedScriptFile = getAllowedBibleScript(localStorage.getItem('selectedScriptFile') || bibleVersionSelect.value);
  bibleVersionSelect.value = savedScriptFile;
  loadScriptFile(savedScriptFile).then(() => {
      getSavedBible();
      displayBible();
      generateIndexForBibleBooks();
      syncOutputStatus();
  });
}
