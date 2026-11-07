// Host page of the browser panel (see preview.rs): frames the real page on
// behalf of the app, and only obeys its direct parent.
(function () {
  var ALLOWED = ["http://", "https://", "flowcode-preview://"];
  var frame = null;
  var current = null;
  var sequence = 0;

  function clear() {
    if (frame) {
      frame.remove();
      frame = null;
    }
  }

  function load(url, sandbox, loadSequence) {
    clear();
    current = { url: url, sandbox: sandbox };
    var f = document.createElement("iframe");
    f.style.cssText = "position:fixed;inset:0;width:100%;height:100%;border:0;background:white";
    // The sandbox has to be in place before the first navigation.
    f.setAttribute("sandbox", sandbox);
    f.setAttribute("allow", "clipboard-write; fullscreen");
    f.setAttribute("referrerpolicy", "no-referrer");
    f.addEventListener("load", function () {
      if (frame !== f || sequence !== loadSequence) return;
      window.parent.postMessage({ type: "loaded", sequence: loadSequence }, "*");
    });
    f.src = url;
    document.body.appendChild(f);
    frame = f;
  }

  window.addEventListener("message", function (event) {
    if (event.source !== window.parent) return;
    var msg = event.data;
    if (!msg || typeof msg !== "object") return;
    if (!Number.isSafeInteger(msg.sequence) || msg.sequence <= sequence) return;
    if (msg.type === "load") {
      if (typeof msg.url !== "string" || typeof msg.sandbox !== "string") return;
      if (!ALLOWED.some(function (p) { return msg.url.indexOf(p) === 0; })) return;
      sequence = msg.sequence;
      load(msg.url, msg.sandbox, sequence);
    } else if (msg.type === "reload") {
      sequence = msg.sequence;
      if (current) load(current.url, current.sandbox, sequence);
    } else if (msg.type === "clear") {
      sequence = msg.sequence;
      clear();
      current = null;
    }
  });

  window.parent.postMessage({ type: "ready" }, "*");
})();
