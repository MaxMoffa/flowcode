// A minimal Flowcode agent view, written against bridge protocol v1 with no
// library: handshake, then everything goes over the MessagePort the host hands us.
(function () {
  var API_VERSION = 1;
  var port = null;
  // The conversation as the events describe it: plain text, in order.
  var items = [];
  var lastSeq = -1;

  var log = document.getElementById("log");
  var statusEl = document.getElementById("status");
  var text = document.getElementById("text");

  function applyTheme(theme) {
    for (var name in theme.tokens) document.documentElement.style.setProperty(name, theme.tokens[name]);
  }

  function render() {
    log.textContent = "";
    items.forEach(function (item) {
      var p = document.createElement("p");
      p.className = "msg" + (item.role === "user" ? " user" : "");
      p.textContent = item.text;
      log.appendChild(p);
    });
    log.scrollTop = log.scrollHeight;
  }

  function applyEvent(ev) {
    if (ev.seq <= lastSeq) return;
    lastSeq = ev.seq;
    var last = items[items.length - 1];
    if (ev.kind === "user") {
      items.push({ role: "user", text: ev.text });
    } else if (ev.kind === "update" && ev.update.sessionUpdate === "agent_message_chunk") {
      var chunk = ev.update.content && ev.update.content.type === "text" ? ev.update.content.text : "";
      if (last && last.role === "agent") last.text += chunk;
      else items.push({ role: "agent", text: chunk });
    } else if (ev.kind === "turnEnd") {
      // The turn is over: the next chunk starts a new message.
      if (last && last.role === "agent") last.role = "agent-done";
    }
  }

  function onMessage(e) {
    var msg = e.data;
    switch (msg.type) {
      case "init":
        // A new init is a new conversation.
        items = [];
        lastSeq = -1;
        applyTheme(msg.theme);
        render();
        break;
      case "events":
        msg.events.forEach(applyEvent);
        render();
        break;
      case "status":
        statusEl.textContent = msg.status + (msg.queued.length ? " (" + msg.queued.length + " in coda)" : "");
        break;
      case "theme":
        applyTheme(msg.theme);
        break;
      case "error":
        statusEl.textContent = "Rifiutato: " + msg.request + " (" + msg.code + ")";
        break;
    }
  }

  window.addEventListener("message", function (e) {
    if (e.source !== window.parent || !e.data || e.data.type !== "flowcode:connect" || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = onMessage;
  });

  function send() {
    var value = text.value.trim();
    if (!value || !port) return;
    port.postMessage({ type: "send", text: value });
    text.value = "";
  }

  document.getElementById("send").addEventListener("click", send);
  document.getElementById("cancel").addEventListener("click", function () {
    if (port) port.postMessage({ type: "cancel" });
  });
  text.addEventListener("keydown", function (e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  });

  window.parent.postMessage({ type: "flowcode:hello", apiVersion: API_VERSION }, "*");
})();
