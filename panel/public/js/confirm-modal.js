(function() {
  var style = document.createElement('style');
  style.textContent = '.confirm-modal-overlay{display:none;position:fixed;inset:0;background:rgba(27,67,50,0.6);z-index:10000;align-items:center;justify-content:center;padding:1rem}.confirm-modal-overlay.is-active{display:flex}.confirm-modal-dialog{background:#fff;border-radius:8px;border:1px solid #b7d4bc;box-shadow:0 8px 32px rgba(0,0,0,0.2);max-width:420px;width:100%;padding:1.5rem}.confirm-modal-dialog .confirm-modal-msg{margin:0 0 1.25rem 0;color:#1b4332;font-size:1rem;line-height:1.45}.confirm-modal-dialog .confirm-modal-actions{display:flex;flex-wrap:wrap;gap:.75rem;justify-content:flex-end}.confirm-modal-dialog .confirm-modal-actions .btn{padding:.5rem 1rem;border:none;border-radius:6px;font-size:.95rem;cursor:pointer;font-family:inherit;font-weight:500}.confirm-modal-dialog .confirm-modal-actions .btn-cancel{background:#e8f5e9;color:#2d6a4f}.confirm-modal-dialog .confirm-modal-actions .btn-cancel:hover{background:#b7d4bc;color:#1b4332}.confirm-modal-dialog .confirm-modal-actions .btn-confirm{background:#2d6a4f;color:#fff}.confirm-modal-dialog .confirm-modal-actions .btn-confirm:hover{background:#1b4332;color:#fff}.confirm-modal-dialog .confirm-modal-actions .btn-confirm.btn-danger{background:#b91c1c}.confirm-modal-dialog .confirm-modal-actions .btn-confirm.btn-danger:hover{background:#991b1b}';
  document.head.appendChild(style);

  var overlay = document.createElement('div');
  overlay.className = 'confirm-modal-overlay';
  overlay.setAttribute('role', 'dialog');
  overlay.setAttribute('aria-modal', 'true');
  overlay.setAttribute('aria-labelledby', 'confirm-modal-msg');
  overlay.id = 'confirm-modal-overlay';
  overlay.innerHTML = '<div class="confirm-modal-dialog"><p class="confirm-modal-msg" id="confirm-modal-msg"></p><div class="confirm-modal-actions"><button type="button" class="btn btn-cancel" id="confirm-modal-cancel">Cancel</button><button type="button" class="btn btn-confirm btn-danger" id="confirm-modal-confirm">Confirm</button></div></div>';
  document.body.appendChild(overlay);

  var msgEl = document.getElementById('confirm-modal-msg');
  var cancelBtn = document.getElementById('confirm-modal-cancel');
  var confirmBtn = document.getElementById('confirm-modal-confirm');
  var pendingForm = null;

  function closeModal() {
    overlay.classList.remove('is-active');
    pendingForm = null;
  }

  function showModal(message) {
    msgEl.textContent = message || 'Are you sure?';
    overlay.classList.add('is-active');
    cancelBtn.focus();
  }

  cancelBtn.addEventListener('click', closeModal);
  confirmBtn.addEventListener('click', function() {
    if (pendingForm) {
      pendingForm.removeAttribute('data-confirm');
      pendingForm.submit();
    }
    closeModal();
  });

  overlay.addEventListener('click', function(e) {
    if (e.target === overlay) closeModal();
  });

  document.addEventListener('keydown', function(e) {
    if (!overlay.classList.contains('is-active')) return;
    if (e.key === 'Escape') { e.preventDefault(); closeModal(); }
  });

  document.addEventListener('submit', function(e) {
    var form = e.target.closest('form[data-confirm]');
    if (!form) return;
    var message = form.getAttribute('data-confirm');
    if (!message) return;
    e.preventDefault();
    pendingForm = form;
    showModal(message);
  });
})();
