// Timeline: a Flowcode agent view that shows the conversation as an activity
// log. It talks to the app through the SDK (flowcode-view.iife.js) and gets
// what to draw from rows.js; this file is only the DOM.
(function () {
  var STRINGS = {
    it: {
      you: "Tu",
      plan: "Piano",
      planCount: function (done, total) {
        return done + " di " + total;
      },
      thoughts: "Ragionamento",
      empty: "Nessuna attività, per ora.",
      placeholder: "Scrivi all'agente…",
      queuePlaceholder: "Aggiungi alla coda…",
      readOnly: "Questa vista non può inviare messaggi",
      send: "Invia",
      stop: "Ferma",
      queued: "In coda: ",
      open: "Apri ",
      permissionAsked: "Richiesta di permesso",
      permissionDone: "Permesso gestito",
      denied: "Azione non consentita: ",
      more: function (n) {
        return "… altre " + n + " righe";
      },
      state: {
        starting: "Avvio…",
        idle: "Pronto",
        busy: "L'agente sta lavorando…",
        waiting: "In attesa di un permesso",
        exited: "L'agente si è chiuso",
      },
    },
    en: {
      you: "You",
      plan: "Plan",
      planCount: function (done, total) {
        return done + " of " + total;
      },
      thoughts: "Reasoning",
      empty: "No activity yet.",
      placeholder: "Write to the agent…",
      queuePlaceholder: "Add to the queue…",
      readOnly: "This view can't send messages",
      send: "Send",
      stop: "Stop",
      queued: "Queued: ",
      open: "Open ",
      permissionAsked: "Permission requested",
      permissionDone: "Permission handled",
      denied: "Not allowed: ",
      more: function (n) {
        return "… " + n + " more lines";
      },
      state: {
        starting: "Starting…",
        idle: "Ready",
        busy: "The agent is working…",
        waiting: "Waiting for a permission",
        exited: "The agent has exited",
      },
    },
  };

  // Stroke icons on a 24px grid.
  var ICONS = {
    read: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5M9 13h6M9 17h6"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="m20 20-3.5-3.5"/>',
    edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
    execute: '<path d="m4 17 6-6-6-6M12 19h8"/>',
    other: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
    cross: '<path d="M18 6 6 18M6 6l12 12"/>',
    spinner: '<path d="M21 12a9 9 0 1 1-6.2-8.55"/>',
    send: '<path d="M12 19V5M5 12l7-7 7 7"/>',
    stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
    planPending: '<circle cx="12" cy="12" r="9"/>',
    planActive: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/>',
    planDone: '<circle cx="12" cy="12" r="9"/><path d="m8 12 3 3 5-6"/>',
  };

  var SVG_NS = "http://www.w3.org/2000/svg";
  var FOLLOW_DISTANCE = 80;
  var ERROR_MS = 4000;

  var $ = function (id) {
    return document.getElementById(id);
  };
  var els = {
    state: $("state"),
    thoughts: $("thoughts"),
    plan: $("plan"),
    log: $("log"),
    queue: $("queue"),
    text: $("text"),
    stop: $("stop"),
    send: $("send"),
  };
  var rowsEl = document.createElement("div");
  rowsEl.className = "rows";
  var emptyEl = document.createElement("div");
  emptyEl.className = "empty";
  els.log.append(rowsEl);
  els.log.prepend(emptyEl);

  var client = null;
  var t = STRINGS.en;
  var showThoughts = false;
  var cache = new Map(); // row id -> { sig, el }
  var planSig = "";
  var follow = true;
  var frame = 0;
  var errorTimer = 0;
  var flash = "";

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function icon(name, className) {
    var svg = document.createElementNS(SVG_NS, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    if (className) svg.setAttribute("class", className);
    svg.innerHTML = ICONS[name];
    return svg;
  }

  function setIcon(button, name) {
    button.querySelector("svg")?.remove();
    button.prepend(icon(name));
  }

  /** A path as the user knows it: relative to the project when it's inside. */
  function shortPath(path) {
    var cwd = client.init.session.cwd.replace(/[\\/]+$/, "");
    if (cwd && path.slice(0, cwd.length).toLowerCase() === cwd.toLowerCase() && /[\\/]/.test(path.charAt(cwd.length))) {
      return path.slice(cwd.length + 1);
    }
    return path;
  }

  function fileNode(file) {
    var label = shortPath(file.path) + (file.line ? ":" + file.line : "");
    if (!client.can("openFile")) {
      var span = el("span", "file", label);
      span.title = file.path;
      return span;
    }
    var button = el("button", "file", label);
    button.type = "button";
    button.title = file.path;
    button.setAttribute("aria-label", t.open + label);
    button.addEventListener("click", function () {
      client.openFile(file.path);
    });
    return button;
  }

  function diffNode(diff) {
    var box = el("div", "diff");
    var head = el("div", "diff-head", shortPath(diff.path) + "  ");
    head.append(el("span", "add", "+" + diff.added), " ", el("span", "del", "-" + diff.removed));
    box.append(head);
    diff.rows.forEach(function (row) {
      box.append(el("div", "diff-row " + row.type, (row.type === "add" ? "+ " : "- ") + row.text));
    });
    if (diff.hidden) box.append(el("div", "diff-more", t.more(diff.hidden)));
    return box;
  }

  function statusNode(status) {
    if (status === "in_progress") return icon("spinner", "in_progress spin");
    if (status === "completed") return icon("check", "completed");
    if (status === "failed") return icon("cross", "failed");
    return null;
  }

  function bodyOf(row) {
    var body = el("div", "body");
    switch (row.kind) {
      case "user": {
        var text = el("div", "text");
        text.append(el("span", "who", t.you), row.text);
        body.append(text);
        break;
      }
      case "tool": {
        var line = el("div", "tool-line");
        var end = el("span", "tool-end");
        var status = statusNode(row.status);
        if (status) end.append(status);
        if (row.duration) end.append(row.duration);
        line.append(icon(row.icon, "tool-icon"), el("span", "tool-title", row.title), end);
        body.append(line);
        if (row.files.length) {
          var files = el("div", "files");
          row.files.forEach(function (file) {
            files.append(fileNode(file));
          });
          body.append(files);
        }
        row.diffs.forEach(function (diff) {
          body.append(diffNode(diff));
        });
        break;
      }
      case "permission":
        body.append(el("div", "text", (row.pending ? t.permissionAsked : t.permissionDone) + (row.title ? ": " + row.title : "")));
        break;
      default: {
        // The agent's own words (and reasoning) are markdown.
        var md = el("div", "text md");
        md.append(FlowcodeView.renderMarkdown(row.text, document));
        body.append(md);
      }
    }
    return body;
  }

  function buildRow(row) {
    var node = el("div", "row " + row.kind);
    node.append(el("span", "time", row.showTime ? TimelineRows.formatClock(row.at) : ""), bodyOf(row));
    return node;
  }

  function renderPlan(plan) {
    var sig = JSON.stringify(plan);
    if (sig === planSig) return;
    planSig = sig;
    els.plan.hidden = !plan;
    els.plan.textContent = "";
    if (!plan) return;
    var card = el("div", "plan-card");
    var head = el("div", "plan-head");
    var count = el("span", "plan-count", t.planCount(plan.done, plan.total));
    head.append(el("span", "", t.plan), count);
    var bar = el("div", "plan-bar");
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", String(plan.total));
    bar.setAttribute("aria-valuenow", String(plan.done));
    bar.setAttribute("aria-label", t.plan + " " + count.textContent);
    var fill = el("span");
    fill.style.width = (plan.done / plan.total) * 100 + "%";
    bar.append(fill);
    var list = el("ul", "plan-list");
    plan.entries.forEach(function (entry) {
      var item = el("li", entry.status);
      var name = entry.status === "completed" ? "planDone" : entry.status === "in_progress" ? "planActive" : "planPending";
      item.append(icon(name), el("span", "", entry.content));
      list.append(item);
    });
    card.append(head, bar, list);
    els.plan.append(card);
  }

  function renderRows(rows) {
    var seen = new Set();
    var ref = rowsEl.firstChild;
    rows.forEach(function (row) {
      seen.add(row.id);
      var sig = JSON.stringify(row);
      var entry = cache.get(row.id);
      if (!entry || entry.sig !== sig) {
        var node = buildRow(row);
        if (entry) {
          if (ref === entry.el) ref = node;
          entry.el.replaceWith(node);
        }
        entry = { sig: sig, el: node };
        cache.set(row.id, entry);
      }
      if (entry.el === ref) ref = ref.nextSibling;
      else rowsEl.insertBefore(entry.el, ref);
    });
    cache.forEach(function (entry, id) {
      if (seen.has(id)) return;
      entry.el.remove();
      cache.delete(id);
    });
    emptyEl.hidden = rows.length > 0;
  }

  function render() {
    frame = 0;
    var built = TimelineRows.buildTimeline(client.model, client.timing, showThoughts);
    var near = els.log.scrollHeight - els.log.scrollTop - els.log.clientHeight < FOLLOW_DISTANCE;
    renderPlan(built.plan);
    els.thoughts.hidden = !built.thoughts;
    renderRows(built.rows);
    if (follow || near) els.log.scrollTop = els.log.scrollHeight;
    follow = false;
    updateBar();
  }

  function schedule() {
    if (!frame) frame = requestAnimationFrame(render);
  }

  function isBusy() {
    var status = client.status && client.status.status;
    return status === "busy" || status === "waiting";
  }

  /** The state line, the queue and the composer: everything that follows the status. */
  function updateBar() {
    var status = client.status ? client.status.status : "starting";
    els.state.className = flash ? "error" : "";
    els.state.textContent = flash || t.state[status] || status;
    var queued = client.status ? client.status.queued : [];
    els.queue.hidden = queued.length === 0;
    els.queue.textContent = "";
    queued.forEach(function (message) {
      var chip = el("span", "chip", message);
      chip.title = t.queued + message;
      els.queue.append(chip);
    });
    var canSend = client.can("send");
    els.text.disabled = !canSend;
    els.text.placeholder = !canSend ? t.readOnly : isBusy() ? t.queuePlaceholder : t.placeholder;
    els.send.disabled = !canSend || els.text.value.trim() === "";
    els.stop.hidden = !(isBusy() && client.can("cancel"));
  }

  function autosize() {
    els.text.style.height = "auto";
    els.text.style.height = els.text.scrollHeight + 2 + "px";
  }

  function send() {
    var value = els.text.value.trim();
    if (!value || !client.can("send")) return;
    client.send(value);
    els.text.value = "";
    autosize();
    follow = true;
    updateBar();
  }

  function setInsets(insets) {
    ["top", "right", "bottom", "left"].forEach(function (side) {
      document.documentElement.style.setProperty("--inset-" + side, (insets ? insets[side] : 0) + "px");
    });
  }

  /** A new conversation (or the first): language, insets, a clean list. */
  function start() {
    t = STRINGS[client.init.locale] || STRINGS.en;
    document.documentElement.lang = client.init.locale;
    FlowcodeView.applyTheme(client.theme);
    setInsets(client.init.insets);
    emptyEl.textContent = t.empty;
    els.thoughts.textContent = t.thoughts;
    els.thoughts.setAttribute("aria-label", t.thoughts);
    els.send.setAttribute("aria-label", t.send);
    els.stop.setAttribute("aria-label", t.stop);
    els.stop.textContent = t.stop;
    setIcon(els.stop, "stop");
    setIcon(els.send, "send");
    els.text.setAttribute("aria-label", t.placeholder);
    cache.forEach(function (entry) {
      entry.el.remove();
    });
    cache.clear();
    planSig = "";
    follow = true;
    flash = "";
    render();
  }

  els.thoughts.addEventListener("click", function () {
    showThoughts = !showThoughts;
    els.thoughts.setAttribute("aria-pressed", String(showThoughts));
    schedule();
  });
  els.stop.addEventListener("click", function () {
    client.cancel();
  });
  els.send.addEventListener("click", send);
  els.text.addEventListener("input", function () {
    autosize();
    updateBar();
  });
  els.text.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      send();
    }
  });

  FlowcodeView.connect().then(function (connected) {
    client = connected;
    client.on("init", start);
    client.on("model", schedule);
    client.on("status", updateBar);
    client.on("theme", FlowcodeView.applyTheme);
    client.on("error", function (error) {
      flash = t.denied + error.request;
      clearTimeout(errorTimer);
      errorTimer = setTimeout(function () {
        flash = "";
        updateBar();
      }, ERROR_MS);
      updateBar();
    });
    start();
  });
})();
