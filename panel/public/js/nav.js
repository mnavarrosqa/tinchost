(function() {
  var nav = document.getElementById('main-nav');
  var toggle = document.getElementById('nav-toggle');
  var menu = document.getElementById('nav-menu');
  if (!nav || !toggle || !menu) return;

  function open() {
    nav.classList.add('nav-open');
    toggle.setAttribute('aria-expanded', 'true');
  }

  function close() {
    nav.classList.remove('nav-open');
    toggle.setAttribute('aria-expanded', 'false');
  }

  function toggleMenu() {
    if (nav.classList.contains('nav-open')) close();
    else open();
  }

  toggle.addEventListener('click', function() {
    toggleMenu();
  });

  document.addEventListener('click', function(e) {
    if (nav.classList.contains('nav-open') && !nav.contains(e.target)) close();
  });

  document.addEventListener('keydown', function(e) {
    if (e.key === 'Escape' && nav.classList.contains('nav-open')) {
      close();
      toggle.focus();
    }
  });
})();
