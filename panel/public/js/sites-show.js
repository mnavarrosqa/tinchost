(function() {
  var TAB_IDS = ["overview", "databases", "ftp", "ssl", "php", "scripts", "node-apps"];
  function getTabFromHash() {
    var hash = (window.location.hash || "").replace(/^#/, "");
    var panel = hash ? document.getElementById("panel-" + hash) : null;
    return (TAB_IDS.indexOf(hash) >= 0 && panel) ? hash : "overview";
  }
  function switchTab(id) {
    TAB_IDS.forEach(function(tabId) {
      var panel = document.getElementById("panel-" + tabId);
      var trigger = document.getElementById("tab-" + tabId);
      if (panel) panel.classList.toggle("is-active", tabId === id);
      if (trigger) trigger.classList.toggle("is-active", tabId === id);
    });
    window.location.hash = id;
  }
  document.addEventListener("click", function(e) {
    var trigger = e.target.closest(".tabs-trigger");
    if (trigger && trigger.dataset.tab) {
      e.preventDefault();
      switchTab(trigger.dataset.tab);
    }
  });
  window.addEventListener("hashchange", function() { switchTab(getTabFromHash()); });
  switchTab(getTabFromHash());

  document.addEventListener("click", function(e) {
    var btn = e.target.closest(".show-pwd-btn");
    if (!btn) return;
    var c = btn.closest(".password-cell");
    if (!c) return;
    var pwd = c.querySelector(".pwd-value");
    var hint = c.querySelector(".show-hint");
    if (pwd && pwd.textContent) {
      pwd.style.display = "inline";
      pwd.classList.add("password");
    } else if (hint) {
      hint.style.display = "inline";
    }
    var mask = c.querySelector(".pwd-mask");
    if (mask) mask.style.display = "none";
    btn.style.display = "none";
  });

  document.addEventListener("click", function(e) {
    var btn = e.target.closest(".js-copy-password");
    if (!btn) return;
    var el = btn.closest(".credential-box") && btn.closest(".credential-box").querySelector(".password");
    if (el && navigator.clipboard) {
      navigator.clipboard.writeText(el.textContent);
      btn.textContent = "Copied";
      var t = btn;
      setTimeout(function() { t.textContent = "Copy"; }, 1500);
    }
  });

  var sel = document.getElementById("assign_user");
  var rowUser = document.getElementById("row-new-user");
  var rowPwd = document.getElementById("row-new-password");
  if (sel && rowUser) {
    function toggle() {
      var show = sel.value === "new";
      rowUser.style.display = show ? "block" : "none";
      rowPwd.style.display = show ? "block" : "none";
      var inp = rowUser.querySelector("input");
      var pwdInp = rowPwd.querySelector("input");
      if (inp) inp.required = show;
      if (pwdInp) pwdInp.required = show;
    }
    sel.addEventListener("change", toggle);
    toggle();
  }

  function getSiteBaseUrl(formAction) {
    return formAction.replace(/\/ssl\/(delete|install)$/, "");
  }

  function showSslOverlay(message) {
    var overlay = document.getElementById("ssl-progress-overlay");
    var msgEl = document.getElementById("ssl-progress-msg");
    if (msgEl) msgEl.textContent = message;
    if (overlay) overlay.classList.add("is-active");
  }

  function hideSslOverlay() {
    var overlay = document.getElementById("ssl-progress-overlay");
    if (overlay) overlay.classList.remove("is-active");
  }

  document.addEventListener("submit", function(e) {
    var form = e.target;
    if (!form || !form.classList.contains("js-ssl-delete-form")) return;
    e.preventDefault();
    var msg = form.getAttribute("data-confirm-msg") || "Remove SSL for this site?";
    if (!confirm(msg)) return;
    showSslOverlay("Removing SSL…");
    var baseUrl = getSiteBaseUrl(form.action);
    fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      headers: { "Accept": "text/html" }
    }).then(function(res) {
      var loc = res.headers.get("Location");
      if (res.redirected && res.url) {
        window.location.href = res.url;
      } else if (loc) {
        window.location.href = loc;
      } else {
        window.location.href = baseUrl + "?ssl=removed#ssl";
      }
    }).catch(function() {
      hideSslOverlay();
      window.location.href = baseUrl + "?ssl=error&msg=" + encodeURIComponent("Request failed") + "#ssl";
    });
  });

  document.addEventListener("submit", function(e) {
    var form = e.target;
    if (!form || !form.classList.contains("js-ssl-install-form")) return;
    e.preventDefault();
    showSslOverlay("Installing certificate…");
    var baseUrl = getSiteBaseUrl(form.action);
    fetch(form.action, {
      method: "POST",
      credentials: "same-origin",
      redirect: "manual",
      headers: { "Accept": "text/html" }
    }).then(function(res) {
      var loc = res.headers.get("Location");
      if (res.redirected && res.url) {
        window.location.href = res.url;
      } else if (loc) {
        window.location.href = loc;
      } else {
        window.location.href = baseUrl + "?ssl=install_error&msg=" + encodeURIComponent("Request failed") + "#ssl";
      }
    }).catch(function() {
      hideSslOverlay();
      window.location.href = baseUrl + "?ssl=install_error&msg=" + encodeURIComponent("Request failed") + "#ssl";
    });
  });
})();
