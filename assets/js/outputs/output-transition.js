(function (root) {
  'use strict';

  // The caller owns media/stream resources. A false result means its candidate
  // was superseded or hidden and must be released, not reported as live.
  function create(output) {
    let current = null;
    let generation = 0;
    let animations = [];
    output.classList.add('transition-host');

    function cancelAnimations() {
      for (const animation of animations) animation.cancel();
      animations = [];
    }

    // Do not detach retained nodes: doing so reloads embedded stream players.
    function retain(...elements) {
      for (const child of Array.from(output.children)) {
        if (!elements.includes(child)) child.remove();
      }
      for (const element of elements) {
        if (element && element.parentNode !== output) output.append(element);
      }
    }

    function restoreCurrent(candidate = null) {
      cancelAnimations();
      retain(...[current, candidate].filter(Boolean));
      output.classList.toggle('visible', Boolean(current));
    }

    async function show(element, options = {}) {
      const version = ++generation;
      restoreCurrent(element);
      const previous = current;
      const type = ['fade', 'dip'].includes(options.type) ? options.type : 'cut';
      const reduced = root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const duration = reduced || type === 'cut' ? 0 : [150, 300, 500].includes(options.duration) ? options.duration : 300;
      element.style.objectFit = options.fit === 'cover' ? 'cover' : 'contain';
      element.classList.add('output-layer');
      element.style.opacity = '';
      output.classList.add('visible');

      if (!duration || typeof element.animate !== 'function') {
        current = element;
        retain(element);
        return true;
      }

      if (type === 'dip') {
        const black = output.ownerDocument.createElement('div');
        black.className = 'output-blackout';
        black.setAttribute('aria-hidden', 'true');
        output.prepend(black);
      }
      if (element.parentNode !== output) output.append(element);
      const timing = { duration, easing: 'linear', fill: 'both' };
      const incoming = type === 'dip'
        ? [{ opacity: 0, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 1, offset: 1 }]
        : [{ opacity: 0 }, { opacity: 1 }];
      const outgoing = type === 'dip'
        ? [{ opacity: 1, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 0, offset: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }];
      const running = [element.animate(incoming, timing)];
      if (previous) running.push(previous.animate(outgoing, timing));
      animations = running;
      await Promise.all(running.map(animation => animation.finished.catch(() => {})));
      if (version !== generation) return false;
      current = element;
      retain(element);
      cancelAnimations();
      return true;
    }

    async function hide(options = {}) {
      const version = ++generation;
      const previous = current;
      current = null;

      const type = ['fade', 'dip'].includes(options.type) ? options.type : 'cut';
      const reduced = root.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
      const duration = reduced || type === 'cut' ? 0 : [150, 300, 500].includes(options.duration) ? options.duration : 300;

      if (!duration || !previous || typeof previous.animate !== 'function') {
        restoreCurrent();
        output.classList.remove('cover');
        return true;
      }

      cancelAnimations();

      if (type === 'dip') {
        const black = output.ownerDocument.createElement('div');
        black.className = 'output-blackout';
        black.setAttribute('aria-hidden', 'true');
        output.prepend(black);
      }

      const timing = { duration, easing: 'linear', fill: 'both' };
      const outgoing = type === 'dip'
        ? [{ opacity: 1, offset: 0 }, { opacity: 0, offset: 0.5 }, { opacity: 0, offset: 1 }]
        : [{ opacity: 1 }, { opacity: 0 }];

      const running = [previous.animate(outgoing, timing)];
      animations = running;

      await Promise.all(running.map(animation => animation.finished.catch(() => {})));
      if (version !== generation) return false;

      restoreCurrent();
      output.classList.remove('cover');
      cancelAnimations();
      return true;
    }

    function cancel() {
      generation++;
      restoreCurrent();
    }

    function destroy() {
      generation++;
      current = null;
      cancelAnimations();
      restoreCurrent();
      output.classList.remove('cover');
    }

    return { show, hide, cancel, destroy };
  }

  root.EmberstageTransition = { create };
})(globalThis);
