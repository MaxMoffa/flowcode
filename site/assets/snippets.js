/* Small live windows in the pages: [data-snippet="delegate|phone|git|themes|plugins"].
   Same markup and classes as the app's components (see app.css). */
(function () {
  "use strict";
  var FC = window.FC;
  if (!FC) return;
  var el = FC.el, esc = FC.esc, sleep = FC.sleep, AGENTS = FC.AGENTS, logo = FC.logo;

  function svg(inner, s, w) { return '<svg viewBox="0 0 24 24" width="' + (s || 16) + '" height="' + (s || 16) + '" fill="none" stroke="currentColor" stroke-width="' + (w || 2) + '" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + inner + "</svg>"; }
  var I = {
    replay: svg('<path d="M4.5 12a7.5 7.5 0 1 0 2.2-5.3"/><path d="M4.5 4.5v4h4"/>', 11),
    plus: svg('<path d="M12 6v12M6 12h12"/>', 12),
    minus: svg('<path d="M6 12h12"/>', 12),
    branch: svg('<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3.5-10.5 6.3"/>', 13, 1.7),
    send: svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>', 15, 2.4),
    back: svg('<path d="M15 6l-6 6 6 6"/>', 18),
    dots: '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="5.5" cy="12" r="1.8"/><circle cx="12" cy="12" r="1.8"/><circle cx="18.5" cy="12" r="1.8"/></svg>',
    chev: svg('<polyline points="6 9 12 15 18 9"/>', 14, 2.2),
    swap: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>', 16),
    dChev: '<svg class="chat-dstrip-chev" viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 6l6 6-6 6"/></svg>',
    groupChev: '<svg class="chat-group-chevron" viewBox="0 0 24 24" width="11" height="11" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="9 6 15 12 9 18"/></svg>',
    modeAsk: svg('<path d="M8 13V5.5a1.5 1.5 0 013 0V12M11 11V4a1.5 1.5 0 013 0v8M14 11V6a1.5 1.5 0 013 0v8c0 4-2.5 6-5.5 6S7 18.5 5.5 15.5L4 12.5a1.4 1.4 0 012.4-1.4L8 13"/>', 15, 1.8),
    rocket: svg('<path d="M12 15l-3-3c1.5-4.5 5-8 10-8 0 5-3.5 8.5-8 10z"/><path d="M9 12H5l2-4h4M12 15v4l4-2v-4"/>', 16, 1.7),
    pulse: svg('<path d="M3 12h4l2-5 4 10 2-5h6"/>', 16, 1.7),
    box: svg('<path d="M4 8l8-4 8 4-8 4zM4 8v8l8 4 8-4V8M12 12v8"/>', 16, 1.7),
    clear: svg('<path d="M4 15.5 13.5 6a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L8.5 20H4z"/><line x1="12" y1="20" x2="20.5" y2="20"/>', 16, 1.8)
  };

  /* a small window: three dots, a title, one card */
  function miniWindow(title, opts) {
    opts = opts || {};
    var card = el("div", { class: "panel-card" });
    var head = el("div", { class: "app-headerbar" }, [el("div", { class: "fc-dots", "aria-hidden": "true" }, [el("i"), el("i"), el("i")]), el("span", { class: "fc-title", text: title })]);
    var w = el("div", { class: "fc mini", role: "region", "aria-label": opts.label || title }, [head, el("div", { class: "app-body" }, card)]);
    if (opts.replay) {
      var rb = el("button", { class: "fc-replay", type: "button", html: I.replay + "Replay" });
      rb.addEventListener("click", opts.replay);
      w.append(rb);
    }
    w.head = head;
    w.card = card;
    return w;
  }
  function chatColumn() {
    var column = el("div", { class: "chat-column" });
    var content = el("div", { class: "chat-content", "aria-live": "polite" });
    column.append(content);
    column.content = content;
    return column;
  }
  function header(agentId, status) {
    var a = AGENTS[agentId];
    return '<div class="chat-header" style="--ag:' + a.color + '"><div class="chat-menu-anchor"><span class="chat-session"><span class="chat-session-icon">' + logo(agentId) + '</span><span class="chat-session-title">flowcode</span>' + svg('<polyline points="6 9 12 15 18 9"/>', 12, 2.2).replace("<svg", '<svg class="chat-session-chevron"') + '</span></div><span class="chat-status-text">' + status[0] + '</span><span class="chat-status-dot is-' + status[1] + '" aria-hidden="true"></span></div>';
  }
  function setStatus(w, text, cls) { var t = w.querySelector(".chat-status-text"), d = w.querySelector(".chat-status-dot"); if (t) t.textContent = text; if (d) d.className = "chat-status-dot is-" + cls; }
  function composerHTML(model) {
    return '<div class="chat-composer-wrap" aria-hidden="true"><div class="chat-composer"><div class="chat-input" style="min-height:24px;color:var(--fg-muted)">Write a message…</div><div class="chat-composer-actions"><span class="chat-mode-pill is-mode">' + I.modeAsk + '</span><span class="chat-mode-pill is-model">' + esc(model) + '</span><span class="chat-actions-spacer"></span><span class="chat-icon-btn is-send" style="opacity:.35">' + I.send + "</span></div></div></div>";
  }

  /* ---------------------------------------------------------- delegation (chat/DelegateCards.tsx strip) */
  function delegate(host) {
    var run = 0;
    var w = miniWindow("flowcode", { label: "Delegation demo", replay: function () { play(); } });
    w.style.height = "520px";
    var view = el("div", { class: "chat-view" });
    view.innerHTML = header("claude", ["Ready", "idle"]);
    var column = chatColumn(), content = column.content;
    view.append(column);
    view.insertAdjacentHTML("beforeend", composerHTML(AGENTS.claude.model));
    w.card.append(view);
    host.append(w);

    function strip(items) {
      var s = el("div", { class: "chat-dstrip is-open" });
      s.paint = function () {
        var running = items.filter(function (d) { return d.st === "running"; }).length, doneN = items.length - running;
        var sum = (running ? '<span class="chat-dstrip-count is-running"><i></i>' + running + " running</span>" : "") + (doneN ? '<span class="chat-dstrip-count is-done"><i></i>' + doneN + " done</span>" : "");
        var open = running > 0;
        s.className = "chat-dstrip" + (open ? " is-open" : "");
        s.innerHTML = '<div class="chat-dstrip-head"><span class="chat-dstrip-swap">' + I.swap + '</span><b class="chat-dstrip-label">' + items.length + ' delegations</b><span class="chat-dstrip-stack">' +
          items.map(function (d) { return '<span class="chat-dstrip-logo" style="--agent:' + AGENTS[d.agent].color + '">' + logo(d.agent) + "</span>"; }).join("") + '</span><span class="chat-dstrip-sum">' + sum + "</span>" + I.dChev + "</div>" +
          (open || s.forceOpen ? '<div class="chat-dstrip-rows">' + items.map(function (d) {
            return '<div class="chat-dstrip-row is-' + d.st + '" style="--agent:' + AGENTS[d.agent].color + '"><span class="chat-dstrip-ic">' + (d.st === "done" ? "✓" : '<span class="chat-spinner" aria-hidden="true"></span>') + '</span><span class="chat-dstrip-logo is-row">' + logo(d.agent) + '</span><span class="chat-dstrip-title">' + esc(d.title) + '</span><span class="chat-dstrip-sep" aria-hidden="true">—</span><span class="chat-dstrip-live' + (d.st === "running" ? " is-mono" : "") + '">' + esc(d.live) + '</span><span class="chat-dstrip-time">' + (d.st === "done" ? d.secs + "s" : d.steps + " steps") + "</span></div>";
          }).join("") + "</div>" : "");
      };
      s.paint();
      return s;
    }
    async function progress(d, s, phases, end, my) {
      for (var i = 0; i < phases.length; i++) { await sleep(800 + i * 150); if (my !== run) return; d.steps = i + 1; d.live = phases[i]; s.paint(); }
      await sleep(700); if (my !== run) return;
      d.st = "done"; d.live = end; s.paint();
    }
    async function play() {
      var my = ++run, ok = function () { return my === run; };
      content.innerHTML = "";
      setStatus(w, "Working", "busy");
      content.append(el("div", { class: "chat-user", text: "Plan the auth refactor. Codex implements, Gemini checks the OAuth docs." }));
      await sleep(600); if (!ok()) return;
      var m = el("div", { class: "chat-md" }); content.append(m);
      await FC.stream(m, "<p>Plan, in three steps:</p><ul><li>move token refresh into <code>session.ts</code></li><li>drop the duplicate guard in <code>App.tsx</code></li><li>cover both with tests</li></ul><p>Handing off through the Flowcode MCP server.</p>", { onStep: function () { column.scrollTop = column.scrollHeight; } });
      if (!ok()) return;
      var items = [{ agent: "codex", title: "Implement steps 1 and 2", st: "running", live: "starting…", steps: 0, secs: 52 }, { agent: "gemini", title: "Check the OAuth refresh rules", st: "running", live: "starting…", steps: 0, secs: 31 }];
      var s = strip(items); content.append(s); column.scrollTop = column.scrollHeight;
      await Promise.all([
        progress(items[0], s, ["Read src/auth/session.ts", "Edit src/auth/session.ts", "Edit src/App.tsx", "Run npm test"], "+48 −12, tests pass", my),
        progress(items[1], s, ["Fetch oauth.net/2/refresh-tokens", "Read docs/auth.md"], "3 notes on token rotation", my)
      ]);
      if (!ok()) return;
      var m2 = el("div", { class: "chat-md" }); content.append(m2);
      await FC.stream(m2, "<p>Both are back. Codex changed 2 files and the tests pass; Gemini confirms refresh tokens rotate on every use, which the new code handles. Want me to review the diff?</p>", { onStep: function () { column.scrollTop = column.scrollHeight; } });
      if (ok()) setStatus(w, "Ready", "idle");
    }
    FC.onVisible(w, play);
  }

  /* ---------------------------------------------------------- phone (mobile/src: SessionTop, ChatPermission, ChatComposer) */
  function phoneEl() {
    var column = chatColumn();
    var fc = el("div", { class: "fc", style: "--ag:" + AGENTS.claude.color }, [
      el("div", { class: "ph-status", "aria-hidden": "true", html: "<span>9:41</span><i></i>" }),
      el("div", { class: "st-top", html: '<span class="st-btn" aria-hidden="true">' + I.back + '</span><span class="st-capsule"><i class="st-dot"></i><b>flowcode</b>' + I.chev + '</span><span class="st-btn" aria-hidden="true">' + I.dots + "</span>" }),
      column,
      el("div", { class: "ph-comp", "aria-hidden": "true", html: '<div class="chat-card"><span class="ph">Write a message…</span><div class="chat-actions"><span class="chat-mode-pill is-mode">' + I.modeAsk + '</span><span class="chat-mode-pill is-model">Opus 5.5</span><span class="chat-icon-btn is-send">' + I.send + '</span></div></div><div class="ph-bar"></div>' })
    ]);
    var ph = el("div", { class: "phone", role: "group", "aria-label": "Flowcode Android app" }, [el("div", { class: "notch", "aria-hidden": "true" }), el("div", { class: "scr" }, fc)]);
    ph.column = column;
    ph.fc = fc;
    return ph;
  }
  function phone(host) {
    var sync = host.dataset.mode === "sync";
    var ph = phoneEl(), link = null, desk = null;
    var replay = el("button", { class: "fc-replay", type: "button", html: I.replay + "Replay" });
    var cols = [ph.column];
    if (sync) {
      desk = miniWindow("flowcode", { label: "Desktop window" });
      var view = el("div", { class: "chat-view" });
      view.innerHTML = header("claude", ["Ready", "idle"]);
      var dcol = chatColumn();
      view.append(dcol);
      view.insertAdjacentHTML("beforeend", composerHTML("Opus 5.5"));
      desk.card.append(view);
      cols.unshift(dcol);
      link = el("div", { class: "sync-link", "aria-hidden": "true", html: '<i></i><span class="lk">iroh · e2e</span>' });
      host.append(el("div", { class: "sync-stage" }, [desk, link, ph]));
      desk.append(replay);
    } else {
      host.append(ph);
      replay.style.cssText = "position:static;margin:18px auto 0;display:flex";
      host.append(replay);
    }
    var run = 0;
    function add(make) { return cols.map(function (c) { var n = make(c === ph.column); c.content.append(n); c.scrollTop = c.scrollHeight; return n; }); }
    function text(html) { var ns = add(function () { return el("div", { class: "chat-md" }); }); return Promise.all(ns.map(function (n, i) { return FC.stream(n, html, { onStep: function () { cols[i].scrollTop = cols[i].scrollHeight; } }); })); }
    function state(txt, cls) { if (desk) setStatus(desk, txt, cls); ph.fc.querySelector(".st-dot").className = "st-dot" + (cls === "idle" ? "" : " is-" + cls); }
    function pulse(rtl) { if (!link) return; link.classList.remove("is-on", "rtl"); void link.offsetWidth; link.classList.add("is-on"); if (rtl) link.classList.add("rtl"); }
    function permission(cmd, my) {
      return new Promise(function (resolve) {
        var cards = add(function (isPhone) {
          var c;
          if (isPhone) {
            c = el("div", { class: "chat-perm-card", html: '<span class="chat-perm-eyebrow">Permission needed</span><div>Run ' + esc(cmd) + '</div><div class="chat-perm-where">~/flowcode</div><div class="chat-perm-options"><button type="button" class="chat-perm-btn" data-v="reject">Reject</button><button type="button" class="chat-perm-btn is-primary" data-v="allow">Allow</button></div>' });
          } else {
            c = el("div", { class: "chat-permission", html: '<div class="chat-permission-text"><div class="chat-permission-label">Permission needed</div><div>Run ' + esc(cmd) + '</div><div class="chat-permission-detail">' + esc(cmd) + '</div></div><div class="chat-permission-options"><button type="button" class="chat-btn" data-v="reject">Reject</button><button type="button" class="chat-btn" data-v="always">Always allow</button><button type="button" class="chat-btn is-primary" data-v="allow">Allow</button></div>' });
          }
          c.addEventListener("click", function (e) {
            var b = e.target.closest("button"); if (!b || my !== run) return;
            var v = b.dataset.v === "reject" ? "reject" : "allow";
            cards.forEach(function (x) {
              x.classList.add("is-answered");
              var lab = x.querySelector(".chat-permission-label, .chat-perm-eyebrow");
              lab.textContent = "Answer: " + b.textContent + " · from the " + (isPhone ? "phone" : "desktop");
            });
            pulse(isPhone);
            resolve(v);
          });
          return c;
        });
      });
    }
    async function play() {
      var my = ++run, ok = function () { return my === run; };
      cols.forEach(function (c) { c.content.innerHTML = ""; });
      state("Working", "busy");
      add(function () { return el("div", { class: "chat-user", text: "Run the tests and push if they're green" }); });
      pulse(false);
      await sleep(700); if (!ok()) return;
      await text("<p>Running the test suite first.</p>"); if (!ok()) return;
      state("Waiting for permission", "waiting");
      pulse(false);
      var v = await permission("npm test", my); if (!ok()) return;
      state("Working", "busy");
      await sleep(400); if (!ok()) return;
      if (v === "reject") { await text("<p>Okay, I won't run it. Tell me when you want me to continue.</p>"); state("Ready", "idle"); return; }
      var groups = add(function () { return el("div", { class: "chat-tools", html: '<div class="chat-tools-head">' + I.groupChev + '<span class="chat-group-count">1</span><span class="chat-spinner" aria-hidden="true"></span><span class="chat-group-summary is-live">Run npm test</span></div>' }); });
      await sleep(1300); if (!ok()) return;
      groups.forEach(function (g) { g.querySelector(".chat-tools-head").innerHTML = I.groupChev + '<span class="chat-group-count">2</span><span class="chat-tools-status"></span><span class="chat-group-summary">2 commands</span>'; });
      pulse(false);
      await text("<p>All 16 tests pass. Pushed to <code>origin/master</code>.</p>");
      if (ok()) { state("Ready", "idle"); pulse(false); }
    }
    replay.addEventListener("click", play);
    FC.onVisible(host, play);
  }

  /* ---------------------------------------------------------- Git panel (git/GitPanel, inside the Explorer's Git drawer) */
  function git(host) {
    var start = [["src/auth/redirect.ts", "M"], ["src/App.tsx", "M"], ["tests/redirect.test.ts", "U"], ["README.md", "M"]];
    var files, ahead, msg;
    var w = miniWindow("Explorer · Git", { label: "Git panel demo", replay: function () { reset(); } });
    w.style.height = "430px";
    var head = el("div", { class: "git-header" });
    var input = el("input", { class: "git-commit-input", type: "text", "aria-label": "Commit message", placeholder: "Message (Enter to commit)" });
    var commit = el("button", { class: "git-commit-btn", type: "button", text: "Commit" });
    var body = el("div", { style: "overflow:auto;flex:1 1 auto" });
    w.card.append(el("div", { class: "git-panel" }, [head, el("div", { class: "git-commit-box" }, [input, commit]), body]));
    host.append(w);
    function reset() { files = start.map(function (f) { return { path: f[0], st: f[1], staged: f[0] === "src/auth/redirect.ts" }; }); ahead = 0; msg = null; input.value = "fix(auth): stop the login redirect loop"; render(); }
    function render() {
      head.innerHTML = I.branch + "master" + '<span class="sync">' + (ahead ? "↑" + ahead + " to push" : "up to date") + "</span>";
      body.innerHTML = "";
      var staged = files.filter(function (f) { return f.staged; }), changes = files.filter(function (f) { return !f.staged; });
      commit.disabled = !staged.length || !input.value.trim();
      if (msg) body.append(el("div", { class: "git-done", text: msg }));
      [["Staged", staged, true], ["Changes", changes, false]].forEach(function (g) {
        body.append(el("div", { class: "git-group-header", html: esc(g[0]) + ' <span class="git-count">' + g[1].length + "</span>" }));
        var ul = el("ul", { class: "git-list" });
        if (!g[1].length) ul.append(el("li", { class: "git-none", text: g[2] ? "Nothing staged" : "No changes" }));
        g[1].forEach(function (f) {
          var name = f.path.split("/").pop(), dir = f.path.slice(0, -name.length - 1);
          var btn = el("button", { type: "button", "aria-label": (g[2] ? "Unstage " : "Stage ") + f.path, title: g[2] ? "Unstage" : "Stage", html: g[2] ? I.minus : I.plus });
          btn.addEventListener("click", function () { f.staged = !g[2]; render(); var again = body.querySelector('[aria-label$="' + f.path + '"]'); if (again) again.focus(); });
          ul.append(el("li", { class: "git-row" }, [el("span", { class: "git-row-name", text: name }), el("span", { class: "git-row-dir", text: dir }), el("span", { class: "git-status git-status-" + f.st, text: f.st }), btn]));
        });
        body.append(ul);
      });
      if (ahead) {
        var push = el("button", { type: "button", class: "git-push", text: "Push ↑" + ahead });
        push.addEventListener("click", function () { ahead = 0; msg = "Pushed to origin/master."; render(); });
        body.append(push);
      }
    }
    function doCommit() {
      var staged = files.filter(function (f) { return f.staged; });
      if (!staged.length || !input.value.trim()) return;
      files = files.filter(function (f) { return !f.staged; });
      ahead++;
      msg = "Committed " + staged.length + (staged.length === 1 ? " file" : " files") + " to master.";
      input.value = "";
      render();
    }
    commit.addEventListener("click", doCommit);
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") doCommit(); });
    input.addEventListener("input", function () { commit.disabled = !files.some(function (f) { return f.staged; }) || !input.value.trim(); });
    reset();
  }

  /* ---------------------------------------------------------- palettes */
  function themes(host) {
    var w = miniWindow("flowcode", { label: "Palette preview" });
    w.card.innerHTML =
      '<div class="fc-term" style="overflow:hidden">' +
      '<div class="ln"><span class="c-acc">~/flowcode</span> <span class="c-acc2">master</span> <span class="c-mut">❯</span> git status --short</div>' +
      '<div class="ln"><span class="c-yel"> M</span> src/auth/redirect.ts</div><div class="ln"><span class="c-grn">??</span> tests/redirect.test.ts</div>' +
      '<div class="ln"><span class="c-acc">~/flowcode</span> <span class="c-acc2">master</span> <span class="c-mut">❯</span> npm test</div>' +
      '<div class="ln"><span class="c-grn"> ✓</span> 16 passed <span class="c-mut">in 1.2s</span></div>' +
      '<div class="ln"><span class="c-red"> ✗</span> <span class="c-mut">0 failed</span> · <span class="c-blu">coverage 91%</span> · <span class="c-mag">watch mode</span> · <span class="c-cyn">vitest</span></div>' +
      '<div class="ln"><span class="c-acc">~/flowcode</span> <span class="c-acc2">master</span> <span class="c-mut">❯</span> <span style="display:inline-block;width:7px;height:14px;vertical-align:-2px;background:var(--accent)"></span></div></div>';
    w.head.insertAdjacentHTML("beforeend", '<div class="term-tab is-active" style="position:absolute;left:84px;width:auto;max-width:150px" aria-hidden="true"><span class="term-tab-dot"></span><span class="term-tab-label">flowcode</span></div>');
    var cv = el("canvas", { "data-frog": "", "aria-hidden": "true", style: "position:absolute;right:18px;bottom:16px;width:60px;height:48px;image-rendering:pixelated;z-index:3" });
    w.append(cv);
    FC.drawFrog(cv);
    var list = el("div", { class: "swatches", role: "group", "aria-label": "Palettes", style: "flex-wrap:wrap;gap:8px" });
    Object.keys(FC.PALETTES).forEach(function (id) {
      var p = FC.PALETTES[id];
      var b = el("button", { type: "button", class: "btn btn-ghost btn-sm", "aria-pressed": String(id === "flowcode"), html: '<span class="swatch" aria-hidden="true" style="width:14px;height:14px;--sw-a:' + p.accent + ";--sw-b:rgb(" + p.bg + ')"></span>' + esc(p.name) });
      b.addEventListener("click", function () {
        FC.applyPalette(w, id);
        list.querySelectorAll("button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); });
      });
      list.append(b);
    });
    host.append(el("div", { class: "theme-demo" }, [w, list]));
  }

  /* ---------------------------------------------------------- plugins: shortcut buttons in the header bar (App.tsx quick-actions) */
  function plugins(host) {
    var w = miniWindow("flowcode", { label: "Plugin shortcuts demo" });
    var out = el("div", { class: "fc-term", style: "min-height:200px;max-height:230px", "aria-live": "polite" });
    var dlg = el("div", { class: "fc-dialog", role: "dialog", "aria-modal": "false", "aria-label": "Confirm", hidden: "", html: "<b>Deploy to staging</b><p>Deploy? This runs <code>npm run deploy</code> in the active terminal.</p>" });
    var cancel = el("button", { type: "button", class: "chat-btn", text: "Cancel" }), ok = el("button", { type: "button", class: "chat-btn is-primary", text: "Deploy" });
    dlg.append(el("div", { class: "acts" }, [cancel, ok]));
    function line(h) { out.append(el("div", { class: "ln", html: h })); out.scrollTop = out.scrollHeight; }
    function ps(cmd) { line('<span class="c-acc">~/flowcode</span> <span class="c-acc2">master</span> <span class="c-mut">❯</span> ' + esc(cmd)); }
    var deploy = el("button", { type: "button", class: "icon-button", title: "Deploy to staging", "aria-label": "Deploy to staging", html: I.rocket });
    var ci = el("button", { type: "button", class: "icon-button", title: "CI status", "aria-label": "CI status: passing", html: I.pulse });
    var dk = el("button", { type: "button", class: "icon-button", title: "Compose up", "aria-label": "Docker compose up", html: I.box });
    var clr = el("button", { type: "button", class: "icon-button", title: "Clear terminal", "aria-label": "Clear terminal", html: I.clear });
    var opener;
    deploy.addEventListener("click", function () { opener = deploy; dlg.hidden = false; ok.focus(); });
    cancel.addEventListener("click", function () { dlg.hidden = true; opener.focus(); });
    dlg.addEventListener("keydown", function (e) { if (e.key === "Escape") { dlg.hidden = true; opener.focus(); } });
    ok.addEventListener("click", async function () {
      dlg.hidden = true; deploy.focus();
      ps("npm run deploy");
      var steps = ['building… <span class="c-mut">vite build</span>', "uploading 42 files", '<span class="c-grn">✓</span> deployed to <span class="c-blu">staging</span> in 8.1s'];
      for (var i = 0; i < steps.length; i++) { await sleep(600); line(steps[i]); }
    });
    ci.addEventListener("click", function () { line('<span class="c-mut">CI status from your JSON endpoint, refreshed every minute:</span> <span class="c-grn">passing</span> · main · 2 min ago'); });
    dk.addEventListener("click", async function () {
      ps("docker compose up -d");
      var steps = ['<span class="c-grn">✔</span> Container pond-db   Started', '<span class="c-grn">✔</span> Container pond-api  Started'];
      for (var i = 0; i < steps.length; i++) { await sleep(450); line(steps[i]); }
    });
    clr.addEventListener("click", function () { out.innerHTML = ""; });
    w.head.querySelector(".fc-title").style.margin = "0 0 0 16px";
    w.head.append(el("div", { class: "header-right" }, el("div", { class: "quick-actions", role: "toolbar", "aria-label": "Shortcuts" }, [clr, deploy, ci, dk])));
    w.card.append(out);
    w.append(dlg);
    line('<span class="c-mut">The buttons top right are plugin shortcuts. Each one is a few lines of JSON.</span>');
    host.append(w);
  }

  var MAP = { delegate: delegate, phone: phone, git: git, themes: themes, plugins: plugins };
  document.querySelectorAll("[data-snippet]").forEach(function (n) { var f = MAP[n.dataset.snippet]; if (f) f(n); });
})();
