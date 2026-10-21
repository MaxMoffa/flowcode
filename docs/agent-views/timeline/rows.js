// The timeline's content as plain data: the chat model in, the rows to draw
// out. No DOM here, so it can be tested on its own; view.js turns it into HTML.
// A classic script (a view's page can't load modules): it adds `TimelineRows`
// to the global scope and reads `FlowcodeView` from flowcode-view.iife.js.
(function () {
  const DIFF_MAX_ROWS = 24;

  /** The icon family of a tool call: what the agent is doing, in five buckets. */
  const TOOL_ICONS = { read: "read", search: "search", fetch: "search", edit: "edit", delete: "edit", move: "edit", execute: "execute" };

  /** "HH:MM" in the viewer's time zone. */
  function formatClock(at) {
    const date = new Date(at);
    return String(date.getHours()).padStart(2, "0") + ":" + String(date.getMinutes()).padStart(2, "0");
  }

  /** "0.4s", "3.2s", "1m 05s"; null under 100 ms, where it's noise. */
  function formatDuration(ms) {
    if (!(ms >= 100)) return null;
    if (ms < 10000) return (ms / 1000).toFixed(1) + "s";
    const seconds = Math.round(ms / 1000);
    if (seconds < 60) return seconds + "s";
    return Math.floor(seconds / 60) + "m " + String(seconds % 60).padStart(2, "0") + "s";
  }

  /** An edit's diffs, reduced to their changed lines. */
  function diffsOf(call) {
    const diffs = [];
    for (const content of call.content ?? []) {
      if (content.type !== "diff") continue;
      const changed = FlowcodeView.lineDiff(content.oldText, content.newText).filter((row) => row.type !== "ctx");
      diffs.push({
        path: content.path,
        added: changed.filter((row) => row.type === "add").length,
        removed: changed.filter((row) => row.type === "del").length,
        rows: changed.slice(0, DIFF_MAX_ROWS),
        hidden: Math.max(0, changed.length - DIFF_MAX_ROWS),
      });
    }
    return diffs;
  }

  /** The files a tool call touched: its locations, else the paths of its diffs. */
  function filesOf(call, diffs) {
    const files = (call.locations ?? []).map((location) => ({ path: location.path, line: location.line ?? null }));
    for (const diff of diffs) if (!files.some((file) => file.path === diff.path)) files.push({ path: diff.path, line: null });
    return files;
  }

  function toolRow(item, timing) {
    const call = item.call;
    const diffs = diffsOf(call);
    const status = call.status ?? "pending";
    const done = status === "completed" || status === "failed";
    return {
      kind: "tool",
      id: item.id,
      at: timing?.start ?? null,
      icon: TOOL_ICONS[call.kind] ?? "other",
      title: call.title ?? "",
      status,
      duration: done && timing ? formatDuration(timing.end - timing.start) : null,
      files: filesOf(call, diffs),
      diffs,
    };
  }

  /**
   * @param model the chat model (ChatModelState)
   * @param timing item id -> { start, end } (ViewClient.timing)
   * @param showThoughts whether the agent's reasoning gets rows
   * @returns the pinned plan (or null) and the rows, oldest first
   */
  function buildTimeline(model, timing, showThoughts = false) {
    const plan = model.plan?.length
      ? { entries: model.plan, done: model.plan.filter((entry) => entry.status === "completed").length, total: model.plan.length }
      : null;
    const rows = [];
    for (const item of model.items) {
      const at = timing.get(item.id)?.start ?? null;
      switch (item.type) {
        case "user":
        case "agent":
          rows.push({ kind: item.type, id: item.id, at, text: item.text });
          break;
        case "thought":
          if (showThoughts) rows.push({ kind: "thought", id: item.id, at, text: item.text });
          break;
        case "tool":
          rows.push(toolRow(item, timing.get(item.id)));
          break;
        case "permission":
          rows.push({ kind: "permission", id: item.id, at, title: item.toolCall.title ?? "", pending: item.resolved === undefined });
          break;
        case "error":
          rows.push({ kind: "error", id: item.id, at, text: item.message });
          break;
      }
    }
    // A run of rows in the same minute shows the time once, on the first.
    let shown = "";
    for (const row of rows) {
      const clock = row.at ? formatClock(row.at) : "";
      row.showTime = clock !== "" && clock !== shown;
      if (clock) shown = clock;
    }
    return { plan, thoughts: model.items.some((item) => item.type === "thought"), rows };
  }

  self.TimelineRows = { formatClock: formatClock, formatDuration: formatDuration, buildTimeline: buildTimeline };
})();
