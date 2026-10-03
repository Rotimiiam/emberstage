(function () {
  'use strict';

  const editable = element => element?.matches?.('input, textarea, select, [contenteditable="true"]');
  const visible = element => !element.hidden && element.getClientRects().length > 0 && getComputedStyle(element).visibility !== 'hidden';
  const focusables = () => Array.from(document.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]):not([type="hidden"]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter(visible);

  function candidatesFor(active) {
    const group = active.closest('dialog[open], [role="tablist"], .settings-tabs, .source-list, #bible-verse, #song-library-list, #song-display, .actionbar');
    if (!group) return focusables();
    return focusables().filter(item => item === active || group.contains(item));
  }

  function directionalTarget(active, key) {
    const rect = active.getBoundingClientRect();
    const originX = rect.left + rect.width / 2;
    const originY = rect.top + rect.height / 2;
    const vertical = key === 'ArrowUp' || key === 'ArrowDown';
    const sign = key === 'ArrowUp' || key === 'ArrowLeft' ? -1 : 1;
    let best = null;
    let bestScore = Infinity;

    for (const item of candidatesFor(active)) {
      if (item === active) continue;
      const box = item.getBoundingClientRect();
      const x = box.left + box.width / 2;
      const y = box.top + box.height / 2;
      const primary = vertical ? (y - originY) * sign : (x - originX) * sign;
      if (primary <= 1) continue;
      const secondary = vertical ? Math.abs(x - originX) : Math.abs(y - originY);
      const score = primary + secondary * 2.5;
      if (score < bestScore) { best = item; bestScore = score; }
    }
    return best;
  }

  function markFocus(element) {
    document.querySelectorAll('.keyboard-focused').forEach(item => item.classList.remove('keyboard-focused'));
    element.classList.add('keyboard-focused');
    element.focus({ preventScroll: true });
    element.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  document.addEventListener('focusin', event => {
    document.querySelectorAll('.keyboard-focused').forEach(item => item.classList.remove('keyboard-focused'));
    event.target?.classList?.add('keyboard-focused');
  });

  document.addEventListener('pointerdown', () => {
    document.querySelectorAll('.keyboard-focused').forEach(item => item.classList.remove('keyboard-focused'));
  }, true);

  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.altKey || event.metaKey || editable(event.target)) return;
    if (!['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight'].includes(event.key)) return;
    const active = document.activeElement && document.activeElement !== document.body ? document.activeElement : focusables()[0];
    if (!active) return;
    const firstBibleResult = document.querySelector('#bible-verse p');
    const returnToBibleInput = event.key === 'ArrowUp' && firstBibleResult &&
      (active === firstBibleResult || firstBibleResult.contains(active));
    const bibleInput = returnToBibleInput ? document.getElementById('bible-input') : null;
    const target = bibleInput && !bibleInput.disabled && visible(bibleInput)
      ? bibleInput : directionalTarget(active, event.key);
    if (!target) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    markFocus(target);
  }, true);
})();
