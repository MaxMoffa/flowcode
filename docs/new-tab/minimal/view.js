// A minimal Flowcode new tab page, written against bridge protocol v1 with no
// library: handshake, then everything goes over the MessagePort the host hands us.
(function () {
  var API_VERSION = 1;
  var port = null;

  var TEXT = {
    it: { title: "Cosa vuoi aprire?", favorites: "Preferiti", recents: "Recenti", shells: "Nuovo terminale", empty: "Niente qui per ora.", customize: "Personalizza" },
    en: { title: "What do you want to open?", favorites: "Favorites", recents: "Recent", shells: "New terminal", empty: "Nothing here yet.", customize: "Customize" },
  };
  var text = TEXT.en;

  function applyTheme(theme) {
    for (var name in theme.tokens) document.documentElement.style.setProperty(name, theme.tokens[name]);
  }

  // Fills a list with one button per entry. Clicking asks the host to start the
  // entry: the page only names it by id, the host decides what that means.
  function fill(listId, entries, kind, detail) {
    var list = document.getElementById(listId);
    list.textContent = "";
    if (entries.length === 0) {
      var empty = document.createElement("li");
      empty.className = "empty";
      empty.textContent = text.empty;
      list.appendChild(empty);
      return;
    }
    entries.forEach(function (entry) {
      var item = document.createElement("li");
      var button = document.createElement("button");
      button.type = "button";
      var label = document.createElement("span");
      label.textContent = entry.label;
      button.appendChild(label);
      var path = detail(entry);
      if (path) {
        var extra = document.createElement("span");
        extra.className = "path";
        extra.textContent = path;
        button.appendChild(extra);
      }
      button.addEventListener("click", function () {
        port.postMessage({ type: "launch", kind: kind, id: entry.id });
      });
      item.appendChild(button);
      list.appendChild(item);
    });
  }

  function render(data) {
    fill("favorites", data.favorites, "favorite", function (f) { return f.path; });
    fill("recents", data.recents, "recent", function (r) { return r.path; });
    fill("shells", data.shells, "shell", function () { return ""; });
  }

  function setLocale(locale) {
    text = TEXT[locale] || TEXT.en;
    document.getElementById("title").textContent = text.title;
    document.getElementById("favorites-title").textContent = text.favorites;
    document.getElementById("recents-title").textContent = text.recents;
    document.getElementById("shells-title").textContent = text.shells;
    document.getElementById("customize").textContent = text.customize;
  }

  function onMessage(e) {
    var msg = e.data;
    switch (msg.type) {
      case "init":
        setLocale(msg.locale);
        applyTheme(msg.theme);
        render(msg.data);
        break;
      case "data":
        render(msg.data);
        break;
      case "theme":
        applyTheme(msg.theme);
        break;
    }
  }

  document.getElementById("customize").addEventListener("click", function () {
    // Opens Flowcode's own "Personalizza" panel, drawn outside this page.
    if (port) port.postMessage({ type: "customize" });
  });

  window.addEventListener("message", function (e) {
    if (!e.data || e.data.type !== "flowcode:connect" || e.data.apiVersion !== API_VERSION || !e.ports[0]) return;
    port = e.ports[0];
    port.onmessage = onMessage;
  });

  window.parent.postMessage({ type: "flowcode:hello", apiVersion: API_VERSION }, "*");
})();
