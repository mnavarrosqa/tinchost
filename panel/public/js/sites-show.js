(function() {
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

  document.addEventListener("submit", function(e) {
    var form = e.target.closest("form[data-confirm]");
    if (!form) return;
    var msg = form.getAttribute("data-confirm");
    if (msg && !confirm(msg)) e.preventDefault();
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
})();
