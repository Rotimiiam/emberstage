const menuToggle = document.querySelector('.menu-toggle');
const siteNav = document.querySelector('#site-nav');

if (menuToggle && siteNav) {
  menuToggle.hidden = false;
  menuToggle.closest('.site-header').dataset.menuReady = '';
  const closeMenu = () => {
    siteNav.classList.remove('is-open');
    menuToggle.setAttribute('aria-expanded', 'false');
  };
  menuToggle.addEventListener('click', () => {
    const open = siteNav.classList.toggle('is-open');
    menuToggle.setAttribute('aria-expanded', String(open));
  });
  siteNav.addEventListener('click', event => {
    if (event.target.closest('a')) closeMenu();
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && siteNav.classList.contains('is-open')) {
      closeMenu();
      menuToggle.focus();
    }
  });
}

const guideLinks = [...document.querySelectorAll('.guide-jump-nav a')];
const guideSections = guideLinks.map(link => document.querySelector(link.hash));
const setActiveSection = id => {
  guideLinks.forEach(link => {
    if (link.hash === `#${id}`) {
      link.setAttribute('aria-current', 'location');
      const nav = link.parentElement;
      if (nav.scrollWidth > nav.clientWidth) nav.scrollLeft = link.offsetLeft - 12;
    } else link.removeAttribute('aria-current');
  });
};

// Native anchors work without JavaScript; this only marks reading progress.
if ('IntersectionObserver' in window) {
  const observer = new IntersectionObserver(entries => {
    const current = entries.find(entry => entry.isIntersecting);
    if (current) setActiveSection(current.target.id);
  }, { rootMargin: '-15% 0px -70% 0px' });
  guideSections.filter(Boolean).forEach(section => observer.observe(section));
}
window.addEventListener('hashchange', () => setActiveSection(location.hash.slice(1)));
setActiveSection(location.hash.slice(1) || 'guide-orientation');
