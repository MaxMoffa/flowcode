// Host page of the browser panel (see preview.rs): frames the real page on
// behalf of the app, and only obeys its direct parent.
(function () {
  var ALLOWED = ["http://", "https://", "flowcode-preview://"];
  var frame = null;
  var current = null;

  function clear() {
    if (frame) {
      frame.remove();
      frame = null;
    }
  }

  function load(url, sandbox) {
    clear();
    current = { url: url, sandbox: sandbox };
    var f = document.createElement("iframe");
    f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:white";
    // The sandbox has to be in place before the first navigation.
    f.setAttribute("sandbox", sandbox);
    f.setAttribute("allow", "clipboard-write; fullscreen");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.addEventListener("load", function () {
      window.parent.postMessage({ type: "loaded" }, "*");
    });
    f.src = url;
    document.body.appendChild(f);
    frame = f;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (msg.type === "load") {
      if (typeof msg.url !== "string" || typeof msg.sandbox !== "string") return;
      if (!ALLOWED.some(function (p) { return msg.url.indexOf(p) === 0; })) return;
      load(msg.url, msg.sandbox);
    } else if (msg.type === "reload") {
      if (current) load(current.url, current.sandbox);
    } else if (msg.type === "clear") {
      clear();
      current = null;
    }
  });

  window.parent.postMessage({ type: "ready" }, "*");
})();
