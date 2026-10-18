/* Real account menu for the header profile dropdown. Signs in with an Otra
   Guide account through the same-origin /api/login, /api/me, /api/logout
   endpoints (HttpOnly cookie session). */
(function () {
  "use strict";
  var panel = document.querySelector("[data-account-panel]");
  if (!panel) return;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, function (c) {
      return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c];
    });
  }

  function call(path, method, body) {
    var opts = { method: method, credentials: "same-origin", headers: { Accept: "application/json" } };
    if (body) {
      opts.headers["Content-Type"] = "application/json";
      opts.body = JSON.stringify(body);
    }
    return fetch(path, opts);
  }

  // Event pages show staff-only content, so they reload after the state changes.
  // Only a staff change alters the page, so a buyer keeps their checkout picks.
  var staffNow = false;
  function changed(staffAfter) {
    var before = staffNow;
    staffNow = !!staffAfter;
    if ((before || staffNow) && document.getElementById("evRates")) location.reload();
  }

  function renderSignedOut() {
    panel.innerHTML =
      '<form class="acct-form" novalidate>' +
      "<h3>Sign in</h3>" +
      '<p class="acct-sub">Use your Otra Guide account</p>' +
      '<input type="email" name="email" placeholder="Email" autocomplete="email" aria-label="Email" required />' +
      '<input type="password" name="password" placeholder="Password" autocomplete="current-password" aria-label="Password" required />' +
      '<p class="acct-error" role="alert" hidden></p>' +
      '<button class="acct-btn" type="submit">Sign in</button>' +
      '<div class="acct-links">' +
      '<a href="https://www.otraguide.com/accounts/signup/" target="_blank" rel="noopener">Create an account</a>' +
      '<a href="https://www.otraguide.com/accounts/password/reset/" target="_blank" rel="noopener">Forgot password?</a>' +
      "</div></form>";
    var form = panel.querySelector("form");
    var err = form.querySelector(".acct-error");
    var btn = form.querySelector(".acct-btn");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      var email = form.email.value.trim();
      var password = form.password.value;
      function fail(msg) { err.textContent = msg; err.hidden = false; btn.disabled = false; btn.textContent = "Sign in"; }
      if (!email || !password) return fail("Enter your email and password.");
      err.hidden = true;
      btn.disabled = true;
      btn.textContent = "Signing in...";
      call("/api/login", "POST", { email: email, password: password })
        .then(function (res) {
          return res.json().catch(function () { return {}; }).then(function (data) {
            if (res.ok && data.user) { renderSignedIn(data.user); changed(data.user.isStaff); return; }
            if (res.status === 401 || res.status === 429) return fail(data.error || "Wrong email or password.");
            fail("Sign in is unavailable right now. Please try again.");
          });
        })
        .catch(function () { fail("Sign in is unavailable right now. Please try again."); });
    });
  }

  function renderSignedIn(user) {
    var name = user.name || user.email || "Your account";
    panel.innerHTML =
      '<div class="profile-id">' +
      '<div class="avatar">' + esc(name.charAt(0).toUpperCase()) + "</div>" +
      '<div class="who"><b>' + esc(name) + "</b><span>" + esc(user.email || "") + "</span></div>" +
      "</div>" +
      '<a class="dd-link" href="https://www.otraguide.com/tickets/" target="_blank" rel="noopener">My tickets</a>' +
      '<a class="dd-link" href="https://www.otraguide.com/users/profile/" target="_blank" rel="noopener">Account settings</a>' +
      (user.isStaff ? '<a class="dd-link" href="/admin">Admin</a>' : "") +
      '<div class="dd-sep"></div>' +
      '<button class="dd-link signout acct-btn" type="button" data-account-signout>Sign out</button>';
    panel.querySelector("[data-account-signout]").addEventListener("click", function () {
      var signout = panel.querySelector("[data-account-signout]");
      var note = panel.querySelector(".acct-signout-error");
      if (note) note.remove();
      function failSignOut() {
        var p = document.createElement("p");
        p.className = "acct-error acct-signout-error";
        p.setAttribute("role", "alert");
        p.textContent = "Could not sign out. Please try again.";
        panel.appendChild(p);
        signout.disabled = false;
      }
      signout.disabled = true;
      call("/api/logout", "POST")
        .then(function (res) {
          if (!res.ok) return failSignOut();
          renderSignedOut();
          changed(false);
        })
        .catch(failSignOut);
    });
  }

  renderSignedOut();
  call("/api/me", "GET")
    .then(function (res) { return res.json(); })
    .then(function (data) { if (data && data.signedIn && data.user) { staffNow = !!data.user.isStaff; renderSignedIn(data.user); } })
    .catch(function () {});
})();
