/**
 * Soft-keyboard input for xterm on Android.
 *
 * xterm's own IME handling assumes the keyboard only ever appends at the end
 * of its hidden textarea. Samsung Keyboard and Gboard (predictions on) re-compose
 * words already typed, swap them for corrections and suggestions, and keep the
 * whole line as context: xterm then sends stale slices of the textarea, or all
 * of it again, and the shell receives duplicated text.
 *
 * Here the textarea is the only source of truth: every change is diffed
 * against what was already sent (backspaces for the replaced tail, then the
 * new text). The textarea keeps the whole line the user typed, so a correction
 * of an earlier word always finds that word where the keyboard expects it; it
 * is emptied only where the line ends (Enter or another real key, a key from
 * the key bar, focus change). Emptying it while the keyboard still remembers
 * the line made autocorrect act on text that was gone.
 * xterm never sees the composition or input events; real key presses (Enter,
 * Backspace on an empty field, hardware keys) still go through it.
 */
export function attachImeInput(
  host: HTMLElement,
  ta: HTMLTextAreaElement,
  send: (data: string) => void,
): { detach: () => void; reset: () => void } {
  /** Textarea content already sent to the shell. */
  let sent = "";
  let composing = false;
  let resyncTimer = 0;
  let flushTimer = 0;

  const flush = () => {
    const prev = Array.from(sent);
    const cur = Array.from(ta.value);
    let i = 0;
    while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
    const out = "\x7f".repeat(prev.length - i) + cur.slice(i).join("").replace(/\r?\n/g, "\r");
    sent = ta.value;
    if (out) send(out);
  };
  const clear = () => {
    if (ta.value === "" && sent === "") return;
    ta.value = "";
    sent = "";
  };
  /** The line ends: send what is pending and start the next one empty. */
  const reset = () => {
    window.clearTimeout(flushTimer);
    flush();
    composing = false;
    clear();
  };
  const update = () => {
    flush();
    // A keyboard that types Enter as a line break rather than a key press.
    if (!composing && ta.value.includes("\n")) clear();
  };

  const onCompositionStart = (e: Event) => {
    if (e.target !== ta) return;
    e.stopPropagation();
    composing = true;
  };
  const onCompositionUpdate = (e: Event) => {
    if (e.target !== ta) return;
    e.stopPropagation();
  };
  const onCompositionEnd = (e: Event) => {
    if (e.target !== ta) return;
    e.stopPropagation();
    composing = false;
    // The committed text lands in the textarea after this event.
    window.clearTimeout(flushTimer);
    flushTimer = window.setTimeout(update, 0);
  };
  const onInput = (e: Event) => {
    if (e.target !== ta) return;
    e.stopPropagation();
    if ((e as InputEvent).isComposing) composing = true;
    update();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.target !== ta) return;
    // 229: the keyboard is editing the textarea; the input event carries the change.
    // Backspace with text in the field: the textarea deletes it and the diff sends it.
    if (e.keyCode === 229 || (e.keyCode === 8 && ta.value !== "")) {
      e.stopPropagation();
      return;
    }
    // A real key (Enter...): send what was typed before it, and pick up xterm clearing the field.
    flush();
    window.clearTimeout(resyncTimer);
    resyncTimer = window.setTimeout(() => {
      if (!composing) clear();
      else sent = ta.value;
    }, 0);
  };
  // xterm empties the textarea on blur.
  const onFocusChange = (e: Event) => {
    if (e.target !== ta) return;
    composing = false;
    window.clearTimeout(flushTimer);
    clear();
  };

  const listeners: [string, (e: never) => void][] = [
    ["compositionstart", onCompositionStart],
    ["compositionupdate", onCompositionUpdate],
    ["compositionend", onCompositionEnd],
    ["input", onInput],
    ["keydown", onKeyDown],
    ["focusin", onFocusChange],
    ["focusout", onFocusChange],
  ];
  // Capture on an ancestor runs before xterm's own listeners on the textarea.
  listeners.forEach(([n, fn]) => host.addEventListener(n, fn as EventListener, true));
  return {
    reset,
    detach: () => {
      window.clearTimeout(resyncTimer);
      window.clearTimeout(flushTimer);
      listeners.forEach(([n, fn]) => host.removeEventListener(n, fn as EventListener, true));
    },
  };
}
