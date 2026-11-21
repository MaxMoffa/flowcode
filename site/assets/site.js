/* Flowcode site: shared helpers (window.FC) and page chrome. No dependencies. */
(function () {
  "use strict";
  document.documentElement.classList.remove("no-js");

  var reduced = window.matchMedia && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  /* ---------------------------------------------------------- data */

  /* Agent colours: chat/delegateStrip.ts (claude, codex, gemini, opencode); vibe and cline picked to sit with them. */
  var AGENTS = {
    claude: { id: "claude", name: "Claude Code", short: "Claude", vendor: "Anthropic", model: "Opus 5.5", color: "#d97757", cmd: "claude" },
    codex: { id: "codex", name: "Codex CLI", short: "Codex", vendor: "OpenAI", model: "GPT-5 Codex", color: "#6cc4b4", cmd: "codex" },
    gemini: { id: "gemini", name: "Gemini CLI", short: "Gemini", vendor: "Google", model: "Gemini 3 Pro", color: "#7aa2f7", cmd: "gemini" },
    vibe: { id: "vibe", name: "Mistral Vibe", short: "Vibe", vendor: "Mistral AI", model: "Devstral", color: "#ff8a3d", cmd: "vibe" },
    opencode: { id: "opencode", name: "OpenCode", short: "OpenCode", vendor: "Any model", model: "OpenRouter", color: "#c7a0e8", cmd: "opencode" },
    cline: { id: "cline", name: "Cline", short: "Cline", vendor: "Cline", model: "ClinePass", color: "#e6c15a", cmd: "cline" }
  };
  /* The agents' marks, as the app draws them (shared/agentLogos.ts). */
  var LOGOS = {
    claude: ["-3.6 -3.6 31.2 31.2", "m4.7144 15.9555 4.7174-2.6471.079-.2307-.079-.1275h-.2307l-.7893-.0486-2.6956-.0729-2.3375-.0971-2.2646-.1214-.5707-.1215-.5343-.7042.0546-.3522.4797-.3218.686.0608 1.5179.1032 2.2767.1578 1.6514.0972 2.4468.255h.3886l.0546-.1579-.1336-.0971-.1032-.0972L6.973 9.8356l-2.55-1.6879-1.3356-.9714-.7225-.4918-.3643-.4614-.1578-1.0078.6557-.7225.8803.0607.2246.0607.8925.686 1.9064 1.4754 2.4893 1.8336.3643.3035.1457-.1032.0182-.0728-.164-.2733-1.3539-2.4467-1.445-2.4893-.6435-1.032-.17-.6194c-.0607-.255-.1032-.4674-.1032-.7285L6.287.1335 6.6997 0l.9957.1336.419.3642.6192 1.4147 1.0018 2.2282 1.5543 3.0296.4553.8985.2429.8318.091.255h.1579v-.1457l.1275-1.706.2368-2.0947.2307-2.6957.0789-.7589.3764-.9107.7468-.4918.5828.2793.4797.686-.0668.4433-.2853 1.8517-.5586 2.9021-.3643 1.9429h.2125l.2429-.2429.9835-1.3053 1.6514-2.0643.7286-.8196.85-.9046.5464-.4311h1.0321l.759 1.1293-.34 1.1657-1.0625 1.3478-.8804 1.1414-1.2628 1.7-.7893 1.36.0729.1093.1882-.0183 2.8535-.607 1.5421-.2794 1.8396-.3157.8318.3886.091.3946-.3278.8075-1.967.4857-2.3072.4614-3.4364.8136-.0425.0304.0486.0607 1.5482.1457.6618.0364h1.621l3.0175.2247.7892.522.4736.6376-.079.4857-1.2142.6193-1.6393-.3886-3.825-.9107-1.3113-.3279h-.1822v.1093l1.0929 1.0686 2.0035 1.8092 2.5075 2.3314.1275.5768-.3218.4554-.34-.0486-2.2039-1.6575-.85-.7468-1.9246-1.621h-.1275v.17l.4432.6496 2.3436 3.5214.1214 1.0807-.17.3521-.6071.2125-.6679-.1214-1.3721-1.9246L14.38 17.959l-1.1414-1.9428-.1397.079-.674 7.2552-.3156.3703-.7286.2793-.6071-.4614-.3218-.7468.3218-1.4753.3886-1.9246.3157-1.53.2853-1.9004.17-.6314-.0121-.0425-.1397.0182-1.4328 1.9672-2.1796 2.9446-1.7243 1.8456-.4128.164-.7164-.3704.0667-.6618.4008-.5889 2.386-3.0357 1.4389-1.882.929-1.0868-.0062-.1579h-.0546l-6.3385 4.1164-1.1293.1457-.4857-.4554.0608-.7467.2307-.2429 1.9064-1.3114Z"],
    codex: ["-0.82 -0.73 21.65 21.45", "M11.248 18.25q-.825 0-1.568-.314a4.3 4.3 0 0 1-1.32-.874 4 4 0 0 1-1.304.214 4 4 0 0 1-2.046-.544 4.27 4.27 0 0 1-1.518-1.485 4 4 0 0 1-.56-2.095q0-.48.131-1.04A4.4 4.4 0 0 1 2.04 10.71a4.07 4.07 0 0 1 .017-3.4 4.2 4.2 0 0 1 1.056-1.418 3.8 3.8 0 0 1 1.6-.842 3.9 3.9 0 0 1 .76-1.683q.593-.759 1.451-1.188a4.04 4.04 0 0 1 1.832-.429q.825 0 1.567.313.742.314 1.32.875a4 4 0 0 1 1.304-.215q1.106 0 2.046.545a4.14 4.14 0 0 1 1.501 1.485q.578.941.578 2.095 0 .48-.132 1.04.66.61 1.023 1.419.363.792.363 1.666 0 .892-.38 1.717a4.3 4.3 0 0 1-1.072 1.435 3.8 3.8 0 0 1-1.584.825 3.8 3.8 0 0 1-.775 1.683 4.06 4.06 0 0 1-1.436 1.188 4.04 4.04 0 0 1-1.832.429m-4.076-2.062q.825 0 1.435-.347l3.103-1.782a.36.36 0 0 0 .164-.313v-1.42L7.881 14.62a.67.67 0 0 1-.726 0l-3.118-1.798a.5.5 0 0 1-.017.115v.198q0 .841.396 1.551.413.693 1.139 1.089a3.2 3.2 0 0 0 1.617.412m.165-2.69a.4.4 0 0 0 .181.05q.083 0 .165-.05l1.238-.71-3.977-2.31a.7.7 0 0 1-.363-.643v-3.58q-.825.362-1.32 1.122a2.9 2.9 0 0 0-.495 1.65q0 .809.413 1.55.412.743 1.072 1.123zm3.91 3.663q.875 0 1.585-.396a2.96 2.96 0 0 0 1.534-2.64v-3.564a.32.32 0 0 0-.165-.297l-1.254-.726v4.604a.7.7 0 0 1-.363.643l-3.119 1.799a3 3 0 0 0 1.783.577m.627-6.039V8.878L10.01 7.822 8.129 8.878v2.244l1.881 1.056zM7.057 5.859a.7.7 0 0 1 .363-.644l3.119-1.798a3 3 0 0 0-1.782-.578q-.874 0-1.584.396A2.96 2.96 0 0 0 6.05 4.324a3.07 3.07 0 0 0-.396 1.551v3.547q0 .199.165.314l1.237.726zm8.383 7.887q.825-.364 1.303-1.123.495-.758.495-1.65a3.15 3.15 0 0 0-.412-1.55q-.413-.743-1.073-1.123l-3.086-1.782q-.099-.065-.181-.049a.3.3 0 0 0-.165.05l-1.238.692 3.993 2.327a.6.6 0 0 1 .264.264.64.64 0 0 1 .1.363zm-3.317-8.382a.63.63 0 0 1 .726 0l3.135 1.831v-.297q0-.792-.396-1.501a2.86 2.86 0 0 0-1.105-1.155q-.71-.43-1.65-.43-.825 0-1.436.347L8.294 5.941a.36.36 0 0 0-.165.314v1.418z"],
    gemini: ["-3.6 -3.6 31.2 31.2", "M12 0C12.7 6.7 17.3 11.3 24 12 17.3 12.7 12.7 17.3 12 24 11.3 17.3 6.7 12.7 0 12 6.7 11.3 11.3 6.7 12 0Z"],
    opencode: ["-3.6 -3.6 31.2 31.2", "M3 0h18a3 3 0 0 1 3 3v18a3 3 0 0 1-3 3H3a3 3 0 0 1-3-3V3a3 3 0 0 1 3-3zm1 4v16h16V4zm4 4h8v8H8z"],
    cline: ["-3.6 -3.6 31.2 31.2", "M21.19 4.29A12 12 0 1 0 21.19 19.71L17.36 16.5A7 7 0 1 1 17.36 7.5Z"],
    vibe: ["-1.6 -1.6 27.2 27.2", "M2 2h4v4H2zM18 2h4v4h-4zM2 6h8v4H2zM14 6h8v4h-8zM2 10h20v4H2zM2 14h4v4H2zM10 14h4v4h-4zM18 14h4v4h-4zM2 18h4v4H2zM18 18h4v4h-4z"]
  };
  function logo(id) {
    var l = LOGOS[id];
    return l ? '<svg viewBox="' + l[0] + '" aria-hidden="true"><path d="' + l[1] + '" fill="currentColor" stroke="none"' + (id === "opencode" ? ' fill-rule="evenodd"' : "") + "/></svg>" : "";
  }
  var AGENT_ORDER = ["claude", "codex", "gemini", "vibe", "opencode", "cline"];

  /* Dark variants from src/themes/palettes.ts */
  var PALETTES = {
    flowcode: { name: "Flowcode", bg: "14 10 7", fg: "#e7d8c5", muted: "#a08a6f", accent: "#9db984", accent2: "#c9975a", red: "#e2645c", green: "#9db984", yellow: "#d1a752", blue: "#6f9bcf", magenta: "#c98fc4", cyan: "#6fc2c2" },
    ocean: { name: "Ocean", bg: "8 19 29", fg: "#d6e6f2", muted: "#7f9bb3", accent: "#5cb3ff", accent2: "#3ec9c0", red: "#ff6b6b", green: "#5fd39a", yellow: "#e6c15a", blue: "#6aa8ff", magenta: "#c792ea", cyan: "#5ad1e0" },
    ember: { name: "Ember", bg: "20 10 7", fg: "#f5dfd3", muted: "#b5806a", accent: "#ff8a4c", accent2: "#f2b24a", red: "#ff6b5e", green: "#a8cc6a", yellow: "#f2c14e", blue: "#7aa7e6", magenta: "#e08bc0", cyan: "#6cc7d6" },
    lavender: { name: "Lavender", bg: "16 12 28", fg: "#e6def8", muted: "#9a8cc0", accent: "#b499ff", accent2: "#f18ac8", red: "#ff7391", green: "#7fdcaa", yellow: "#ebc865", blue: "#86a5ff", magenta: "#d58cf5", cyan: "#6ed3e6" },
    mint: { name: "Mint", bg: "7 20 15", fg: "#d5f0e5", muted: "#7fab99", accent: "#4fe0b0", accent2: "#62b6ff", red: "#ff7268", green: "#6fe0a0", yellow: "#e6c65a", blue: "#74a8f5", magenta: "#cf95ea", cyan: "#5ae0d0" },
    nord: { name: "Nord", bg: "46 52 64", fg: "#d8dee9", muted: "#8a93a8", accent: "#88c0d0", accent2: "#d08770", red: "#bf616a", green: "#a3be8c", yellow: "#ebcb8b", blue: "#81a1c1", magenta: "#b48ead", cyan: "#8fbcbb" },
    graphite: { name: "Graphite", bg: "12 13 15", fg: "#e4e6ea", muted: "#8b919a", accent: "#b8c0cc", accent2: "#d0a86a", red: "#f0706a", green: "#7fd39a", yellow: "#e0c060", blue: "#78a8f0", magenta: "#c690e0", cyan: "#6ccbd8" },
    dracula: { name: "Dracula", bg: "40 42 54", fg: "#f8f8f2", muted: "#7b86b5", accent: "#bd93f9", accent2: "#ff79c6", red: "#ff5555", green: "#50fa7b", yellow: "#f1fa8c", blue: "#6ea8ff", magenta: "#ff79c6", cyan: "#8be9fd" }
  };

  function applyPalette(node, id) {
    var p = PALETTES[id] || PALETTES.flowcode;
    var map = { "--surface-rgb": p.bg, "--fg": p.fg, "--fg-muted": p.muted, "--accent": p.accent, "--accent-2": p.accent2, "--ansi-red": p.red, "--ansi-green": p.green, "--ansi-yellow": p.yellow, "--ansi-blue": p.blue, "--ansi-magenta": p.magenta, "--ansi-cyan": p.cyan };
    for (var k in map) node.style.setProperty(k, map[k]);
    node.dataset.palette = id;
    node.querySelectorAll("canvas[data-frog]").forEach(function (c) { drawFrog(c, { accent: p.accent, vivid: c.dataset.frog === "vivid" }); });
  }

  /* ---------------------------------------------------------- the frog
     Same geometry as src/terminal/frogArt.ts (frogPixel), drawn as a
     30 x 24 pixel grid. */

  function hexToHsl(hex) {
    var m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex.trim());
    if (!m) return null;
    var r = parseInt(m[1], 16) / 255, g = parseInt(m[2], 16) / 255, b = parseInt(m[3], 16) / 255;
    var max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    var d = max - min, s = d / (1 - Math.abs(2 * l - 1));
    var h = max === r ? ((g - b) / d + 6) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
    return [h * 60, s, l];
  }
  function hslToHex(h, s, l) {
    var c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2, rgb;
    if (h < 60) rgb = [c, x, 0]; else if (h < 120) rgb = [x, c, 0]; else if (h < 180) rgb = [0, c, x];
    else if (h < 240) rgb = [0, x, c]; else if (h < 300) rgb = [x, 0, c]; else rgb = [c, 0, x];
    return "#" + rgb.map(function (v) { return Math.round((v + m) * 255).toString(16).padStart(2, "0"); }).join("");
  }
  function frogColors(accent, vivid) {
    var hsl = hexToHsl(accent || "#9db984");
    if (!hsl) return { green: "#a3e635", dark: "#14532d", white: "#ffffff" };
    var h = hsl[0], s = hsl[1], l = hsl[2];
    if (vivid) {
      var grey = s < 0.08, ls = grey ? l : Math.min(0.65, Math.max(0.45, l));
      var ss = grey ? s : Math.min(1, s + 0.35);
      return { green: hslToHex(h, ss, ls), dark: hslToHex(h, grey ? s : Math.min(1, s + 0.2), Math.max(0.1, ls * 0.3)), white: "#ffffff" };
    }
    return { green: hslToHex(h, s, l), dark: hslToHex(h, s, Math.max(0.1, l * 0.35)), white: "#ebebeb" };
  }
  var BOX = { x: 130, y: 205, w: 764, h: 650 };
  function frogPixel(x, y, pose, pal) {
    var lookX = pose.lookX || 0, lookY = pose.lookY == null ? 6 : pose.lookY, lid = pose.lid || 0;
    var dy = y - (pose.lift || 0);
    y = 830 + (dy - 830);
    var eyes = [340, 684];
    for (var i = 0; i < 2; i++) {
      var cx = eyes[i];
      if (lid > 0 && Math.hypot(x - cx, y - 393) <= 89 && y <= 304 + 178 * lid) return pal.green;
      if (Math.hypot(x - (cx + 14 + lookX), y - 378 - lookY) <= 16) return pal.white;
      if (Math.hypot(x - (cx + lookX), y - 393 - lookY) <= 45) return pal.dark;
      if (Math.hypot(x - cx, y - 393) <= 85) return pal.white;
    }
    var strokes = [[396, 575, 472, 632], [472, 632, 396, 689]];
    if (pose.cursor !== false) strokes.push([526, 689, 636, 689]);
    for (var k = 0; k < strokes.length; k++) {
      var a = strokes[k], sx = a[2] - a[0], sy = a[3] - a[1];
      var t = Math.max(0, Math.min(1, ((x - a[0]) * sx + (y - a[1]) * sy) / (sx * sx + sy * sy)));
      if (Math.hypot(x - (a[0] + t * sx), y - (a[1] + t * sy)) <= 24) return pal.dark;
    }
    var body = Math.hypot(x - 340, y - 400) <= 135 || Math.hypot(x - 684, y - 400) <= 135 ||
      Math.pow((x - 512) / 360, 2) + Math.pow((y - 610) / 220, 2) <= 1;
    return body ? pal.green : null;
  }
  function drawFrog(canvas, opts) {
    opts = opts || {};
    var W = 30, H = 24;
    if (canvas.width !== W) { canvas.width = W; canvas.height = H; }
    var ctx = canvas.getContext("2d");
    var accent = opts.accent || canvas.dataset.accent || "#9db984";
    var pal = frogColors(accent, opts.vivid != null ? opts.vivid : canvas.dataset.frog === "vivid");
    ctx.clearRect(0, 0, W, H);
    for (var r = 0; r < H; r++) {
      var y = BOX.y + ((r + 0.5) * BOX.h) / H;
      for (var c = 0; c < W; c++) {
        var col = frogPixel(BOX.x + ((c + 0.5) * BOX.w) / W, y, opts, pal);
        if (col) { ctx.fillStyle = col; ctx.fillRect(c, r, 1, 1); }
      }
    }
  }
  /* A frog that blinks and glances now and then. */
  function liveFrog(canvas, accentFn) {
    var pose = { lookX: 0, lookY: 6, lid: 0, cursor: true };
    function paint() { pose.accent = accentFn ? accentFn() : undefined; drawFrog(canvas, pose); }
    paint();
    if (reduced) return paint;
    var t = 0;
    setInterval(function () {
      if (!canvas.isConnected || document.hidden) return;
      t++;
      pose.cursor = t % 2 === 0;
      if (t % 7 === 0) { pose.lid = 1; paint(); setTimeout(function () { pose.lid = 0; paint(); }, 140); return; }
      if (t % 11 === 0) pose.lookX = [-22, 22, 0][Math.floor(Math.random() * 3)];
      paint();
    }, 600);
    return paint;
  }

  /* ---------------------------------------------------------- dom helpers */

  function el(tag, attrs, kids) {
    var n = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === "class") n.className = attrs[k];
      else if (k === "text") n.textContent = attrs[k];
      else if (k === "html") n.innerHTML = attrs[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] != null && attrs[k] !== false) n.setAttribute(k, attrs[k]);
    }
    if (kids) (Array.isArray(kids) ? kids : [kids]).forEach(function (c) { if (c != null) n.append(c); });
    return n;
  }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]; }); }
  function sleep(ms) { return new Promise(function (r) { setTimeout(r, reduced ? Math.min(ms, 30) : ms); }); }

  /* Streams an HTML string into `node` word by word, keeping tags whole. */
  function stream(node, html, opts) {
    opts = opts || {};
    var parts = html.match(/<[^>]+>|[^<\s]+\s*|\s+/g) || [];
    if (reduced) { node.innerHTML = html; return Promise.resolve(); }
    var out = "", i = 0, speed = opts.speed || 22;
    node.classList.add("fc-cursor");
    return new Promise(function (res) {
      (function step() {
        if (!node.isConnected) return res();
        var n = 0;
        while (i < parts.length && n < 2) { out += parts[i]; if (parts[i][0] !== "<") n++; i++; }
        node.innerHTML = out;
        if (opts.onStep) opts.onStep();
        if (i < parts.length) setTimeout(step, speed + Math.random() * speed);
        else { node.classList.remove("fc-cursor"); res(); }
      })();
    });
  }

  /* Runs fn once when node scrolls into view. */
  function onVisible(node, fn, margin) {
    if (!("IntersectionObserver" in window)) return fn();
    var io = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { io.disconnect(); fn(); } });
    }, { rootMargin: margin || "0px 0px -15% 0px" });
    io.observe(node);
  }

  window.FC = {
    reduced: reduced, AGENTS: AGENTS, logo: logo, AGENT_ORDER: AGENT_ORDER, PALETTES: PALETTES,
    applyPalette: applyPalette, drawFrog: drawFrog, liveFrog: liveFrog,
    el: el, esc: esc, sleep: sleep, stream: stream, onVisible: onVisible
  };

  /* ---------------------------------------------------------- nav */

  var nav = document.querySelector(".nav");
  var menuBtn = document.querySelector(".nav-menu");
  if (nav) {
    var onScroll = function () { nav.classList.toggle("is-scrolled", window.scrollY > 8); };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
  }
  if (nav && menuBtn) {
    var setOpen = function (open) {
      nav.classList.toggle("is-open", open);
      document.documentElement.style.overflow = open ? "hidden" : "";
      menuBtn.setAttribute("aria-expanded", String(open));
      menuBtn.setAttribute("aria-label", open ? "Close menu" : "Open menu");
    };
    menuBtn.addEventListener("click", function () { setOpen(menuBtn.getAttribute("aria-expanded") !== "true"); });
    document.addEventListener("keydown", function (e) { if (e.key === "Escape" && nav.classList.contains("is-open")) { setOpen(false); menuBtn.focus(); } });
    document.querySelectorAll("#site-nav a").forEach(function (a) { a.addEventListener("click", function () { setOpen(false); }); });
    window.addEventListener("resize", function () { if (window.innerWidth > 860) setOpen(false); });
  }

  /* ---------------------------------------------------------- OS highlight */

  var ua = navigator.userAgent;
  var os = /Android/i.test(ua) ? "android" : /Mac|iPhone|iPad/i.test(ua) ? "mac" : /Linux|X11/i.test(ua) ? "linux" : "win";
  var osNames = { win: "Windows", mac: "macOS", linux: "Linux", android: "Android" };
  document.querySelectorAll("[data-os]").forEach(function (n) { if (n.dataset.os === os) n.classList.add("mine"); });
  document.querySelectorAll(".os-name").forEach(function (n) { n.textContent = osNames[os]; });

  /* ---------------------------------------------------------- latest release
     The only external request: GitHub's releases API. Static text stays on failure. */

  var latest = document.querySelectorAll("[data-latest]");
  if (latest.length && window.fetch) {
    fetch("https://api.github.com/repos/MaxMoffa/flowcode/releases/latest", { headers: { Accept: "application/vnd.github+json" } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (d) {
        if (d && typeof d.tag_name === "string" && /^v?[\w.\-]{1,20}$/.test(d.tag_name)) {
          latest.forEach(function (n) { n.textContent = n.dataset.latest.replace("%v", d.tag_name); });
        }
      })
      .catch(function () {});
  }

  /* ---------------------------------------------------------- reveal + frogs */

  var reveals = document.querySelectorAll(".reveal");
  if (reduced || !("IntersectionObserver" in window)) reveals.forEach(function (n) { n.classList.add("is-in"); });
  else {
    var rio = new IntersectionObserver(function (es) {
      es.forEach(function (e) { if (e.isIntersecting) { e.target.classList.add("is-in"); rio.unobserve(e.target); } });
    }, { rootMargin: "0px 0px -8% 0px" });
    reveals.forEach(function (n) { rio.observe(n); });
  }
  document.querySelectorAll("canvas[data-frog]:not([data-live])").forEach(function (c) { drawFrog(c); });
  document.querySelectorAll("canvas[data-frog][data-live]").forEach(function (c) { liveFrog(c); });
})();
