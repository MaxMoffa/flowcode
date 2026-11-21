/* The home page's live Flowcode window. Its structure, labels and icons copy
   the app's components (see the header of app.css for the file list): tab
   strip, sidebar (History / Explorer + Git drawer / Agent), terminal tabs with
   the agent header on top when an agent runs, the chat (session menu with
   Chat/Terminal pills, context pill + agent popover, tool groups, diffs,
   permission card, subagent tray, background terminals card, delegate strip),
   the browser panel and the New tab dialog. Everything is scripted. */
(function () {
  "use strict";
  var FC = window.FC;
  var root = document.querySelector('[data-demo="hero"]');
  if (!FC || !root) return;
  var el = FC.el, esc = FC.esc, sleep = FC.sleep, AGENTS = FC.AGENTS, logo = FC.logo;

  /* ---------------------------------------------------------- icons (copied from the app's components) */
  function svg(inner, o) {
    o = o || {};
    return '<svg viewBox="0 0 24 24" width="' + (o.s || 16) + '" height="' + (o.s || 16) + '" fill="none" stroke="currentColor" stroke-width="' + (o.w || 1.7) + '" stroke-linecap="round" stroke-linejoin="round"' + (o.cls ? ' class="' + o.cls + '"' : "") + ' aria-hidden="true">' + inner + "</svg>";
  }
  var I = {
    sidebar: svg('<rect x="3.5" y="4.5" width="17" height="15" rx="2.5"/><path d="M9.5 4.5v15"/><path class="sidebar-toggle-fill" d="M6 4.5h3.5v15H6a2.5 2.5 0 0 1-2.5-2.5V7A2.5 2.5 0 0 1 6 4.5z"/>'),
    plus: svg('<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>', { w: 2 }),
    close: svg('<line x1="6" y1="6" x2="18" y2="18"/><line x1="18" y1="6" x2="6" y2="18"/>', { w: 2 }),
    clear: svg('<path d="M4 15.5 13.5 6a2 2 0 0 1 2.8 0l1.7 1.7a2 2 0 0 1 0 2.8L8.5 20H4z"/><line x1="12" y1="20" x2="20.5" y2="20"/>', { w: 1.8 }),
    star: svg('<path d="M12 3.8l2.35 4.9 5.35.68-3.9 3.75.98 5.37L12 15.9l-4.78 2.6.98-5.37-3.9-3.75 5.35-.68z"/>'),
    features: svg('<rect x="3.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.5"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.5"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.5"/>'),
    kebab: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none" aria-hidden="true"><circle cx="12" cy="5.5" r="1.9"/><circle cx="12" cy="12" r="1.9"/><circle cx="12" cy="18.5" r="1.9"/></svg>',
    min: svg('<line x1="6" y1="12" x2="18" y2="12"/>', { w: 1.8 }),
    max: svg('<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/>', { w: 1.6 }),
    winClose: svg('<line x1="6.5" y1="6.5" x2="17.5" y2="17.5"/><line x1="17.5" y1="6.5" x2="6.5" y2="17.5"/>', { w: 1.8 }),
    chat: svg('<path d="M21 11.5a8.4 8.4 0 0 1-8.5 8.3 8.7 8.7 0 0 1-3.6-.8L3.5 20.5l1.6-4.8A8.1 8.1 0 0 1 4 11.5 8.4 8.4 0 0 1 12.5 3.2 8.4 8.4 0 0 1 21 11.5z"/>', { s: 13, w: 1.8 }),
    back: svg('<line x1="19" y1="12" x2="5" y2="12"/><polyline points="11 6 5 12 11 18"/>'),
    home: svg('<path d="M4 11.5 12 4.5l8 7"/><path d="M6 10.5V19a1 1 0 0 0 1 1h3.5v-5h3v5H17a1 1 0 0 0 1-1v-8.5"/>'),
    search: svg('<circle cx="10.5" cy="10.5" r="6.5"/><line x1="15.3" y1="15.3" x2="20.5" y2="20.5"/>'),
    folder: '<svg viewBox="0 0 24 24" width="15" height="15" fill="currentColor" stroke="none" aria-hidden="true"><path d="M3.5 6.5a1 1 0 0 1 1-1H9l2 2h8.5a1 1 0 0 1 1 1v9.5a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1z"/></svg>',
    branch: svg('<circle cx="6" cy="6" r="2.2"/><circle cx="6" cy="18" r="2.2"/><circle cx="18" cy="8" r="2.2"/><path d="M6 8.2v7.6M18 10.2c0 4-6 3.5-10.5 6.3"/>'),
    chevUp: '<svg class="git-dock-chev" viewBox="0 0 24 24" aria-hidden="true"><polyline points="6 15 12 9 18 15"/></svg>',
    sessChev: svg('<polyline points="6 9 12 15 18 9"/>', { s: 12, w: 2.2, cls: "chat-session-chevron" }),
    viewChat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>', { s: 15, w: 2 }),
    viewTerm: svg('<polyline points="4 17 10 11 4 5"/><line x1="12" y1="19" x2="20" y2="19"/>', { s: 15, w: 2 }),
    copy: svg('<rect x="9" y="9" width="13" height="13" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>', { s: 15, w: 2 }),
    stop: svg('<rect x="6" y="6" width="12" height="12" rx="2"/>', { s: 15, w: 2 }),
    groupChev: svg('<polyline points="9 6 15 12 9 18"/>', { s: 11, w: 2.6, cls: "chat-group-chevron" }),
    modeAsk: svg('<path d="M8 13V5.5a1.5 1.5 0 013 0V12M11 11V4a1.5 1.5 0 013 0v8M14 11V6a1.5 1.5 0 013 0v8c0 4-2.5 6-5.5 6S7 18.5 5.5 15.5L4 12.5a1.4 1.4 0 012.4-1.4L8 13"/>', { s: 15, w: 1.8 }),
    clip: svg('<path d="m21.4 11.6-9.2 9.2a6 6 0 0 1-8.5-8.5l9.2-9.2a4 4 0 0 1 5.7 5.7l-9.2 9.2a2 2 0 0 1-2.8-2.8l8.5-8.5"/>', { s: 19, w: 2 }),
    mic: svg('<rect x="9" y="3" width="6" height="11" rx="3"/><path d="M5 11a7 7 0 0 0 14 0"/><line x1="12" y1="18" x2="12" y2="21"/>', { s: 19, w: 2 }),
    send: svg('<line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/>', { s: 16, w: 2.4 }),
    stopFill: '<svg viewBox="0 0 24 24" width="13" height="13" fill="currentColor" stroke="none" aria-hidden="true"><rect x="6" y="6" width="12" height="12" rx="2"/></svg>',
    termCard: svg('<path d="m5 7 5 5-5 5m8 0h6"/>', { s: 14, w: 2.2 }),
    cardChev: svg('<path d="m6 15 6-6 6 6"/>', { s: 14, w: 2.2, cls: "chat-termcard-chev" }),
    swap: svg('<path d="M4 8h13l-3-3M20 16H7l3 3"/>', { s: 16, w: 2 }),
    dChev: svg('<path d="M9 6l6 6-6 6"/>', { s: 14, w: 2.4, cls: "chat-dstrip-chev" }),
    bBack: svg('<path d="M15 18l-6-6 6-6"/>', { w: 2 }),
    bFwd: svg('<path d="M9 18l6-6-6-6"/>', { w: 2 }),
    bReload: svg('<path d="M21 12a9 9 0 1 1-2.6-6.4L21 8"/><path d="M21 3v5h-5"/>', { w: 2 }),
    globe: svg('<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/>', { w: 2 }),
    more: svg('<path d="M5 12h.01M12 12h.01M19 12h.01"/>', { w: 2.6 }),
    bClose: svg('<path d="M6 6l12 12M18 6L6 18"/>', { w: 2 })
  };
  function fileIcon(name) {
    var ext = name.split(".").pop();
    if (/^(tsx?|jsx?|rs)$/.test(ext)) return '<span class="file-tree-icon ft-code">' + svg('<polyline points="9 8 4.5 12 9 16"/><polyline points="15 8 19.5 12 15 16"/>', { s: 15, w: 1.6 }) + "</span>";
    if (ext === "css") return '<span class="file-tree-icon ft-style">' + svg('<path d="M19.5 4.5 4 10l6.5 2.5L13 19z"/><path d="M14.5 9.5 19 14"/>', { s: 15, w: 1.6 }) + "</span>";
    if (ext === "html") return '<span class="file-tree-icon ft-markup">' + svg('<polyline points="8.5 7 4.5 12 8.5 17"/><polyline points="15.5 7 19.5 12 15.5 17"/><line x1="13.5" y1="6" x2="10.5" y2="18"/>', { s: 15, w: 1.6 }) + "</span>";
    if (/^(json|toml)$/.test(ext)) return '<span class="file-tree-icon ft-config">' + svg('<circle cx="12" cy="12" r="2.6"/><path d="M12 3.5v2.4M12 18.1v2.4M20.5 12h-2.4M5.9 12H3.5M17.7 6.3l-1.7 1.7M8 16l-1.7 1.7M17.7 17.7 16 16M8 8 6.3 6.3"/>', { s: 15, w: 1.6 }) + "</span>";
    if (ext === "md") return '<span class="file-tree-icon ft-doc">' + svg('<path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="14" y2="16"/>', { s: 15, w: 1.6 }) + "</span>";
    return '<span class="file-tree-icon ft-generic">' + svg('<path d="M6 3.5h8l4 4v13a1 1 0 0 1-1 1H6a1 1 0 0 1-1-1v-16a1 1 0 0 1 1-1z"/>', { s: 15, w: 1.6 }) + "</span>";
  }

  /* ---------------------------------------------------------- project state */
  var FS = {
    src: { "App.tsx": 1, "main.tsx": 1, auth: { "login.ts": 1, "redirect.ts": 1, "session.ts": 1 }, chat: { "Chat.tsx": 1, "chat.css": 1, "stream.ts": 1 }, terminal: { "Terminal.tsx": 1, "frogArt.ts": 1 } },
    "src-tauri": { src: { "lib.rs": 1, "main.rs": 1 }, "Cargo.toml": 1 },
    docs: { "agents-integration-map.md": 1 },
    site: { "index.html": 1 },
    tests: { "login.test.ts": 1 },
    "package.json": 1, "PLUGINS.md": 1, "README.md": 1, "LICENSE": 1, "notes.md": 1
  };
  var S = {
    palette: "flowcode",
    git: { "src/App.tsx": "M", "README.md": "M", "notes.md": "U" },
    staged: {},
    ahead: 0,
    fixed: false,
    tested: false,
    sideTab: "explorer",
    expDir: null,
    sel: null,
    dockOpen: false,
    pinned: false
  };
  function nodeAt(segs) {
    var n = FS;
    for (var i = 0; i < segs.length; i++) { if (!n || typeof n !== "object" || !(segs[i] in n)) return null; n = n[segs[i]]; }
    return n;
  }
  function sortedKeys(dir) {
    return Object.keys(dir).sort(function (a, b) {
      var da = typeof dir[a] === "object", db = typeof dir[b] === "object";
      return da === db ? a.localeCompare(b) : da ? -1 : 1;
    });
  }
  function resolve(cwd, arg) {
    var segs = arg.indexOf("~") === 0 ? [] : cwd.slice();
    arg.replace(/^~\/?/, "").split("/").forEach(function (p) {
      if (!p || p === ".") return;
      if (p === "..") segs.pop(); else segs.push(p);
    });
    return segs;
  }
  function pathLabel(segs) { return "~/" + ["flowcode"].concat(segs).join("/"); }
  function changeCount() { return Object.keys(S.git).length; }
  function accentNow() { return FC.PALETTES[S.palette].accent; }

  /* ---------------------------------------------------------- window */
  root.innerHTML = "";
  root.setAttribute("role", "region");
  root.setAttribute("aria-label", "Interactive Flowcode demo");

  var sidebarBtn = el("button", { class: "icon-button sidebar-toggle is-active", type: "button", "aria-pressed": "true", "aria-label": "Toggle sidebar", title: "Show/hide the sidebar", html: I.sidebar });
  var tabsVp = el("div", { class: "tab-strip-viewport", role: "tablist", "aria-label": "Tabs" });
  var newBtn = el("button", { class: "term-tab-new", type: "button", "aria-label": "New tab", title: "New tab (Ctrl+T)", html: I.plus });
  var clearBtn = el("button", { class: "icon-button", type: "button", "aria-label": "Clear terminal", title: "Clear terminal", html: I.clear });
  root.append(el("header", { class: "app-headerbar" }, [
    sidebarBtn,
    el("div", { class: "tab-strip" }, [tabsVp, newBtn]),
    el("div", { class: "header-right" }, [
      el("div", { class: "quick-actions hide-sm" }, clearBtn),
      el("span", { class: "icon-button hide-sm", title: "Favorites", "aria-hidden": "true", html: I.star }),
      el("span", { class: "icon-button hide-sm", title: "Features", "aria-hidden": "true", html: I.features }),
      el("span", { class: "icon-button hide-sm", title: "More options", "aria-hidden": "true", html: I.kebab }),
      el("div", { class: "window-controls", "aria-hidden": "true" }, [
        el("span", { class: "icon-button", html: I.min }), el("span", { class: "icon-button", html: I.max }), el("span", { class: "icon-button icon-button-close", html: I.winClose })
      ])
    ])
  ]));

  var side = el("div", { class: "panel-card fc-side" });
  var main = el("div", { class: "panel-card fc-main" });
  var browserCard = el("div", { class: "panel-card fc-browser-card", hidden: "" });
  var body = el("div", { class: "app-body" }, [side, main, browserCard]);
  root.append(body);
  sidebarBtn.addEventListener("click", function () {
    var on = side.hidden;
    side.hidden = !on;
    sidebarBtn.classList.toggle("is-active", on);
    sidebarBtn.setAttribute("aria-pressed", String(on));
    sidebarBtn.querySelector(".sidebar-toggle-fill").style.display = on ? "" : "none";
  });

  /* ---------------------------------------------------------- tabs */
  var tabs = [], active = null, uid = 0;
  function addTab(t, at) {
    t.id = "fc-t" + (++uid);
    t.btn = el("div", { class: "term-tab", role: "tab", id: t.id, "aria-selected": "false", tabindex: "-1" });
    t.pane.classList.add("fc-pane");
    t.pane.setAttribute("role", "tabpanel");
    t.pane.setAttribute("aria-labelledby", t.id);
    t.pane.hidden = true;
    t.btn.addEventListener("click", function (e) {
      if (e.target.closest(".term-tab-close")) { closeTab(t); return; }
      select(t, true);
    });
    if (at != null && tabs[at]) { tabsVp.insertBefore(t.btn, tabs[at].btn); tabs.splice(at, 0, t); }
    else { tabsVp.append(t.btn); tabs.push(t); }
    main.append(t.pane);
    paintTab(t);
    return t;
  }
  function paintTab(t) {
    var icon;
    if (t.kind === "chat") icon = '<span class="term-tab-agent-logo' + (t.waiting ? " is-waiting" : "") + '">' + I.chat + "</span>";
    else if (t.agent) icon = '<span class="term-tab-agent-logo" style="color:' + AGENTS[t.agent].color + '">' + logo(t.agent) + "</span>";
    else icon = '<span class="term-tab-dot"></span>';
    var sweep = t.busy ? '<svg class="term-tab-sweep" aria-hidden="true"><rect width="100%" height="100%" rx="9.25" pathLength="100"/></svg>' : "";
    t.btn.innerHTML = sweep + icon + '<span class="term-tab-label">' + esc(t.label()) + '</span><button type="button" class="term-tab-close" tabindex="-1" aria-label="Close ' + esc(t.label()) + '">' + I.close + "</button>";
    t.btn.title = t.kind === "dev" ? "npm run dev" : pathLabel(t.cwd || []);
  }
  function select(t, focus) {
    if (active !== t) {
      active = t;
      tabs.forEach(function (o) {
        var on = o === t;
        o.btn.classList.toggle("is-active", on);
        o.btn.setAttribute("aria-selected", String(on));
        o.btn.tabIndex = on ? 0 : -1;
        o.pane.hidden = !on;
      });
      t.btn.scrollIntoView({ block: "nearest", inline: "nearest" });
      S.expDir = null;
      showBrowser(t.kind === "dev" && !t.browserClosed);
      renderSide();
    }
    if (focus && t.focus) t.focus();
  }
  function closeTab(t) {
    var i = tabs.indexOf(t);
    if (i < 0 || tabs.length < 2) return;
    if (t.stop) t.stop();
    tabs.splice(i, 1);
    t.btn.remove();
    t.pane.remove();
    if (active === t) { active = null; select(tabs[Math.max(0, i - 1)], true); }
  }
  tabsVp.addEventListener("keydown", function (e) {
    var i = tabs.indexOf(active), n = null;
    if (e.key === "ArrowRight") n = tabs[(i + 1) % tabs.length];
    else if (e.key === "ArrowLeft") n = tabs[(i - 1 + tabs.length) % tabs.length];
    else if (e.key === "Home") n = tabs[0];
    else if (e.key === "End") n = tabs[tabs.length - 1];
    else if (e.key === "Delete") { e.preventDefault(); closeTab(active); if (active) active.btn.focus(); return; }
    else if (e.key === "Enter" || e.key === " ") { e.preventDefault(); if (active.focus) active.focus(); return; }
    if (n) { e.preventDefault(); select(n); n.btn.focus(); }
  });
  clearBtn.addEventListener("click", function () { if (active && active.clear) { active.clear(); active.focus(); } });

  /* the agent of the active tab: a chat, or an agent running in a terminal */
  function activeAgent() { return active && (active.kind === "chat" ? active.agent : active.agent) || null; }

  /* ---------------------------------------------------------- sidebar */
  function renderSide() {
    var ag = activeAgent();
    var opts = [];
    if (ag) opts.push(["history", "History"]);
    opts.push(["explorer", "Explorer"]);
    if (ag) opts.push(["agent", "Agent"]);
    if (!opts.some(function (o) { return o[0] === S.sideTab; })) S.sideTab = "explorer";
    side.innerHTML = "";
    var sb = el("aside", { class: "sidebar", "aria-label": "Sidebar" });
    if (opts.length > 1) {
      var sw = el("div", { class: "segmented-switch", role: "tablist", "aria-label": "Side panel" });
      opts.forEach(function (o) {
        var n = changeCount();
        var b = el("button", { class: "segmented-switch-option", type: "button", role: "tab", "aria-selected": String(o[0] === S.sideTab), html: "<span>" + o[1] + "</span>" + (o[0] === "explorer" && n ? '<span class="segmented-switch-count">' + n + "</span>" : "") });
        b.addEventListener("click", function () { S.sideTab = o[0]; renderSide(); var f = side.querySelector('.segmented-switch [aria-selected="true"]'); if (f) f.focus(); });
        sw.append(b);
      });
      sb.append(sw);
    }
    var panel = el("div", { class: "sidebar-panel", role: opts.length > 1 ? "tabpanel" : null });
    if (S.sideTab === "history") renderHistory(panel);
    else if (S.sideTab === "agent") panel.append(insight(ag, function () { S.sideTab = "explorer"; S.pinned = false; renderSide(); }));
    else renderExplorer(panel);
    sb.append(panel);
    side.append(sb);
  }

  function renderExplorer(panel) {
    var base = active && active.cwd ? active.cwd : [];
    var dir = S.expDir || base;
    var label = el("span", { class: "file-tree-header-label", title: pathLabel(dir), text: pathLabel(dir) });
    var up = el("button", { class: "file-tree-back", type: "button", "aria-label": "Up one folder", title: "Up one folder", html: I.back });
    if (!dir.length) up.disabled = true;
    up.addEventListener("click", function () { S.expDir = dir.slice(0, -1); renderSide(); });
    var home = el("button", { class: "file-tree-back", type: "button", "aria-label": "Back to the terminal's folder", title: "Back to the terminal's folder", html: I.home });
    home.addEventListener("click", function () { S.expDir = null; renderSide(); });
    var list = el("ul", { class: "file-tree-list", "aria-label": "Files in " + pathLabel(dir) });
    var node = nodeAt(dir) || FS;
    sortedKeys(node).forEach(function (name) {
      var segs = dir.concat(name), key = segs.join("/"), isDir = typeof node[name] === "object";
      var st = S.git[key];
      if (isDir) for (var g in S.git) if (g.indexOf(key + "/") === 0) { st = "M"; break; }
      var cls = st === "U" || st === "A" ? " git-add" : st ? " git-mod" : "";
      var row = el("button", {
        class: "file-tree-row" + cls + (S.sel === key ? " is-active" : ""), type: "button",
        "data-path": key,
        html: '<span class="file-tree-chevron-spacer"></span>' + (isDir ? '<span class="file-tree-icon ft-folder">' + I.folder + "</span>" : fileIcon(name)) +
          '<span class="file-tree-name">' + esc(name) + "</span>" + (st && !isDir ? '<span class="file-tree-git">' + st + "</span>" : "")
      });
      row.addEventListener("click", function () {
        if (isDir) { S.expDir = segs; renderSide(); var f = side.querySelector(".file-tree-row"); if (f) f.focus(); }
        else { S.sel = key; renderSide(); var again = side.querySelector('[data-path="' + key + '"]'); if (again) again.focus(); }
      });
      list.append(el("li", null, row));
    });
    panel.append(el("div", { class: "file-tree" }, [
      el("div", { class: "file-tree-header" }, [up, home, label, el("span", { class: "file-tree-menu-btn", title: "Search", "aria-hidden": "true", html: I.search }), el("span", { class: "file-tree-menu-btn", title: "Folder options", "aria-hidden": "true", html: I.kebab })]),
      list
    ]), gitDock());
  }
  function flash(path) {
    var r = side.querySelector('[data-path="' + path + '"]');
    if (r) { r.classList.remove("is-flash"); void r.offsetWidth; r.classList.add("is-flash"); }
  }
  function setGit(path, st) {
    S.git[path] = st;
    S.expDir = path.split("/").slice(0, -1);
    if (S.sideTab !== "explorer" && !S.pinned) S.sideTab = "explorer";
    renderSide();
    flash(path);
  }

  function gitDock() {
    var n = changeCount();
    var dock = el("div", { class: "git-dock" + (S.dockOpen ? " is-open" : "") });
    var pill = n ? '<span class="git-dock-pill">' + n + (n === 1 ? " change" : " changes") + "</span>" : "";
    var bar = el("button", {
      class: "git-dock-bar", type: "button", "aria-expanded": String(S.dockOpen), "aria-label": "Show/hide Git",
      html: (S.dockOpen ? "<span>Git</span>" + pill : '<span class="git-dock-branch">' + I.branch + '<span>master</span></span>' + (S.ahead ? '<span class="git-dock-sync">↑' + S.ahead + "</span>" : "") + pill) + I.chevUp
    });
    bar.addEventListener("click", function () { S.dockOpen = !S.dockOpen; renderSide(); side.querySelector(".git-dock-bar").focus(); });
    dock.append(bar);
    if (S.dockOpen) dock.append(el("div", { class: "git-dock-body" }, gitPanel()));
    return dock;
  }
  function gitPanel() {
    var wrap = el("div", { class: "git-panel" });
    var staged = Object.keys(S.git).filter(function (p) { return S.staged[p]; });
    var changes = Object.keys(S.git).filter(function (p) { return !S.staged[p]; });
    var input = el("input", { class: "git-commit-input", type: "text", "aria-label": "Commit message", placeholder: "Message (Enter to commit)" });
    var btn = el("button", { class: "git-commit-btn", type: "button", text: "Commit" });
    if (S.fixed && !S.committed) input.value = "fix(auth): stop the login redirect loop";
    var sync = function () { btn.disabled = !staged.length || !input.value.trim(); };
    input.addEventListener("input", sync);
    var commit = function () {
      if (btn.disabled) return;
      staged.forEach(function (p) { delete S.git[p]; delete S.staged[p]; });
      S.ahead++; S.committed = true;
      S.gitMsg = "Committed " + staged.length + (staged.length === 1 ? " file" : " files") + " to master.";
      renderSide();
    };
    input.addEventListener("keydown", function (e) { if (e.key === "Enter") commit(); });
    btn.addEventListener("click", commit);
    sync();
    wrap.append(el("div", { class: "git-commit-box" }, [input, btn]));
    if (S.gitMsg) wrap.append(el("div", { class: "git-done", text: S.gitMsg }));
    [["Staged", staged, true], ["Changes", changes, false]].forEach(function (g) {
      wrap.append(el("div", { class: "git-group-header", html: g[0] + ' <span class="git-count">' + g[1].length + "</span>" }));
      var ul = el("ul", { class: "git-list" });
      if (!g[1].length) ul.append(el("li", { class: "git-none", text: g[2] ? "Nothing staged" : "No changes" }));
      g[1].forEach(function (p) {
        var name = p.split("/").pop(), dir = p.slice(0, -name.length - 1), st = S.git[p];
        var b = el("button", { type: "button", "aria-label": (g[2] ? "Unstage " : "Stage ") + p, title: g[2] ? "Unstage" : "Stage", html: g[2] ? svg('<path d="M6 12h12"/>') : svg('<path d="M12 6v12M6 12h12"/>') });
        b.addEventListener("click", function () { S.staged[p] = !g[2]; S.gitMsg = null; renderSide(); var x = side.querySelector('[aria-label$="' + p + '"]'); if (x) x.focus(); });
        ul.append(el("li", { class: "git-row" }, [el("span", { class: "git-row-name", text: name }), el("span", { class: "git-row-dir", text: dir }), el("span", { class: "git-status git-status-" + st, text: st }), b]));
      });
      wrap.append(ul);
    });
    if (S.ahead) {
      var push = el("button", { class: "git-push", type: "button", text: "Push ↑" + S.ahead });
      push.addEventListener("click", function () { S.ahead = 0; S.gitMsg = "Pushed to origin/master."; renderSide(); });
      wrap.append(push);
    }
    return wrap;
  }

  var HISTORY = [
    ["claude", "Auth refactor plan", "yesterday · 2 delegates"],
    ["codex", "Paged chat history", "yesterday"],
    ["opencode", "Try a local model", "2 days ago"],
    ["cline", "Fix flaky e2e test", "3 days ago"],
    ["gemini", "Summarize the docs", "last week"],
    ["vibe", "Rename the settings keys", "last week"]
  ];
  function renderHistory(panel) {
    var ul = el("ul", { class: "agent-history", "aria-label": "Sessions" });
    HISTORY.forEach(function (h) {
      var b = el("button", { class: "agent-history-row", type: "button", style: "--ag:" + AGENTS[h[0]].color, html: '<span class="agent-history-logo">' + logo(h[0]) + '</span><span class="agent-history-text"><span class="agent-history-title">' + esc(h[1]) + '</span><span class="agent-history-meta">' + esc(AGENTS[h[0]].name + " · " + h[2]) + "</span></span>" });
      b.addEventListener("click", function () { openChat(h[0]); });
      ul.append(el("li", null, b));
    });
    panel.append(ul);
  }

  /* the agent panel (sidebar "Agent" tab and the header pill's popover) */
  var USAGE = { claude: [31, 12], codex: [44, 20], vibe: [18, null], cline: [26, null] };
  function insight(agentId, onUnpin) {
    var a = AGENTS[agentId], t = active, ctx = t && t.ctx != null ? t.ctx : 4;
    var wrap = el("div", { class: "agent-insight", style: "--ag:" + a.color });
    var tab = t && t.insightTab || "context";
    var used = Math.round(ctx * 2);
    wrap.innerHTML = '<span class="agent-insight-chip"><span class="lg">' + logo(agentId) + "</span>" + esc(a.short + " · " + a.model + " · " + (t && t.kind === "chat" ? "chat" : "terminal")) + "</span>" +
      '<div class="agent-insight-hero"><span class="agent-insight-big">' + ctx + '%</span><span class="agent-insight-muted">' + used + "k of 200k tokens</span></div>" +
      '<div class="agent-insight-meter"><i style="width:' + ctx + '%"></i></div>';
    var compact = el("button", { class: "agent-insight-btn", type: "button", text: "Compact" });
    compact.addEventListener("click", function () { if (t) { t.ctx = 3; if (t.paintHead) t.paintHead(); } rerenderInsight(); });
    wrap.querySelector(".agent-insight-hero").append(compact);
    var segs = [["context", "Context"], ["usage", "Usage"]];
    if (t && t.delegated) segs.push(["delegates", "Delegates"]);
    var sw = el("div", { class: "segmented-switch", role: "tablist", "aria-label": "Agent panel sections" });
    segs.forEach(function (s) {
      var b = el("button", { class: "segmented-switch-option", type: "button", role: "tab", "aria-selected": String(s[0] === tab), html: "<span>" + s[1] + "</span>" + (s[0] === "delegates" ? '<span class="segmented-switch-count">1</span>' : "") });
      b.addEventListener("click", function () { if (t) t.insightTab = s[0]; rerenderInsight(); });
      sw.append(b);
    });
    wrap.append(sw);
    var pane = el("div", { role: "tabpanel" });
    if (tab === "context") {
      var rows = [["Memory and instructions (estimate)", "#c98fc4", 3], ["Skills (estimate)", "#d1a752", 4], ["MCP servers", "#6fc2c2", 2], ["Conversation and tools", "var(--accent)", Math.max(1, ctx - 9)]];
      pane.innerHTML = '<div class="agent-insight-stack">' + rows.map(function (r) { return '<i style="width:' + r[2] + "%;background:" + r[1] + '"></i>'; }).join("") + "</div>" +
        rows.map(function (r) { return '<div class="agent-insight-row"><span class="sw" style="background:' + r[1] + '"></span>' + esc(r[0]) + '<span class="v">' + (r[2] * 2) + "k</span></div>"; }).join("") +
        '<div class="agent-insight-row"><span class="sw" style="background:color-mix(in srgb,var(--fg) 12%,transparent)"></span>Free<span class="v">' + (200 - used) + "k</span></div>";
    } else if (tab === "usage") {
      var u = USAGE[agentId];
      pane.innerHTML = u
        ? '<div class="agent-insight-lim"><div class="l">Session (5 h)<span>' + u[0] + '%</span></div><div class="agent-insight-meter"><i style="width:' + u[0] + '%;background:var(--ag)"></i></div></div>' +
          (u[1] != null ? '<div class="agent-insight-lim"><div class="l">Week<span>' + u[1] + '%</span></div><div class="agent-insight-meter"><i style="width:' + u[1] + '%;background:var(--ag)"></i></div></div>' : "") +
          '<p class="agent-insight-note">Plan limits for this profile. Several accounts per agent, each with its own gauge.</p>'
        : '<p class="agent-insight-note">Not available for this agent.</p>';
    } else {
      var d = AGENTS[t.delegated];
      pane.innerHTML = '<div class="agent-insight-row" style="--ag:' + d.color + '"><span class="agent-history-logo">' + logo(t.delegated) + "</span>Write tests for redirect.ts<span class=\"v\">done</span></div>";
    }
    wrap.append(pane);
    if (onUnpin) {
      var un = el("button", { class: "agent-insight-btn", type: "button", style: "margin-top:12px;align-self:flex-start", text: "Unpin from sidebar" });
      un.addEventListener("click", onUnpin);
      if (S.pinned) wrap.append(un);
    }
    return wrap;
  }
  function rerenderInsight() {
    if (S.sideTab === "agent") renderSide();
    tabs.forEach(function (t) { if (t.refreshPop) t.refreshPop(); });
  }

  /* ---------------------------------------------------------- agent header (AgentHeader + SessionMenu + context pill) */
  function agentHeader(t, opts) {
    var head = el("div", { class: "chat-header" });
    var anchor = el("div", { class: "chat-menu-anchor" });
    var sess = el("button", { class: "chat-session", type: "button", "aria-haspopup": "menu", "aria-expanded": "false" });
    var menu = el("div", { class: "chat-menu is-session", role: "menu", hidden: "" });
    anchor.append(sess, menu);
    var pillAnchor = el("div", { class: "agent-pill-anchor" });
    var pill = el("button", { class: "agent-pill", type: "button", "aria-haspopup": "dialog", "aria-expanded": "false", title: "Agent context" });
    var pop = el("div", { class: "agent-pop", role: "dialog", "aria-label": "Agent context", hidden: "" });
    pillAnchor.append(pill, pop);
    var statusText = el("span", { class: "chat-status-text" });
    var statusDot = el("span", { class: "chat-status-dot", "aria-hidden": "true" });
    head.append(anchor, pillAnchor, statusText, statusDot);

    function paint() {
      var a = AGENTS[t.agent], ctx = t.ctx || 0, r = 7.5, c = 2 * Math.PI * r;
      head.style.setProperty("--ag", a.color);
      sess.innerHTML = '<span class="chat-session-icon">' + logo(t.agent) + '</span><span class="chat-session-title">flowcode</span>' + I.sessChev;
      sess.title = a.name + " · flowcode — Session menu";
      pill.innerHTML = '<svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true"><circle class="agent-pill-track" cx="8" cy="8" r="' + r + '" fill="none" stroke-width="2.4"/><circle class="agent-pill-progress" cx="8" cy="8" r="' + r + '" fill="none" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="' + (c * ctx / 100).toFixed(2) + " " + c.toFixed(2) + '" transform="rotate(-90 8 8)"/></svg><span>' + ctx + "%</span>";
      var st = t.status || "idle";
      statusText.textContent = { idle: "Ready", busy: "Working", waiting: "Waiting for permission" }[st];
      statusDot.className = "chat-status-dot is-" + st;
    }
    function buildMenu() {
      var a = AGENTS[t.agent];
      menu.innerHTML = '<div class="chat-menu-head"><b>flowcode</b><small>' + esc(a.name + " · flowcode") + '</small><small class="is-mono">/home/you/flowcode</small></div>';
      var views = el("div", { class: "chat-menu-views", role: "radiogroup", "aria-label": "View as" });
      [["chat", "Chat", I.viewChat], ["terminal", "Terminal", I.viewTerm]].forEach(function (v) {
        var b = el("button", { type: "button", role: "radio", "aria-checked": String(v[0] === opts.view()), html: v[2] + "<span>" + v[1] + "</span>" });
        if (t.status === "busy" && v[0] !== opts.view()) b.disabled = true;
        b.addEventListener("click", function () { closeMenu(); if (v[0] !== opts.view()) opts.switchView(v[0]); });
        views.append(b);
      });
      menu.append(views, el("div", { class: "chat-menu-views-hint", html: t.status === "busy" ? "<span>Stop the agent to switch</span>" : '<span>Switch view</span><kbd>Ctrl+`</kbd>' }), el("div", { class: "chat-menu-sep" }));
      var copy = el("button", { class: "chat-menu-item", type: "button", role: "menuitem", html: I.copy + "<span>Copy session ID</span>" });
      copy.addEventListener("click", function () { copy.querySelector("span").textContent = "Copied"; setTimeout(closeMenu, 500); });
      var stop = el("button", { class: "chat-menu-item is-danger", type: "button", role: "menuitem", html: I.stop + "<span>Stop agent</span>" });
      stop.disabled = t.status !== "busy" && t.status !== "waiting";
      stop.addEventListener("click", function () { closeMenu(); if (t.stop) t.stop(); });
      menu.append(copy, el("div", { class: "chat-menu-sep" }), stop);
    }
    function openMenu() { closePop(); buildMenu(); menu.hidden = false; sess.setAttribute("aria-expanded", "true"); var f = menu.querySelector('[aria-checked="true"]') || menu.querySelector("button"); f.focus(); }
    function closeMenu() { menu.hidden = true; sess.setAttribute("aria-expanded", "false"); }
    function openPop() {
      if (S.pinned) { S.sideTab = "agent"; renderSide(); return; }
      closeMenu();
      fillPop(); pop.hidden = false; pill.setAttribute("aria-expanded", "true");
    }
    function fillPop() {
      pop.innerHTML = "";
      pop.append(insight(t.agent));
      var pin = el("button", { type: "button", text: "Pin to sidebar" });
      pin.addEventListener("click", function () { S.pinned = true; closePop(); if (side.hidden) sidebarBtn.click(); S.sideTab = "agent"; renderSide(); });
      pop.append(el("div", { class: "agent-pop-foot" }, [el("kbd", { text: "Ctrl+Shift+A" }), pin]));
    }
    function closePop() { pop.hidden = true; pill.setAttribute("aria-expanded", "false"); }
    t.refreshPop = function () { if (!pop.hidden) fillPop(); };
    sess.addEventListener("click", function () { menu.hidden ? openMenu() : closeMenu(); });
    pill.addEventListener("click", function () { pop.hidden ? openPop() : (closePop()); });
    head.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { if (!menu.hidden) { closeMenu(); sess.focus(); } if (!pop.hidden) { closePop(); pill.focus(); } }
      if (!menu.hidden && (e.key === "ArrowDown" || e.key === "ArrowUp")) {
        var items = Array.prototype.slice.call(menu.querySelectorAll("button:not(:disabled)")), i = items.indexOf(document.activeElement);
        e.preventDefault();
        items[(i + (e.key === "ArrowDown" ? 1 : -1) + items.length) % items.length].focus();
      }
    });
    document.addEventListener("click", function (e) {
      if (!menu.hidden && !anchor.contains(e.target)) closeMenu();
      if (!pop.hidden && !pillAnchor.contains(e.target)) closePop();
    });
    paint();
    return { el: head, paint: paint };
  }

  /* ---------------------------------------------------------- terminal */
  var WORD = [
    "███████╗██╗      ██████╗ ██╗    ██╗ ██████╗ ██████╗ ██████╗ ███████╗",
    "██╔════╝██║     ██╔═══██╗██║    ██║██╔════╝██╔═══██╗██╔══██╗██╔════╝",
    "█████╗  ██║     ██║   ██║██║ █╗ ██║██║     ██║   ██║██║  ██║█████╗  ",
    "██╔══╝  ██║     ██║   ██║██║███╗██║██║     ██║   ██║██║  ██║██╔══╝  ",
    "██║     ███████╗╚██████╔╝╚███╔███╔╝╚██████╗╚██████╔╝██████╔╝███████╗",
    "╚═╝     ╚══════╝ ╚═════╝  ╚══╝╚══╝  ╚═════╝ ╚═════╝ ╚═════╝ ╚══════╝"
  ].join("\n");
  var COMMANDS = ["help", "ls", "cd", "pwd", "cat", "git", "chat", "npm", "frog", "palette", "clear", "whoami", "date", "echo", "history", "version", "exit"].concat(FC.AGENT_ORDER);

  function Term(opts) {
    var self = this;
    opts = opts || {};
    this.kind = "term";
    this.cwd = opts.cwd || [];
    this.hist = [];
    this.hi = 0;
    this.agent = null;
    this.ctx = 6;
    this.pane = el("section", { "aria-label": "Terminal" });
    this.out = el("div", { class: "fc-term" });
    this.log = el("div", { "aria-live": "polite" });
    this.ps = el("span", { class: "fc-ps", "aria-hidden": "true" });
    this.input = el("input", { class: "fc-input", type: "text", autocomplete: "off", autocapitalize: "off", spellcheck: "false", enterkeyhint: "send", "aria-label": "Terminal input. Type help for a list of commands." });
    this.row = el("div", { class: "fc-prompt-row" }, [this.ps, this.input]);
    this.out.append(this.log, this.row);
    this.pane.append(this.out);
    this.out.addEventListener("click", function (e) {
      var r = e.target.closest("[data-run]");
      if (r) { self.exec(r.dataset.run); return; }
      var o = e.target.closest("[data-open-chat]");
      if (o) { openChat(o.dataset.openChat, self); return; }
      if (e.target.closest("[data-open-browser]")) { var d = tabs.filter(function (x) { return x.kind === "dev"; })[0]; if (d) { d.browserClosed = false; select(d, true); } return; }
      if (!window.getSelection().toString()) self.focus();
    });
    this.input.addEventListener("keydown", function (e) { self.key(e); });
    this.label = function () { return self.agent ? AGENTS[self.agent].cmd : (self.cwd.length ? self.cwd[self.cwd.length - 1] : "flowcode"); };
    this.prompt();
  }
  Term.prototype.focus = function () { this.input.focus({ preventScroll: true }); };
  Term.prototype.prompt = function () {
    if (this.agent) {
      this.ps.innerHTML = '<span class="c-ag">›</span> ';
      this.input.placeholder = "ask anything · /exit to leave";
    } else {
      this.ps.innerHTML = '<span class="c-acc">' + esc(pathLabel(this.cwd)) + '</span> <span class="c-acc2">master</span> <span class="c-mut">❯</span> ';
      this.input.placeholder = this.hist.length ? "" : "type help";
    }
  };
  Term.prototype.print = function (html, cls) { var ln = el("div", { class: "ln" + (cls ? " " + cls : ""), html: html == null ? "" : html }); this.log.append(ln); this.scroll(); return ln; };
  Term.prototype.node = function (n) { this.log.append(n); this.scroll(); return n; };
  Term.prototype.scroll = function () { this.out.scrollTop = this.out.scrollHeight; };
  Term.prototype.clear = function () { this.log.innerHTML = ""; };
  Term.prototype.chips = function (cmds) {
    var row = el("div", { class: "fc-chips-row" });
    cmds.forEach(function (c) { row.append(el("button", { class: "fc-tchip", type: "button", "data-run": c, text: c })); });
    return this.node(row);
  };
  Term.prototype.splash = function () {
    var cv = el("canvas", { "data-frog": "", "aria-hidden": "true" });
    FC.drawFrog(cv, { accent: accentNow() });
    this.node(el("div", { class: "fc-splash" }, [cv, el("div", null, [el("pre", { class: "fc-word", "aria-label": "Flowcode", text: WORD }), el("b", { class: "fc-word-sm", text: "Flowcode" })])]));
    this.print('<span class="c-mut">The terminal where agents live. This one is a scripted demo, running in your browser.</span>');
    this.chips(["help", "ls", "git status", "claude", "npm test"]);
  };
  Term.prototype.key = function (e) {
    var v = this.input.value;
    if (e.key === "Enter") { e.preventDefault(); this.input.value = ""; this.exec(v); }
    else if (e.key === "ArrowUp") { if (this.hi > 0) { this.hi--; this.input.value = this.hist[this.hi] || ""; } e.preventDefault(); }
    else if (e.key === "ArrowDown") { if (this.hi < this.hist.length) { this.hi++; this.input.value = this.hist[this.hi] || ""; } e.preventDefault(); }
    else if (e.key === "Tab") { if (v) { e.preventDefault(); this.complete(v); } }
    else if (e.key === "l" && e.ctrlKey) { e.preventDefault(); this.clear(); }
    else if (e.key === "c" && e.ctrlKey && !window.getSelection().toString()) { e.preventDefault(); this.echoLine(v + "^C"); this.input.value = ""; }
    else if (e.key === "`" && e.ctrlKey && this.agent) { e.preventDefault(); openChat(this.agent, this); }
  };
  Term.prototype.complete = function (v) {
    var parts = v.split(" "), last = parts[parts.length - 1], cands;
    if (parts.length === 1) cands = COMMANDS.filter(function (c) { return c.indexOf(last) === 0; });
    else {
      var dp = last.lastIndexOf("/") >= 0 ? last.slice(0, last.lastIndexOf("/") + 1) : "";
      var dir = nodeAt(resolve(this.cwd, dp || ".")) || {}, stem = last.slice(dp.length);
      cands = Object.keys(dir).filter(function (k) { return k.indexOf(stem) === 0; }).map(function (k) { return dp + k + (typeof dir[k] === "object" ? "/" : ""); });
    }
    if (cands.length === 1) { parts[parts.length - 1] = cands[0] + (parts.length === 1 ? " " : ""); this.input.value = parts.join(" "); }
    else if (cands.length > 1) { this.echoLine(v); this.print(cands.join("  "), "c-mut"); }
  };
  Term.prototype.echoLine = function (v) { this.print(this.ps.innerHTML + esc(v)); };
  Term.prototype.exec = function (raw) {
    var v = String(raw).trim();
    this.echoLine(raw);
    if (v) this.hist.push(v);
    this.hi = this.hist.length;
    if (v) { if (this.agent) this.agentInput(v); else this.run(v); }
    this.prompt();
    this.scroll();
  };
  Term.prototype.setAgent = function (id) {
    var self = this;
    this.agent = id;
    if (id) {
      this.pane.style.setProperty("--ag", AGENTS[id].color);
      this.header = agentHeader(this, { view: function () { return "terminal"; }, switchView: function () { openChat(self.agent, self); } });
      this.pane.prepend(this.header.el);
    } else if (this.header) { this.header.el.remove(); this.header = null; }
    paintTab(this);
    if (active === this) renderSide();
  };
  Term.prototype.agentInput = function (v) {
    var a = AGENTS[this.agent], self = this;
    if (/^\/?(exit|quit)$/.test(v)) { this.print('<span class="c-mut">' + esc(a.name) + " closed.</span>"); this.setAgent(null); return; }
    this.status = "busy"; this.header.paint(); this.busy = true; paintTab(this);
    var line = this.print('<span class="c-ag">⏺</span> <span class="c-mut">Thinking…</span>');
    setTimeout(function () {
      line.innerHTML = '<span class="c-ag">⏺</span> This preview is scripted, so the real work happens in the chat. Same session, two views:';
      self.node(el("div", null, el("button", { class: "tbtn", type: "button", "data-open-chat": a.id, html: I.viewChat + "Open as chat" })));
      self.status = "idle"; self.busy = false; self.ctx = Math.min(40, self.ctx + 2); self.header.paint(); paintTab(self);
    }, FC.reduced ? 0 : 750);
  };
  Term.prototype.launch = function (id) {
    var a = AGENTS[id];
    this.setAgent(id);
    this.node(el("div", { class: "fc-tui", html: "<b>✻ " + esc(a.name) + '</b><br><span class="c-mut">' + esc(a.model) + " · " + esc(pathLabel(this.cwd)) + "</span>" }));
    this.print('<span class="c-mut">Flowcode recognized ' + esc(a.name) + " here: the tab shows its logo, the header above is the same as in a chat.</span>");
    this.node(el("div", null, el("button", { class: "tbtn", type: "button", "data-open-chat": id, html: I.viewChat + "Open as chat (Ctrl+`)" })));
  };
  Term.prototype.run = function (v) {
    var self = this, args = v.split(/\s+/), cmd = args[0].toLowerCase(), rest = args.slice(1);
    var p = function (h, c) { return self.print(h, c); };
    if (AGENTS[cmd]) return this.launch(cmd);
    switch (cmd) {
      case "help":
        p('<b>This demo knows a few commands</b> <span class="c-mut">(Tab completes, ↑ ↓ for history)</span>');
        [["ls [dir]", "list files"], ["cd <dir>", "change folder: the Explorer follows"], ["cat <file>", "print a file"], ["git status | log | diff", "the repo's state"],
          ["npm test · npm run dev", "run scripts"], ["claude · codex · gemini", "start an agent in this tab"], ["vibe · opencode · cline", "…or one of the others"], ["chat", "open a chat"],
          ["palette <name>", "recolor the window"], ["frog · clear · whoami", "and a few more"]
        ].forEach(function (r) { p('  <span class="c-acc">' + esc(r[0].padEnd(28)) + '</span><span class="c-mut">' + esc(r[1]) + "</span>"); });
        return;
      case "ls": case "dir": case "ll": {
        var target = rest.filter(function (a) { return a[0] !== "-"; })[0];
        var segs = target ? resolve(this.cwd, target) : this.cwd, d = nodeAt(segs);
        if (!d) return p("ls: cannot access '" + esc(target) + "': No such file or directory", "c-red");
        if (typeof d !== "object") return p(esc(target));
        return p(sortedKeys(d).map(function (k) {
          var key = segs.concat(k).join("/");
          if (typeof d[k] === "object") return '<span class="c-blu"><b>' + esc(k) + "/</b></span>";
          return S.git[key] ? '<span class="c-yel">' + esc(k) + "</span>" : esc(k);
        }).join("   "));
      }
      case "cd": {
        var to = rest[0] || "~", s2 = resolve(this.cwd, to), dn = nodeAt(s2);
        if (!dn) return p("cd: no such file or directory: " + esc(to), "c-red");
        if (typeof dn !== "object") return p("cd: not a directory: " + esc(to), "c-red");
        this.cwd = s2; S.expDir = null; paintTab(this); renderSide();
        if (!this.cdHint) { this.cdHint = true; p('<span class="c-mut">↳ The Explorer followed you into ' + esc(pathLabel(s2)) + ".</span>"); }
        return;
      }
      case "pwd": return p("/home/you/" + ["flowcode"].concat(this.cwd).join("/"));
      case "cat": case "type": case "less": return this.cat(rest[0]);
      case "git": return this.git(rest);
      case "npm": case "pnpm": case "yarn": case "bun": return this.npm(rest);
      case "chat": newTabDialog(); return;
      case "frog": case "ribbit": {
        var cv = el("canvas", { class: "fc-inline-frog", "aria-hidden": "true" });
        FC.drawFrog(cv, { accent: accentNow(), vivid: true, lookX: 18 });
        this.node(cv);
        return p('<span class="c-acc">ribbit.</span> <span class="c-mut">The frog lives in every new tab.</span>');
      }
      case "palette": case "theme": {
        var id = (rest[0] || "").toLowerCase();
        if (!FC.PALETTES[id]) return p('Palettes: <span class="c-acc">' + Object.keys(FC.PALETTES).join("  ") + '</span><span class="c-mut">  (try: palette ocean)</span>');
        setPalette(id);
        return p("Palette set to <b>" + esc(FC.PALETTES[id].name) + '</b>. <span class="c-mut">Each palette has a light and a dark variant.</span>');
      }
      case "clear": case "cls": this.clear(); return;
      case "whoami": return p("you");
      case "date": return p(esc(new Date().toString()));
      case "echo": return p(esc(rest.join(" ")));
      case "history": return p(this.hist.map(function (h, i) { return String(i + 1).padStart(4) + "  " + esc(h); }).join("\n"));
      case "version": case "flowcode": case "neofetch": case "fastfetch": this.clear(); this.splash(); return;
      case "exit": case "logout": closeTab(this); return;
      case "sudo": return p("sudo: the frog says no.", "c-mut");
      case "rm": return p('<span class="c-mut">Nothing here is real, so there is nothing to delete.</span>');
      case "vim": case "vi": case "nano": case "code": case "emacs":
        return p('<span class="c-mut">Flowcode has its own editor with syntax highlighting and an outline. In this demo, browse files in the Explorer.</span>');
      default:
        p("zsh: command not found: " + esc(cmd), "c-red");
        p('<span class="c-mut">This demo knows a handful of commands. Try one of these:</span>');
        this.chips(["help", "ls", "git status", "claude"]);
    }
  };
  Term.prototype.cat = function (f) {
    if (!f) return this.print("cat: missing file operand", "c-red");
    var segs = resolve(this.cwd, f), n = nodeAt(segs), key = segs.join("/");
    if (!n) return this.print("cat: " + esc(f) + ": No such file or directory", "c-red");
    if (typeof n === "object") return this.print("cat: " + esc(f) + ": Is a directory", "c-red");
    var T = {
      "README.md": "# Flowcode\n\nThe desktop terminal that keeps your shell, files and AI agents together,\nwithout breaking your flow. Windows, macOS, Linux and an Android companion app.",
      "package.json": '{\n  "name": "flowcode",\n  "private": true,\n  "scripts": {\n    "dev": "vite",\n    "test": "vitest run",\n    "tauri": "tauri"\n  }\n}',
      "notes.md": "- try the chat tab\n- ask an agent to fix the login redirect\n- pair the phone",
      "src/auth/redirect.ts": S.fixed
        ? 'export function nextUrl(returnTo?: string) {\n  if (!returnTo || returnTo.startsWith("/login")) {\n    return "/";\n  }\n  return returnTo;\n}'
        : 'export function nextUrl(returnTo?: string) {\n  return returnTo ?? "/";\n}',
      "PLUGINS.md": "# Plugins\n\nPlugins are declarative JSON files, not code: buttons for the\nquick-action bar, status popups and shortcuts to your own tools.",
      "LICENSE": "Apache License\nVersion 2.0, January 2004"
    };
    this.print(esc(T[key] || "(demo) The contents of " + f + " aren't included here. In Flowcode it opens in the built-in editor."), T[key] ? "" : "c-mut");
  };
  Term.prototype.git = function (a) {
    var sub = a[0] || "", p = this.print.bind(this);
    if (sub === "status" || sub === "st") {
      var mods = [], unt = [];
      for (var k in S.git) (S.git[k] === "U" ? unt : mods).push(k);
      p("On branch master\n" + (S.ahead ? "Your branch is ahead of 'origin/master' by " + S.ahead + " commit." : "Your branch is up to date with 'origin/master'."));
      if (mods.length) p("\nChanges not staged for commit:\n" + mods.map(function (m) { return '        <span class="c-red">modified:   ' + esc(m) + "</span>"; }).join("\n"));
      if (unt.length) p("\nUntracked files:\n" + unt.map(function (m) { return '        <span class="c-red">' + esc(m) + "</span>"; }).join("\n"));
      if (!mods.length && !unt.length) p("nothing to commit, working tree clean");
      return;
    }
    if (sub === "log") {
      return p([["e5bf187", "feat(remote): paged chat history for the phone and remote desktops"], ["d60493e", "perf(history): faster session list scans"], ["2985a0f", "perf(chat): cache the WSL codex probe"], ["dd48af7", "feat(chat): paged history, instant preview and windowed rendering"]]
        .map(function (c, i) { return '<span class="c-yel">' + c[0] + "</span>" + (i === 0 ? ' <span class="c-cyn">(HEAD -&gt; master, origin/master)</span>' : "") + " " + esc(c[1]); }).join("\n"));
    }
    if (sub === "diff") {
      if (S.fixed && S.git["src/auth/redirect.ts"]) return p('<b>diff --git a/src/auth/redirect.ts b/src/auth/redirect.ts</b>\n<span class="c-cyn">@@ -1,3 +1,6 @@</span>\n export function nextUrl(returnTo?: string) {\n<span class="c-red">-  return returnTo ?? "/";</span>\n<span class="c-grn">+  if (!returnTo || returnTo.startsWith("/login")) {</span>\n<span class="c-grn">+    return "/";</span>\n<span class="c-grn">+  }</span>\n<span class="c-grn">+  return returnTo;</span>\n }');
      if (!S.git["README.md"]) return p("");
      return p('<b>diff --git a/README.md b/README.md</b>\n<span class="c-cyn">@@ -3 +3 @@</span>\n<span class="c-red">-Windows, macOS and Linux.</span>\n<span class="c-grn">+Windows, macOS, Linux and an Android companion app.</span>');
    }
    if (sub === "branch") return p('* <span class="c-grn">master</span>\n  feat/plugins-v2');
    if (sub === "commit" || sub === "push" || sub === "add") return p('<span class="c-mut">Use the Git drawer at the bottom of the Explorer: stage, commit and push from there.</span>');
    p("usage: git status | log | diff | branch", "c-mut");
  };
  Term.prototype.npm = function (a) {
    var self = this, s = a.join(" ");
    if (/^(test|t|run test)$/.test(s)) {
      var line = this.print('<span class="c-mut">› vitest run</span>');
      setTimeout(function () {
        if (S.fixed) {
          line.innerHTML = '<span class="c-grn"> ✓</span> tests/login.test.ts <span class="c-mut">(8)</span>\n<span class="c-grn"> ✓</span> src/auth/redirect.test.ts <span class="c-mut">(4)</span>' + (S.tested ? '\n<span class="c-grn"> ✓</span> tests/redirect.test.ts <span class="c-mut">(4)</span>' : "") + '\n\n Tests  <span class="c-grn"><b>' + (S.tested ? 16 : 12) + " passed</b></span>";
        } else {
          line.innerHTML = '<span class="c-grn"> ✓</span> tests/login.test.ts <span class="c-mut">(8)</span>\n<span class="c-red"> ✗</span> src/auth/redirect.test.ts <span class="c-mut">(4)</span>\n   <span class="c-red">✗ returns home after signing in from /login</span>\n     <span class="c-mut">expected "/" but got "/login"</span>\n\n Tests  <span class="c-red"><b>1 failed</b></span> | <span class="c-grn">11 passed</span>';
          self.print('<span class="c-mut">Tip: open a chat and ask an agent to</span> <button class="lnk" type="button" data-open-chat="claude">fix the login redirect loop</button>');
        }
        self.scroll();
      }, FC.reduced ? 0 : 700);
      return;
    }
    if (/^(run )?dev$/.test(s) || s === "start") {
      this.print("Already running in its own tab: switching to <b>npm run dev</b>.");
      setTimeout(function () { var d = tabs.filter(function (x) { return x.kind === "dev"; })[0]; if (d) { d.browserClosed = false; select(d, true); } }, FC.reduced ? 0 : 400);
      return;
    }
    if (/^(i|install|ci)\b/.test(s)) return this.print('<span class="c-mut">up to date, audited 412 packages in 1s</span>');
    this.print("Scripts: test, dev", "c-mut");
  };

  /* ---------------------------------------------------------- dev server tab + browser panel */
  function makeDev() {
    var t = { kind: "dev", cwd: [], label: function () { return "npm run dev"; } };
    t.pane = el("section", { "aria-label": "Terminal running npm run dev" });
    var out = el("div", { class: "fc-term" });
    out.innerHTML =
      '<div class="ln"><span class="c-acc">~/flowcode</span> <span class="c-acc2">master</span> <span class="c-mut">❯</span> npm run dev</div><div class="ln"></div>' +
      '<div class="ln">  <span class="c-grn"><b>VITE</b> v6.2</span>  <span class="c-mut">ready in</span> <b>312 ms</b></div><div class="ln"></div>' +
      '<div class="ln">  <span class="c-grn">➜</span>  <b>Local</b>:   <button class="lnk" type="button" data-open-browser>http://localhost:5173/</button></div>' +
      '<div class="ln">  <span class="c-mut">➜  Network: use --host to expose</span></div><div class="ln"></div>' +
      '<div class="ln c-mut">  Links open in the browser panel, beside the terminal.</div>';
    out.addEventListener("click", function (e) { if (e.target.closest("[data-open-browser]")) { t.browserClosed = false; showBrowser(true); } });
    t.pane.append(out);
    t.out = out;
    t.focus = function () { out.querySelector(".lnk").focus({ preventScroll: true }); };
    t.clear = function () { out.innerHTML = ""; };
    return t;
  }
  var count = 0, frogCv = el("canvas", { "data-frog": "vivid", "aria-hidden": "true" });
  var countEl = el("span", { class: "count", text: "0 flies caught" });
  var catchBtn = el("button", { type: "button", text: "Catch a fly" });
  function paintPageFrog(o) { FC.drawFrog(frogCv, Object.assign({ accent: "#6d8f55", vivid: true }, o || {})); }
  paintPageFrog();
  catchBtn.addEventListener("click", function () {
    count++;
    countEl.textContent = count + (count === 1 ? " fly" : " flies") + " caught";
    paintPageFrog({ lid: 1, cursor: false }); setTimeout(paintPageFrog, 160);
    var d = tabs.filter(function (x) { return x.kind === "dev"; })[0];
    if (d) { d.out.insertAdjacentHTML("beforeend", '<div class="ln"><span class="c-mut">' + new Date().toLocaleTimeString() + '</span> <span class="c-cyn">[vite]</span> hmr update <span class="c-mut">/src/Pond.tsx</span></div>'); d.out.scrollTop = d.out.scrollHeight; }
  });
  var page = el("div", { class: "fc-page" }, [frogCv, el("h4", { text: "Pond Tracker" }), el("p", { text: "Your dev server, previewed in Flowcode." }), catchBtn, countEl]);
  var reloadBtn = el("button", { class: "icon-button sm", type: "button", title: "Reload", "aria-label": "Reload", html: I.bReload });
  reloadBtn.addEventListener("click", function () { count = 0; countEl.textContent = "0 flies caught"; if (page.animate && !FC.reduced) page.animate([{ opacity: 0.3 }, { opacity: 1 }], { duration: 300 }); });
  var bClose = el("button", { class: "icon-button sm", type: "button", title: "Close the browser", "aria-label": "Close the browser", html: I.bClose });
  bClose.addEventListener("click", function () { if (active) active.browserClosed = true; showBrowser(false); if (active && active.focus) active.focus(); });
  var backB = el("button", { class: "icon-button sm", type: "button", disabled: "", "aria-label": "Back", html: I.bBack });
  var fwdB = el("button", { class: "icon-button sm", type: "button", disabled: "", "aria-label": "Forward", html: I.bFwd });
  browserCard.append(el("div", { class: "browser-panel", "aria-label": "Browser panel", role: "region" }, [
    el("div", { class: "browser-panel-header" }, [
      backB, fwdB, reloadBtn,
      el("span", { class: "browser-panel-url", title: "http://localhost:5173/", html: I.globe + '<span class="browser-panel-url-host">localhost</span><span class="browser-panel-url-path">:5173/</span>' }),
      el("span", { class: "browser-tabs-button", title: "Tabs", "aria-hidden": "true", html: '<span class="browser-tabs-count">1</span><span class="browser-panel-dot"></span>' }),
      el("span", { class: "icon-button sm", "aria-hidden": "true", title: "More", html: I.more }),
      bClose
    ]),
    page
  ]));
  function showBrowser(on) { browserCard.hidden = !on; body.classList.toggle("has-browser", on); }

  /* ---------------------------------------------------------- chat */
  var PROMPTS = [
    { id: "fix", label: function () { return "Fix the login redirect loop"; } },
    { id: "explain", label: function () { return "What does src/chat do?"; } },
    { id: "delegate", label: function (t) { return "Hand the tests to " + AGENTS[t.agent === "codex" ? "claude" : "codex"].short; } }
  ];
  var VERBS = ["Croaking…", "Hopping…", "Catching flies…", "Swimming through the code…", "Pondering on the lily pad…", "Leaping to conclusions…"];
  var FROG_SVG = '<svg class="frog-thinking-frog" viewBox="130 205 764 650"><g class="ft-body"><circle cx="340" cy="400" r="135"/><circle cx="684" cy="400" r="135"/><ellipse cx="512" cy="610" rx="360" ry="220"/></g><circle class="ft-eye" cx="340" cy="393" r="85"/><circle class="ft-eye" cx="684" cy="393" r="85"/><circle class="ft-pupil" cx="362" cy="408" r="45"/><circle class="ft-pupil" cx="706" cy="408" r="45"/><g class="ft-mouth"><path d="M396 575 L472 632 L396 689"/><path d="M526 689 L636 689"/></g></svg>';

  function makeChat(agentId) {
    var t = { kind: "chat", agent: agentId, cwd: [], ctx: 4, status: "idle", used: {}, view: "chat", transcript: [] };
    var run = 0;
    t.label = function () { return "flowcode"; };
    t.pane = el("section", { "aria-label": "Chat" });
    t.pane.style.setProperty("--ag", AGENTS[agentId].color);
    var header = agentHeader(t, { view: function () { return t.view; }, switchView: function (v) { setView(v); } });
    t.paintHead = header.paint;
    var column = el("div", { class: "chat-column" });
    var content = el("div", { class: "chat-content", "aria-live": "polite" });
    column.append(content);
    var termView = el("div", { class: "fc-term", hidden: "" });
    var tray = el("div", { class: "chat-subtray", role: "status", hidden: "" });
    var input = el("textarea", { class: "chat-input", rows: "1", "aria-label": "Message", placeholder: "Write a message…" });
    var send = el("button", { class: "chat-icon-btn is-send", type: "button", "aria-label": "Send", title: "Send", disabled: "", html: I.send });
    var model = el("span", { class: "chat-mode-pill is-model", title: "Model: " + AGENTS[agentId].model, text: AGENTS[agentId].model });
    var composer = el("div", { class: "chat-composer" }, [
      el("div", { class: "chat-input-row" }, input),
      el("div", { class: "chat-composer-actions" }, [
        el("span", { class: "chat-mode-pill is-mode", title: "Mode: Default", html: I.modeAsk }), model,
        el("span", { class: "chat-actions-spacer" }),
        el("button", { class: "chat-icon-btn", type: "button", title: "Attach files", "aria-label": "Attach files", html: I.clip }),
        el("button", { class: "chat-icon-btn", type: "button", title: "Dictate (Ctrl+Shift+Space)", "aria-label": "Dictate", html: I.mic }),
        send
      ])
    ]);
    var termCard = el("div", { class: "chat-termcard", hidden: "" });
    var wrap = el("div", { class: "chat-composer-wrap" }, [tray, composer, termCard]);
    var view = el("div", { class: "chat-view" }, [header.el, column, termView, wrap]);
    t.pane.append(view);

    t.focus = function () { (t.view === "chat" ? input : termView).focus({ preventScroll: true }); };
    t.clear = null;
    t.stop = function () { if (t.status === "idle") return; run++; done(); content.append(el("div", { class: "chat-md", html: '<p style="color:var(--fg-muted)">Stopped.</p>' })); suggestions(); };

    function setStatus(st) {
      t.status = st; t.busy = st === "busy"; t.waiting = st === "waiting";
      header.paint(); paintTab(t);
      if (st === "idle") { send.innerHTML = I.send; send.setAttribute("aria-label", "Send"); send.title = "Send"; send.disabled = !input.value.trim(); send.classList.remove("is-stop"); }
      else { send.innerHTML = I.stopFill; send.setAttribute("aria-label", "Stop"); send.title = "Stop (Esc)"; send.disabled = false; send.classList.add("is-stop"); }
    }
    function setView(v) {
      t.view = v;
      column.hidden = v !== "chat"; wrap.hidden = v !== "chat"; termView.hidden = v === "chat";
      if (v !== "chat") {
        var a = AGENTS[t.agent];
        termView.innerHTML = '<div class="fc-tui" style="--ag:' + a.color + '"><b>✻ ' + esc(a.name) + '</b><br><span class="c-mut">' + esc(a.model) + " · ~/flowcode</span></div>" +
          (t.transcript.length ? t.transcript.map(function (l) { return '<div class="ln">' + (l[0] === "u" ? '<span class="c-mut">›</span> ' + esc(l[1]) : '<span class="c-ag">⏺</span> ' + esc(l[1])) + "</div>"; }).join("") : '<div class="ln c-mut">No messages yet.</div>') +
          '<div class="ln"></div><div class="ln c-mut">The same session as a terminal. Switch back with the session menu or Ctrl+`.</div>';
        termView.tabIndex = 0;
      }
      t.focus();
    }
    view.addEventListener("keydown", function (e) {
      if (e.key === "`" && e.ctrlKey && t.status !== "busy") { e.preventDefault(); setView(t.view === "chat" ? "terminal" : "chat"); }
      if (e.key === "Escape" && t.status !== "idle" && document.activeElement === input) { e.preventDefault(); t.stop(); }
    });

    input.addEventListener("input", function () { if (t.status === "idle") send.disabled = !input.value.trim(); input.style.height = "auto"; input.style.height = Math.min(120, Math.max(44, input.scrollHeight)) + "px"; });
    input.addEventListener("keydown", function (e) { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } });
    send.addEventListener("click", function () { if (t.status !== "idle") t.stop(); else submit(); });
    function submit() {
      var v = input.value.trim();
      if (!v || t.status !== "idle") return;
      input.value = ""; input.style.height = ""; send.disabled = true;
      var m = PROMPTS.filter(function (p) { return p.label(t).toLowerCase() === v.toLowerCase(); })[0];
      play(m ? m.id : null, v);
    }

    function scrollEnd() { column.scrollTop = column.scrollHeight; }
    function suggestions(into) {
      var left = PROMPTS.filter(function (p) { return !t.used[p.id]; });
      if (!left.length) left = PROMPTS;
      var box = el("div", { class: "fc-sugg" });
      if (into) box.append(el("span", { class: "lbl", text: "Pick a prompt to see a scripted run" }));
      left.forEach(function (p) { box.append(el("button", { type: "button", text: p.label(t), onclick: function () { if (t.status === "idle") play(p.id, p.label(t)); } })); });
      (into || content).append(box);
      scrollEnd();
    }
    function empty() {
      content.innerHTML = "";
      var cv = el("canvas", { "data-frog": "vivid", "aria-hidden": "true" });
      FC.drawFrog(cv, { accent: accentNow(), vivid: true });
      var box = el("div", { class: "chat-empty" }, el("div", { class: "chat-empty-rings" }, cv));
      suggestions(box);
      content.append(box);
    }
    function md(html) { var m = el("div", { class: "chat-md" }); content.append(m); return FC.stream(m, html, { onStep: scrollEnd }).then(function () { t.transcript.push(["a", m.textContent]); }); }
    function thinking() {
      var started = Date.now(), vi = Math.floor(Math.random() * VERBS.length);
      var n = el("div", { class: "frog-thinking", role: "status", html: '<span class="frog-thinking-stage" aria-hidden="true">' + FROG_SVG + '</span><span class="frog-thinking-verb">' + VERBS[vi] + '</span><span class="frog-thinking-meta" aria-hidden="true"></span>' });
      content.append(n); scrollEnd();
      var tick = setInterval(function () {
        if (!n.isConnected) return clearInterval(tick);
        var s = Math.round((Date.now() - started) / 1000);
        n.querySelector(".frog-thinking-meta").textContent = "(" + s + "s · Esc to interrupt)";
      }, 500);
      n.querySelector(".frog-thinking-meta").textContent = "(0s · Esc to interrupt)";
      return n;
    }
    /* ToolGroup: folded to one row; the step count, the latest step while it runs, then the summary */
    function toolGroup(steps, my, opts) {
      opts = opts || {};
      var headBtn = el("button", { class: "chat-tools-head", type: "button", "aria-expanded": "false" });
      var list = el("div", { class: "chat-tools-list", hidden: "" });
      var card = el("div", { class: "chat-tools" }, [headBtn, list]);
      var done = [], live = true;
      function head() {
        var last = done[done.length - 1];
        headBtn.innerHTML = I.groupChev + '<span class="chat-group-count">' + done.length + "</span>" + (live ? '<span class="chat-spinner" aria-hidden="true"></span><span class="chat-group-summary is-live">' + esc(last ? last[0] + " " + last[1] : "") + "</span>" : '<span class="chat-tools-status" aria-hidden="true"></span><span class="chat-group-summary">' + esc(opts.summary) + "</span>");
      }
      headBtn.addEventListener("click", function () { var o = headBtn.getAttribute("aria-expanded") === "true"; headBtn.setAttribute("aria-expanded", String(!o)); list.hidden = o; });
      content.append(card); head(); scrollEnd();
      var chain = Promise.resolve();
      steps.forEach(function (s, i) {
        chain = chain.then(function () {
          if (my !== run) return;
          done.push(s);
          var row = el("div", { class: "chat-step" });
          row.innerHTML = '<div class="chat-step-row"><span class="chat-step-num">' + (i + 1) + '</span><span class="chat-dot is-live" aria-hidden="true"></span><span class="chat-step-title">' + esc(s[0]) + '</span><span class="chat-step-file">' + esc(s[1]) + "</span></div>";
          if (s[2]) row.append(s[2]);
          list.append(row); head(); scrollEnd();
          return sleep(s[3] || 560).then(function () { row.querySelector(".chat-dot").classList.remove("is-live"); });
        });
      });
      return chain.then(function () {
        live = false; head();
        if (opts.open) { headBtn.setAttribute("aria-expanded", "true"); list.hidden = false; scrollEnd(); }
      });
    }
    function diffCard(path, rows) {
      var add = rows.filter(function (r) { return r[0] === "+"; }).length, del = rows.filter(function (r) { return r[0] === "-"; }).length;
      var d = el("div", { class: "chat-diff", html: '<div class="chat-diff-head"><span class="chat-diff-path">' + esc(path) + '</span><span class="chat-diff-count is-add">+' + add + '</span><span class="chat-diff-count is-del">−' + del + '</span></div>' });
      var rws = el("div", { class: "chat-diff-rows" });
      rows.forEach(function (r) { rws.append(el("div", { class: "chat-diff-row" + (r[0] === "+" ? " is-add" : r[0] === "-" ? " is-del" : ""), html: '<span class="chat-diff-sign">' + (r[0] === "+" ? "+" : r[0] === "-" ? "−" : " ") + "</span><span>" + esc(r.slice(1)) + "</span>" })); });
      d.append(rws);
      return d;
    }
    function permission(title, detail, my) {
      return new Promise(function (resolve) {
        var card = el("div", { class: "chat-permission", role: "group", "aria-label": "Permission request", html: '<div class="chat-permission-text"><div class="chat-permission-label">Permission needed</div><div class="chat-permission-title">' + esc(title) + '</div><div class="chat-permission-detail">' + esc(detail) + "</div></div>" });
        var opts = el("div", { class: "chat-permission-options" });
        [["reject", "Reject"], ["always", "Always allow"], ["allow", "Allow"]].forEach(function (o) {
          var b = el("button", { class: "chat-btn" + (o[0] === "allow" ? " is-primary" : ""), type: "button", text: o[1] });
          b.addEventListener("click", function () {
            if (my !== run) return;
            card.classList.add("is-answered");
            card.querySelector(".chat-permission-label").textContent = "Answer: " + o[1];
            setStatus("busy");
            resolve(o[0]);
          });
          opts.append(b);
        });
        card.append(opts);
        content.append(card); scrollEnd();
        setStatus("waiting");
        var first = opts.querySelector(".is-primary");
        if (root.contains(document.activeElement)) first.focus({ preventScroll: true });
      });
    }
    function showTray(name, task) {
      var started = Date.now();
      tray.hidden = false;
      tray.innerHTML = '<div class="chat-subtray-row"><span class="chat-subtray-dot" aria-hidden="true"></span><span class="chat-subtray-name">' + esc(name) + '</span><span class="chat-subtray-task">' + esc(task) + '</span><span class="chat-subtray-time">0s</span></div>';
      var tick = setInterval(function () { if (tray.hidden) return clearInterval(tick); tray.querySelector(".chat-subtray-time").textContent = Math.round((Date.now() - started) / 1000) + "s"; }, 500);
    }
    function showTermCard() {
      var started = Date.now(), open = false;
      termCard.hidden = false;
      function paint() {
        var s = Math.round((Date.now() - started) / 1000);
        termCard.innerHTML = "";
        var h = el("button", { class: "chat-termcard-head", type: "button", "aria-expanded": String(open), html: I.termCard + '<span class="chat-termcard-count">1 background terminal</span><span class="chat-termcard-hint">' + (open ? "↑↓ browse · Enter output" : "↓ to expand") + "</span>" + I.cardChev });
        h.addEventListener("click", function () { open = !open; paint(); termCard.querySelector("button").focus(); });
        termCard.append(h);
        if (open) termCard.append(el("div", { class: "chat-termcard-list", html: '<div class="chat-termcard-row"><span class="chat-subtray-dot" aria-hidden="true"></span><span class="chat-termcard-cmd">npm test -- --watch</span><span class="chat-subtray-time">' + s + 's</span></div><pre class="chat-termcard-out"> ✓ 12 passed\n watching for file changes…</pre>' }));
      }
      paint();
      var tick = setInterval(function () { if (termCard.hidden || !open) return; var x = termCard.querySelector(".chat-subtray-time"); if (x) x.textContent = Math.round((Date.now() - started) / 1000) + "s"; }, 1000);
    }
    async function delegateStrip(to, task, my) {
      var b = AGENTS[to];
      var strip = el("div", { class: "chat-dstrip is-open" });
      var openRows = true, st = "running", live = "starting…", steps = 0, secs = 0;
      function paint() {
        strip.className = "chat-dstrip" + (openRows ? " is-open" : "");
        strip.innerHTML = "";
        var h = el("button", { class: "chat-dstrip-head", type: "button", "aria-expanded": String(openRows), html: '<span class="chat-dstrip-swap">' + I.swap + '</span><b class="chat-dstrip-label">Delegated to ' + esc(b.short) + '</b><span class="chat-dstrip-stack"><span class="chat-dstrip-logo" style="--agent:' + b.color + '">' + logo(to) + '</span></span><span class="chat-dstrip-sum"><span class="chat-dstrip-count is-' + st + '"><i></i>1 ' + (st === "done" ? "done" : "running") + "</span></span>" + I.dChev });
        h.addEventListener("click", function () { openRows = !openRows; paint(); });
        strip.append(h);
        if (openRows) {
          strip.append(el("div", { class: "chat-dstrip-rows", html: '<div class="chat-dstrip-row is-' + st + '" style="--agent:' + b.color + '"><span class="chat-dstrip-ic">' + (st === "done" ? "✓" : '<span class="chat-spinner" aria-hidden="true"></span>') + '</span><span class="chat-dstrip-logo is-row">' + logo(to) + '</span><span class="chat-dstrip-title">' + esc(task) + '</span><span class="chat-dstrip-sep" aria-hidden="true">—</span><span class="chat-dstrip-live' + (st === "running" ? " is-mono" : "") + '">' + esc(live) + '</span><span class="chat-dstrip-time">' + (st === "done" ? secs + "s" : steps + " steps") + "</span></div>" }));
        }
      }
      content.append(strip); paint(); scrollEnd();
      var phases = ["Read src/auth/redirect.ts", "Write tests/redirect.test.ts", "Run npm test -- redirect"];
      for (var i = 0; i < phases.length; i++) { await sleep(950); if (my !== run) return; steps = i + 1; live = phases[i]; paint(); }
      await sleep(900); if (my !== run) return;
      st = "done"; live = "4 tests added, all passing"; secs = 38; openRows = false; paint();
    }
    function done() { tray.hidden = true; setStatus("idle"); }

    async function play(id, typed) {
      var my = ++run, ok = function () { return my === run; };
      if (content.querySelector(".chat-empty")) content.innerHTML = "";
      content.querySelectorAll(".fc-sugg").forEach(function (n) { n.remove(); });
      content.append(el("div", { class: "chat-user", text: typed }));
      t.transcript.push(["u", typed]);
      setStatus("busy");
      var th = thinking();
      await sleep(1100); if (!ok()) { th.remove(); return; }
      th.remove();
      if (id) t.used[id] = true;
      if (id === "fix") {
        await md("<p>Let me look at how the redirect is chosen after sign-in.</p>"); if (!ok()) return;
        await toolGroup([["Read", "src/auth/redirect.ts"], ["Read", "src/auth/session.ts"], ["Search", '"returnTo"']], my, { summary: "2 files read · 1 search" }); if (!ok()) return;
        await md("<p>Found it: when <code>returnTo</code> points back at <code>/login</code>, the guard sends you to <code>/login</code> again, forever. I'll ignore login URLs as a return target.</p>"); if (!ok()) return;
        var diff = diffCard("src/auth/redirect.ts", [" export function nextUrl(returnTo?: string) {", '-  return returnTo ?? "/";', '+  if (!returnTo || returnTo.startsWith("/login")) {', '+    return "/";', "+  }", "+  return returnTo;", " }"]);
        await toolGroup([["Edit", "src/auth/redirect.ts", diff, 700]], my, { summary: "1 edit", open: true }); if (!ok()) return;
        S.fixed = true; setGit("src/auth/redirect.ts", "M");
        t.ctx = Math.min(60, t.ctx + 7); header.paint();
        var v = await permission("Run npm test -- --watch", "npm test -- --watch", my); if (!ok()) return;
        if (v === "reject") { await md("<p>Okay, I won't run the tests. The fix is in place; run <code>npm test</code> whenever you like.</p>"); }
        else {
          var outp = el("pre", { class: "chat-tool-output", text: " ✓ tests/login.test.ts (8)\n ✓ src/auth/redirect.test.ts (4)\n\n Tests  12 passed\n watching for file changes…" });
          await toolGroup([["Run", "npm test -- --watch", outp, 1000]], my, { summary: "1 command" }); if (!ok()) return;
          showTermCard();
          await md("<p>Fixed. Signing in from <code>/login</code> now lands on <code>/</code> and all <b>12 tests</b> pass. The watcher keeps running in the background (the card under the composer). The file shows up as modified in the Explorer; the Git drawer below it can commit it.</p>");
        }
      } else if (id === "explain") {
        showTray("Explore", "Map the files in src/chat");
        await toolGroup([["List", "src/chat", null, 600], ["Read", "src/chat/Chat.tsx"], ["Read", "src/chat/stream.ts"]], my, { summary: "2 files read · 1 other step" }); if (!ok()) return;
        tray.hidden = true;
        await md("<p><code>src/chat</code> is the chat view you're looking at:</p><ul><li><code>Chat.tsx</code> renders the timeline and the composer.</li><li><code>stream.ts</code> turns the agent's events into messages, tool groups and diffs.</li><li><code>chat.css</code> holds the look: bubbles, cards, the rounded composer.</li></ul><p>The real chat also renders images, mermaid diagrams, math and tables.</p>");
        t.ctx = Math.min(60, t.ctx + 5); header.paint();
      } else if (id === "delegate") {
        var o = t.agent === "codex" ? "claude" : "codex";
        await md("<p>Good idea. I'll hand it to <b>" + esc(AGENTS[o].short) + "</b> through the Flowcode MCP server and keep an eye on it.</p>"); if (!ok()) return;
        await delegateStrip(o, "Write tests for redirect.ts", my); if (!ok()) return;
        FS.tests["redirect.test.ts"] = 1; S.tested = true; t.delegated = o;
        setGit("tests/redirect.test.ts", "U");
        await md("<p>" + esc(AGENTS[o].short) + " added <b>4 tests</b> in <code>tests/redirect.test.ts</code>, all green. Its session is one click away in the strip, and in the agent panel under Delegates.</p>");
        t.ctx = Math.min(60, t.ctx + 4); header.paint();
      } else {
        await md("<p>This window is a scripted preview, so I can't really answer <i>“" + esc(typed.slice(0, 80)) + "”</i> here. In Flowcode, this message goes straight to " + esc(AGENTS[t.agent].name) + " on your machine, with your files and your shell.</p>");
      }
      if (!ok()) return;
      done();
      rerenderInsight();
      suggestions();
    }
    empty();
    return t;
  }

  /* ---------------------------------------------------------- open a chat (New tab dialog, History, "Open as chat") */
  function openChat(agentId, fromTerm) {
    var existing = tabs.filter(function (x) { return x.kind === "chat" && x.agent === agentId; })[0];
    if (existing) { select(existing, true); return; }
    var spare = tabs.filter(function (x) { return x.kind === "chat" && x.status === "idle" && !x.transcript.length; })[0];
    var t = makeChat(agentId);
    if (spare) { var i = tabs.indexOf(spare); closeTab(spare); addTab(t, i); }
    else if (tabs.length >= 6) { var old = tabs.filter(function (x) { return x.kind === "chat" && x.status === "idle"; })[0]; if (old) { var j = tabs.indexOf(old); closeTab(old); addTab(t, j); } else addTab(t); }
    else addTab(t, fromTerm ? tabs.indexOf(fromTerm) + 1 : null);
    select(t, true);
  }

  /* New tab dialog (newtab/GlassNewTab.tsx, dialog mode) */
  var glass = null;
  function newTabDialog() {
    if (glass) return;
    var opener = document.activeElement;
    var input = el("input", { class: "glass-search-input", type: "text", placeholder: "What do you want to open?", "aria-label": "What do you want to open?", autocomplete: "off", spellcheck: "false" });
    var agentsRow = el("div", { class: "glass-agents", role: "group", "aria-label": "Agents" });
    FC.AGENT_ORDER.forEach(function (id) {
      var a = AGENTS[id];
      var b = el("button", { class: "glass-agent", type: "button", style: "--agent:" + a.color, html: '<span class="glass-icon">' + logo(id) + "</span>" + esc(a.name) });
      b.addEventListener("click", function () { close(); openChat(id); });
      agentsRow.append(b);
    });
    var recents = el("div", { class: "glass-list" });
    [[[], "2 min ago"], [["src"], "1 h ago"], [["site"], "yesterday"]].forEach(function (r) {
      var b = el("button", { class: "glass-row", type: "button", html: '<span class="glass-icon" style="color:var(--accent-2)">' + I.folder + "</span>" + esc(pathLabel(r[0])) + "<small>" + r[1] + "</small>" });
      b.addEventListener("click", function () { close(); newTerminal(r[0]); });
      recents.append(b);
    });
    var panel = el("div", { class: "glass-panel", role: "dialog", "aria-modal": "true", "aria-label": "New tab" }, [
      el("div", { class: "glass-search" }, [el("span", { html: I.search }), input, el("kbd", { class: "glass-kbd", text: "↵ zsh" })]),
      el("div", { class: "glass-filters", "aria-hidden": "true", html: '<span class="glass-filter is-on">All</span><span class="glass-filter">Folders</span><span class="glass-filter">Agents</span><span class="glass-filter">Recents</span>' }),
      el("div", { class: "glass-body" }, [el("h2", { class: "glass-heading", text: "Agents" }), agentsRow, el("h2", { class: "glass-heading", text: "Recents" }), recents]),
      el("div", { class: "glass-foot", html: '<span class="glass-shell is-on">zsh</span><span class="glass-shell">bash</span><p class="glass-keys">↵ open · ↑↓ pick · Esc close</p>' })
    ]);
    glass = el("div", { class: "glass-backdrop" }, panel);
    glass.addEventListener("mousedown", function (e) { if (e.target === glass) close(); });
    panel.addEventListener("keydown", function (e) {
      if (e.key === "Escape") { e.preventDefault(); close(); if (opener && opener.focus) opener.focus({ preventScroll: true }); return; }
      if (e.key === "Tab") {
        var f = Array.prototype.slice.call(panel.querySelectorAll("input, button")), i = f.indexOf(document.activeElement);
        e.preventDefault(); f[(i + (e.shiftKey ? -1 : 1) + f.length) % f.length].focus();
      }
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        var g = Array.prototype.slice.call(panel.querySelectorAll(".glass-agent, .glass-row")), k = g.indexOf(document.activeElement);
        e.preventDefault(); g[e.key === "ArrowDown" ? Math.min(g.length - 1, k + 1) : Math.max(0, k - 1)].focus();
      }
    });
    input.addEventListener("keydown", function (e) {
      if (e.key !== "Enter") return;
      var q = input.value.trim().toLowerCase();
      var hit = FC.AGENT_ORDER.filter(function (id) { return q && (id.indexOf(q) === 0 || AGENTS[id].name.toLowerCase().indexOf(q) === 0); })[0];
      close();
      if (hit) openChat(hit);
      else { var tm = newTerminal([]); if (q) tm.exec(input.value.trim()); }
    });
    input.addEventListener("input", function () {
      var q = input.value.trim().toLowerCase();
      agentsRow.querySelectorAll(".glass-agent").forEach(function (b, i) { var id = FC.AGENT_ORDER[i]; b.hidden = !!q && AGENTS[id].name.toLowerCase().indexOf(q) < 0 && id.indexOf(q) < 0; });
    });
    function close() { if (glass) { glass.remove(); glass = null; } }
    root.append(glass);
    input.focus({ preventScroll: true });
  }
  function newTerminal(cwd) {
    if (tabs.length >= 6) { var t0 = tabs.filter(function (x) { return x.kind === "term"; })[0]; select(t0, true); return t0; }
    var tm = new Term({ cwd: cwd });
    addTab(tm);
    tm.print('<span class="c-mut">New terminal in ' + esc(pathLabel(cwd)) + ". Type help, or try claude.</span>");
    select(tm, true);
    return tm;
  }
  newBtn.addEventListener("click", newTabDialog);
  root.addEventListener("keydown", function (e) { if (e.ctrlKey && (e.key === "t" || e.key === "T")) { e.preventDefault(); newTabDialog(); } });

  /* ---------------------------------------------------------- palette */
  function setPalette(id) {
    S.palette = id;
    FC.applyPalette(root, id);
    document.querySelectorAll("[data-palette-for='hero'] .swatch").forEach(function (b) { b.setAttribute("aria-pressed", String(b.dataset.p === id)); });
    root.querySelectorAll(".fc-splash canvas").forEach(function (c) { FC.drawFrog(c, { accent: FC.PALETTES[id].accent }); });
  }
  var picker = document.querySelector("[data-palette-for='hero'] .swatches");
  if (picker) {
    ["flowcode", "ocean", "ember", "lavender", "mint", "nord"].forEach(function (id) {
      var p = FC.PALETTES[id];
      var b = el("button", { class: "swatch", type: "button", "data-p": id, "aria-pressed": String(id === S.palette), "aria-label": p.name + " palette", title: p.name, style: "--sw-a:" + p.accent + ";--sw-b:rgb(" + p.bg + ")" });
      b.addEventListener("click", function () { setPalette(id); });
      picker.append(el("li", null, b));
    });
  }

  /* ---------------------------------------------------------- boot */
  var term = new Term({});
  addTab(term);
  addTab(makeChat("claude"));
  addTab(makeDev());
  term.splash();
  select(term, false);
})();
