(function() {
  var container = null;
  var defaultDuration = 4000;

  function getContainer() {
    if (container) return container;
    container = document.createElement('div');
    container.className = 'toast-container';
    container.setAttribute('aria-live', 'polite');
    container.setAttribute('role', 'status');
    document.body.appendChild(container);
    return container;
  }

  function show(message, duration) {
    if (!message) return;
    var el = document.createElement('div');
    el.className = 'toast';
    el.textContent = message;
    getContainer().appendChild(el);
    var d = duration != null ? duration : defaultDuration;
    setTimeout(function() {
      el.classList.add('toast--hide');
      setTimeout(function() {
        if (el.parentNode) el.parentNode.removeChild(el);
      }, 300);
    }, d);
  }

  if (typeof window !== 'undefined') {
    window.toast = { show: show };
  }
})();
