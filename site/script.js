(function () {
  const menuToggle = document.querySelector('.menu-toggle');
  const siteNav = document.querySelector('#site-nav');

  if (menuToggle && siteNav) {
    menuToggle.addEventListener('click', function () {
      const expanded = menuToggle.getAttribute('aria-expanded') === 'true';
      menuToggle.setAttribute('aria-expanded', String(!expanded));
      siteNav.classList.toggle('is-open', !expanded);
    });

    siteNav.querySelectorAll('a').forEach(function (link) {
      link.addEventListener('click', function () {
        if (window.innerWidth <= 760) {
          menuToggle.setAttribute('aria-expanded', 'false');
          siteNav.classList.remove('is-open');
        }
      });
    });
  }

  const demoTabs = Array.from(document.querySelectorAll('.demo-tab'));
  const demoViews = Array.from(document.querySelectorAll('.demo-view'));
  const demoTitle = document.getElementById('demo-dock-title');
  const demoSelectionLabel = document.getElementById('demo-selection-label');
  const demoStatePill = document.getElementById('demo-state-pill');
  const demoProgramState = document.getElementById('demo-program-state');
  const demoOverlayIndicator = document.getElementById('demo-overlay-indicator');
  const demoOverlayCard = document.getElementById('demo-overlay-card');
  const demoOverlayKicker = document.getElementById('demo-overlay-kicker');
  const demoOverlayCopy = document.getElementById('demo-overlay-copy');
  const demoCaption = document.getElementById('demo-caption');
  const demoTakeButton = document.getElementById('demo-take-button');
  const demoHideButton = document.getElementById('demo-hide-button');
  const textInput = document.getElementById('demo-text-input');
  const waitlistButton = document.getElementById('waitlist-button');
  const waitlistResponse = document.getElementById('waitlist-response');

  const demoState = {
    activeTab: 'text',
    selectedLabel: 'Draft text',
    live: false
  };

  const tabConfig = {
    text: {
      title: 'Text',
      defaultSelection: 'Draft text',
      takeLabel: 'Take text',
      hideLabel: 'Hide text',
      overlayKicker: 'TEXT DRAFT',
      getCopy: function () {
        return (textInput && textInput.value.trim()) || 'Welcome to evening service.';
      },
      caption: 'Selection stays private until Take. This preview illustrates the interaction model only.'
    },
    scripture: {
      title: 'Scripture',
      defaultSelection: 'Psalm 23:1',
      takeLabel: 'Take',
      hideLabel: 'Hide text',
      overlayKicker: 'SCRIPTURE',
      getCopy: function () {
        return 'The Lord is my shepherd; I shall not want.';
      },
      caption: 'Scripture selection is private until Take. On Program here is only part of the preview language.'
    },
    songs: {
      title: 'Songs',
      defaultSelection: 'Amazing Grace · Verse 1',
      takeLabel: 'Take',
      hideLabel: 'Hide text',
      overlayKicker: 'SONG CUE',
      getCopy: function () {
        return 'Amazing grace, how sweet the sound that saved a wretch like me.';
      },
      caption: 'Song cues remain local in this product demo and do not publish on selection.'
    },
    media: {
      title: 'Media',
      defaultSelection: 'Opening still · Show',
      takeLabel: 'Show',
      hideLabel: 'Hide source',
      overlayKicker: 'MEDIA PREVIEW',
      getCopy: function () {
        return 'Mapped image or video source preview only. Not connected.';
      },
      caption: 'Media actions here are a static product demo. They are not connected to OBS.'
    },
    cameras: {
      title: 'Cameras',
      defaultSelection: 'Center camera · Take camera',
      takeLabel: 'Take camera',
      hideLabel: 'Hide source',
      overlayKicker: 'CAMERA PREVIEW',
      getCopy: function () {
        return 'Switch included camera sources inside the mapped output scene. Preview only.';
      },
      caption: 'Camera control shown here is only a product preview. It does not switch OBS scenes from this page.'
    },
    setup: {
      title: 'Setup',
      defaultSelection: 'Output and device review',
      takeLabel: 'Review setup',
      hideLabel: 'Close preview',
      overlayKicker: 'SETUP PREVIEW',
      getCopy: function () {
        return 'Interface preview only. No account or device is connected from this site.';
      },
      caption: 'Setup visuals are shown as interface previews only.'
    },
    streaming: {
      title: 'Streaming',
      defaultSelection: 'Managed streaming · configuration-gated',
      takeLabel: 'Preview flow',
      hideLabel: 'Hide preview',
      overlayKicker: 'NOT CONNECTED',
      getCopy: function () {
        return 'Managed streaming is configuration-gated. This site preview is not connected.';
      },
      caption: 'Provider OAuth is configured separately in Streaming Setup. This preview is not connected.'
    }
  };

  function updateDemoDisplay() {
    const config = tabConfig[demoState.activeTab];
    if (!config) return;

    demoTitle.textContent = config.title;
    demoSelectionLabel.textContent = demoState.selectedLabel || config.defaultSelection;
    demoTakeButton.textContent = config.takeLabel;
    demoHideButton.textContent = config.hideLabel;
    demoOverlayKicker.textContent = demoState.live ? config.overlayKicker : 'PRIVATE DRAFT';
    demoOverlayCopy.textContent = config.getCopy();
    demoCaption.textContent = demoState.live
      ? 'Take applied in this marketing demo. In the real product direction, output state must come from actual mapping and acknowledgement.'
      : config.caption;

    if (demoState.live) {
      demoOverlayIndicator.textContent = 'Preview applied';
      demoOverlayIndicator.className = 'status-chip status-program';
      demoStatePill.textContent = 'Preview applied';
      demoProgramState.textContent = 'Preview state';
      demoOverlayCard.classList.add('is-live');
    } else {
      demoOverlayIndicator.textContent = demoState.activeTab === 'media' || demoState.activeTab === 'cameras' ? 'Preview idle' : 'Hidden';
      demoOverlayIndicator.className = 'status-chip';
      demoStatePill.textContent = demoState.activeTab === 'media' || demoState.activeTab === 'cameras' ? 'Preview idle' : 'Text hidden';
      demoProgramState.textContent = demoState.activeTab === 'setup' || demoState.activeTab === 'streaming' ? 'Preview only' : 'Not on Program';
      demoOverlayCard.classList.remove('is-live');
    }
  }

  function activateTab(tabName) {
    demoState.activeTab = tabName;
    demoState.live = false;
    const config = tabConfig[tabName];
    demoState.selectedLabel = config ? config.defaultSelection : 'Draft text';

    demoTabs.forEach(function (tab) {
      const isActive = tab.dataset.demoTab === tabName;
      tab.classList.toggle('is-active', isActive);
      tab.setAttribute('aria-selected', String(isActive));
    });

    demoViews.forEach(function (view) {
      view.classList.toggle('is-visible', view.dataset.demoView === tabName);
    });

    updateDemoDisplay();
  }

  demoTabs.forEach(function (tab) {
    tab.addEventListener('click', function () {
      activateTab(tab.dataset.demoTab);
    });
  });

  document.querySelectorAll('[data-demo-selection]').forEach(function (button) {
    button.addEventListener('click', function () {
      const currentView = button.closest('[data-demo-view]');
      const currentTab = currentView ? currentView.dataset.demoView : demoState.activeTab;
      currentView?.querySelectorAll('[data-demo-selection]').forEach(function (sibling) {
        sibling.classList.remove('is-selected');
      });
      button.classList.add('is-selected');
      demoState.activeTab = currentTab;
      demoState.selectedLabel = button.dataset.demoSelection || button.textContent.trim();
      demoState.live = false;
      updateDemoDisplay();
    });
  });

  if (textInput) {
    textInput.addEventListener('input', function () {
      if (demoState.activeTab === 'text') {
        demoState.selectedLabel = 'Draft text';
        demoState.live = false;
        updateDemoDisplay();
      }
    });
  }

  if (demoTakeButton) {
    demoTakeButton.addEventListener('click', function () {
      demoState.live = true;
      updateDemoDisplay();
    });
  }

  if (demoHideButton) {
    demoHideButton.addEventListener('click', function () {
      demoState.live = false;
      updateDemoDisplay();
    });
  }

  if (waitlistButton && waitlistResponse) {
    waitlistButton.addEventListener('click', function () {
      waitlistResponse.textContent = 'Interest noted in this demo page only. No signup, payment, or account connection is happening here.';
    });
  }

  activateTab('text');
})();
