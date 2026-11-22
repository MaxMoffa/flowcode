// Flowcode agent browser control: the script injected (on demand, idempotent) into a controlled page.
// It builds the accessibility-style snapshot, resolves element refs to rects, does the few actions that are
// plain DOM work, draws the highlight and records real user input. Trusted input (clicks, keys, text) is sent
// by Rust through the DevTools protocol. It is one statement: Rust wraps it in `if (!window.__fcCtl) { ... }`.
window.__fcCtl = (function () {
  var REF = "data-fc-ref";
  var SKIP = { SCRIPT: 1, STYLE: 1, NOSCRIPT: 1, TEMPLATE: 1, HEAD: 1, META: 1, LINK: 1, BR: 1, WBR: 1 };
  var refs = new Map();
  var counter = 0;

  // ---- user input watch: real input while the agent is not acting
  window.__fcAgentActing = false;
  window.__fcAgentUntil = 0;
  window.__fcUserAt = window.__fcUserAt || 0;
  var seen = function (e) {
    if (!e.isTrusted || window.__fcAgentActing || Date.now() < window.__fcAgentUntil) return;
    window.__fcUserAt = Date.now();
  };
  ["pointerdown", "keydown", "wheel", "touchstart"].forEach(function (name) {
    window.addEventListener(name, seen, { capture: true, passive: true });
  });

  function visible(el) {
    if (typeof el.checkVisibility === "function") {
      try {
        return el.checkVisibility({ checkOpacity: false, checkVisibilityCSS: true });
      } catch (e) { /* fall through */ }
    }
    var cs = getComputedStyle(el);
    return cs.display !== "none" && cs.visibility !== "hidden" && el.getClientRects().length > 0;
  }

  function clip(text, max) {
    text = String(text == null ? "" : text).replace(/\s+/g, " ").trim();
    return text.length > max ? text.slice(0, max - 1) + "…" : text;
  }

  function roleOf(el) {
    var explicit = (el.getAttribute("role") || "").split(" ")[0].toLowerCase();
    if (explicit) return explicit;
    var tag = el.tagName;
    switch (tag) {
      case "A": return el.hasAttribute("href") ? "link" : "";
      case "BUTTON": return "button";
      case "SELECT": return el.multiple ? "listbox" : "combobox";
      case "TEXTAREA": return "textbox";
      case "SUMMARY": return "button";
      case "OPTION": return "option";
      case "INPUT": {
        var t = (el.getAttribute("type") || "text").toLowerCase();
        if (t === "hidden") return "";
        if (t === "checkbox" || t === "radio") return t;
        if (t === "button" || t === "submit" || t === "reset" || t === "image") return "button";
        if (t === "range") return "slider";
        if (t === "number") return "spinbutton";
        if (t === "search") return "searchbox";
        if (t === "file") return "filepicker";
        return "textbox";
      }
      case "H1": case "H2": case "H3": case "H4": case "H5": case "H6": return "heading";
      case "NAV": return "navigation";
      case "MAIN": return "main";
      case "HEADER": return "banner";
      case "FOOTER": return "contentinfo";
      case "ASIDE": return "complementary";
      case "FORM": return "form";
      case "DIALOG": return "dialog";
      case "UL": case "OL": return "list";
      case "LI": return "listitem";
      case "TABLE": return "table";
      case "TR": return "row";
      case "TD": return "cell";
      case "TH": return "columnheader";
      case "IMG": return "img";
      case "IFRAME": return "iframe";
      case "P": return "paragraph";
    }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return "textbox";
    return "";
  }

  var INTERACTIVE = {
    link: 1, button: 1, checkbox: 1, radio: 1, textbox: 1, searchbox: 1, combobox: 1, listbox: 1, option: 1,
    slider: 1, spinbutton: 1, switch: 1, tab: 1, menuitem: 1, menuitemcheckbox: 1, menuitemradio: 1, filepicker: 1,
    treeitem: 1
  };
  var LANDMARK = { navigation: 1, main: 1, banner: 1, contentinfo: 1, complementary: 1, form: 1, dialog: 1, list: 1, table: 1, region: 1, alertdialog: 1, tablist: 1, menu: 1, toolbar: 1 };

  function nameOf(el, role) {
    var v = el.getAttribute("aria-label");
    if (v && v.trim()) return clip(v, 100);
    var by = el.getAttribute("aria-labelledby");
    if (by) {
      var parts = by.split(/\s+/).map(function (id) {
        var n = document.getElementById(id);
        return n ? n.textContent : "";
      });
      var joined = clip(parts.join(" "), 100);
      if (joined) return joined;
    }
    if (el.labels && el.labels.length) {
      var l = clip(Array.prototype.map.call(el.labels, function (x) { return x.textContent; }).join(" "), 100);
      if (l) return l;
    }
    if (el.tagName === "IMG") return clip(el.getAttribute("alt") || "", 100);
    if (el.tagName === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "button" || t === "submit" || t === "reset") return clip(el.value || t, 100);
      return clip(el.getAttribute("placeholder") || el.getAttribute("title") || el.getAttribute("name") || "", 100);
    }
    if (role === "textbox" || role === "searchbox" || role === "combobox") {
      var ph = el.getAttribute("placeholder") || el.getAttribute("title");
      if (ph) return clip(ph, 100);
      if (el.tagName !== "SELECT") return "";
    }
    var text = clip(el.innerText || el.textContent || "", 100);
    return text || clip(el.getAttribute("title") || "", 100);
  }

  function refOf(el) {
    var r = el.getAttribute(REF);
    if (!r || refs.get(r) !== el) {
      r = "e" + (++counter);
      el.setAttribute(REF, r);
      refs.set(r, el);
    }
    return r;
  }

  function states(el, role) {
    var out = [];
    if (el.disabled || el.getAttribute("aria-disabled") === "true") out.push("disabled");
    if (el.checked === true || el.getAttribute("aria-checked") === "true") out.push("checked");
    if (el.getAttribute("aria-expanded")) out.push("expanded=" + el.getAttribute("aria-expanded"));
    if (el.getAttribute("aria-selected") === "true" || el.selected === true) out.push("selected");
    if (el.getAttribute("aria-pressed") === "true") out.push("pressed");
    if (el.required) out.push("required");
    if (el.readOnly) out.push("readonly");
    if (document.activeElement === el) out.push("focused");
    if (role === "link" && el.href) {
      try { out.push("href=" + clip(new URL(el.href, location.href).href, 160)); } catch (e) { /* ignore */ }
    }
    return out;
  }

  function valueOf(el) {
    if (el.tagName === "INPUT") {
      var t = (el.getAttribute("type") || "text").toLowerCase();
      if (t === "password") return "[password]";
      if (t === "checkbox" || t === "radio" || t === "button" || t === "submit" || t === "reset" || t === "image" || t === "file") return null;
      return el.value ? clip(el.value, 120) : null;
    }
    if (el.tagName === "TEXTAREA") return el.value ? clip(el.value, 200) : null;
    if (el.tagName === "SELECT") {
      return clip(Array.prototype.map.call(el.selectedOptions || [], function (o) { return o.text; }).join(", "), 120);
    }
    if (el.isContentEditable && el.getAttribute("contenteditable") !== null) return clip(el.textContent, 200) || null;
    return null;
  }

  function hasInteractiveChild(el) {
    return !!el.querySelector("a[href],button,input,select,textarea,[role=button],[role=link],[role=checkbox],[role=tab],[role=menuitem],[contenteditable]");
  }

  function snapshot(opts) {
    var max = (opts && opts.maxChars) || 30000;
    var lines = [];
    var size = 0;
    var truncated = false;
    function push(depth, text) {
      if (truncated) return;
      var line = new Array(depth + 1).join("  ") + text;
      if (size + line.length > max) { truncated = true; return; }
      size += line.length + 1;
      lines.push(line);
    }
    function walk(el, depth) {
      if (truncated || SKIP[el.tagName]) return;
      if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("hidden")) return;
      if (!visible(el)) return;
      var role = roleOf(el);
      var next = depth;
      if (INTERACTIVE[role]) {
        var line = "- " + role;
        var name = nameOf(el, role);
        if (name) line += ' "' + name.replace(/"/g, "'") + '"';
        line += " [ref=" + refOf(el) + "]";
        var st = states(el, role);
        var val = valueOf(el);
        if (val !== null) st.push('value="' + String(val).replace(/"/g, "'") + '"');
        if (st.length) line += " (" + st.join(", ") + ")";
        push(depth, line);
        if (role !== "button" && role !== "link" && role !== "option" && role !== "tab" && role !== "menuitem" && !(role === "textbox" && el.tagName !== "DIV") && el.tagName !== "SELECT" && hasInteractiveChild(el)) {
          next = depth + 1;
        } else {
          return;
        }
      } else if (role === "heading") {
        var h = clip(el.innerText || el.textContent, 160);
        if (h) push(depth, "- heading \"" + h.replace(/"/g, "'") + "\" [level=" + el.tagName.slice(1) + "]");
        return;
      } else if (role === "img") {
        var alt = clip(el.getAttribute("alt") || el.getAttribute("aria-label") || "", 100);
        if (alt) push(depth, '- img "' + alt.replace(/"/g, "'") + '"');
        return;
      } else if (role === "iframe") {
        var src = "";
        try { src = new URL(el.src, location.href).origin; } catch (e) { /* ignore */ }
        push(depth, '- iframe "' + clip(el.title || "", 60) + '"' + (src ? " (" + src + ", content not readable)" : ""));
        return;
      } else if (LANDMARK[role]) {
        var label = clip(el.getAttribute("aria-label") || "", 80);
        push(depth, "- " + role + (label ? ' "' + label.replace(/"/g, "'") + '"' : "") + ":");
        next = depth + 1;
      }
      var kids = el.shadowRoot ? el.shadowRoot.childNodes : el.childNodes;
      var run = "";
      var flush = function () {
        var t = clip(run, 240);
        if (t) push(next, "- text: " + t);
        run = "";
      };
      for (var i = 0; i < kids.length && !truncated; i++) {
        var c = kids[i];
        if (c.nodeType === 3) {
          run += " " + c.nodeValue;
        } else if (c.nodeType === 1) {
          var crole = roleOf(c);
          if (!INTERACTIVE[crole] && !LANDMARK[crole] && crole !== "heading" && crole !== "img" && crole !== "iframe" && !hasBlock(c)) {
            // Inline text-only element: join into the running text.
            if (!SKIP[c.tagName] && visible(c) && c.getAttribute("aria-hidden") !== "true") run += " " + (c.innerText || c.textContent || "");
            continue;
          }
          flush();
          walk(c, next);
        }
      }
      flush();
    }
    function hasBlock(c) {
      if (!c.firstElementChild) return false;
      return !!c.querySelector("a[href],button,input,select,textarea,h1,h2,h3,h4,h5,h6,img,iframe,ul,ol,table,nav,form,[role],[contenteditable],p,div,section,article,li");
    }
    var root = document.body || document.documentElement;
    push(0, "Page: " + clip(document.title, 160));
    push(0, "URL: " + location.href);
    push(0, "Viewport: " + innerWidth + "x" + innerHeight + ", scroll " + Math.round(scrollX) + "," + Math.round(scrollY) + " of " + Math.round(document.documentElement.scrollWidth) + "x" + Math.round(document.documentElement.scrollHeight));
    walk(root, 0);
    if (truncated) lines.push("[snapshot truncated at about " + max + " characters: scroll, or act on what is listed and snapshot again]");
    return { text: lines.join("\n"), truncated: truncated };
  }

  function find(ref) {
    var el = refs.get(ref);
    if (!el || !el.isConnected) return null;
    return el;
  }

  function describe(el) {
    var role = roleOf(el) || el.tagName.toLowerCase();
    var name = nameOf(el, role);
    return role + (name ? ' "' + name + '"' : "");
  }

  function highlight(r) {
    try {
      var box = document.createElement("div");
      var s = box.style;
      s.cssText = "position:fixed;pointer-events:none;z-index:2147483647;box-sizing:border-box;border:2px solid #f5a623;border-radius:4px;background:rgba(245,166,35,.14);transition:opacity .3s;";
      s.left = r.x - 3 + "px";
      s.top = r.y - 3 + "px";
      s.width = r.w + 6 + "px";
      s.height = r.h + 6 + "px";
      (document.body || document.documentElement).appendChild(box);
      setTimeout(function () { s.opacity = "0"; }, 1200);
      setTimeout(function () { box.remove(); }, 1500);
    } catch (e) { /* cosmetic */ }
  }

  // Scrolls the element into view and gives its centre in viewport px.
  function locate(a) {
    var el = find(a.ref);
    if (!el) return { error: "element " + a.ref + " is gone: take a new browser_snapshot" };
    try { el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" }); } catch (e) { el.scrollIntoView(); }
    var rect = el.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0 || !visible(el)) return { error: "element " + a.ref + " is not visible: take a new browser_snapshot" };
    var x = Math.min(Math.max(rect.left + rect.width / 2, 1), innerWidth - 1);
    var y = Math.min(Math.max(rect.top + rect.height / 2, 1), innerHeight - 1);
    var top = document.elementFromPoint(x, y);
    var covered = null;
    if (top && top !== el && !el.contains(top) && !top.contains(el)) covered = describe(top);
    var out = {
      x: x, y: y, w: rect.width, h: rect.height,
      pageX: rect.left + scrollX, pageY: rect.top + scrollY,
      desc: describe(el), tag: el.tagName.toLowerCase(),
      type: (el.getAttribute("type") || "").toLowerCase(),
      disabled: !!el.disabled || el.getAttribute("aria-disabled") === "true",
      covered: covered
    };
    if (a.highlight) highlight({ x: rect.left, y: rect.top, w: rect.width, h: rect.height });
    return out;
  }

  function isEditable(el) {
    return el.tagName === "INPUT" || el.tagName === "TEXTAREA" || (el.isContentEditable && el.getAttribute("contenteditable") !== null);
  }

  function focusEl(a) {
    var el = find(a.ref);
    if (!el) return { error: "element " + a.ref + " is gone: take a new browser_snapshot" };
    var info = locate({ ref: a.ref, highlight: a.highlight });
    if (info.error) return info;
    if (el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password") {
      return { password: true, desc: info.desc };
    }
    if (!isEditable(el)) return { notEditable: true, desc: info.desc };
    if (el.disabled || el.readOnly) return { error: "element " + a.ref + " is disabled or read-only" };
    el.focus();
    if (a.clear) {
      if (typeof el.select === "function" && el.tagName !== "DIV") {
        try { el.select(); } catch (e) { /* some input types cannot select */ }
      } else {
        var range = document.createRange();
        range.selectNodeContents(el);
        var sel = getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
      }
    } else if (typeof el.setSelectionRange === "function") {
      try { el.setSelectionRange(el.value.length, el.value.length); } catch (e) { /* ignore */ }
    }
    return { ok: true, desc: info.desc };
  }

  function select(a) {
    var el = find(a.ref);
    if (!el) return { error: "element " + a.ref + " is gone: take a new browser_snapshot" };
    if (el.tagName !== "SELECT") return { error: "element " + a.ref + " is not a <select>" };
    var info = locate({ ref: a.ref, highlight: a.highlight });
    if (info.error) return info;
    var wanted = (a.values || []).map(String);
    var chosen = [];
    Array.prototype.forEach.call(el.options, function (o) {
      var hit = wanted.indexOf(o.value) >= 0 || wanted.indexOf(o.text.trim()) >= 0;
      if (hit && (el.multiple || chosen.length === 0)) { o.selected = true; chosen.push(o.text.trim()); }
      else if (el.multiple) o.selected = false;
    });
    if (!chosen.length) return { error: "no option of " + a.ref + " matches " + JSON.stringify(wanted) };
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { ok: true, chosen: chosen, desc: info.desc };
  }

  function scroll(a) {
    var dx = Number(a.dx) || 0;
    var dy = Number(a.dy) || 0;
    if (a.ref) {
      var el = find(a.ref);
      if (!el) return { error: "element " + a.ref + " is gone: take a new browser_snapshot" };
      if (!dx && !dy) {
        el.scrollIntoView({ block: "center", inline: "center", behavior: "instant" });
        return { ok: true, desc: describe(el) };
      }
      el.scrollBy({ left: dx, top: dy, behavior: "instant" });
      return { ok: true, desc: describe(el) };
    }
    window.scrollBy({ left: dx, top: dy, behavior: "instant" });
    var d = document.documentElement;
    return { ok: true, desc: "page", x: Math.round(scrollX), y: Math.round(scrollY), maxY: Math.round(d.scrollHeight - innerHeight) };
  }

  function check(a) {
    var found = true;
    if (a.ref) {
      var el = find(a.ref);
      found = !!el && visible(el);
    }
    if (found && a.text) {
      var body = document.body ? document.body.innerText : "";
      found = body.toLowerCase().indexOf(String(a.text).toLowerCase()) >= 0;
    }
    return { met: a.gone ? !found : found };
  }

  function active() {
    var el = document.activeElement;
    return { password: !!el && el.tagName === "INPUT" && (el.getAttribute("type") || "").toLowerCase() === "password" };
  }

  function run(op, a) {
    a = a || {};
    switch (op) {
      case "snapshot": return snapshot(a);
      case "locate": return locate(a);
      case "focus": return focusEl(a);
      case "select": return select(a);
      case "scroll": return scroll(a);
      case "check": return check(a);
      case "active": return active();
      case "begin": window.__fcAgentActing = true; return { ok: true };
      case "end": window.__fcAgentActing = false; window.__fcAgentUntil = Date.now() + 400; return { ok: true };
      case "userAt": return { at: window.__fcUserAt || 0 };
      case "ready": return { state: document.readyState, url: location.href, title: document.title };
    }
    return { error: "unknown op " + op };
  }

  return { run: run };
})();
