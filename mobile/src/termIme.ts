/** How long the keyboard must stay quiet before the textarea is emptied. */
const RESET_IDLE_MS = 400;

/**
 * Soft-keyboard input for xterm on Android.
 *
 * xterm's own IME handling assumes the keyboard only ever appends at the end
 * of its hidden textarea. Samsung Keyboard (and others with predictions on)
 * re-composes words already typed, swaps them for corrections and suggestions,
 * and keeps the whole line as context: xterm then sends stale slices of the
 * textarea, or all of it again, and the shell receives duplicated text.
 *
 * Here the textarea is the only source of truth: every change is diffed
 * against what was already sent (backspaces for the replaced tail, then the
 * new text), and once the keyboard goes quiet the textarea is emptied so
 * it has no old words to re-compose. xterm never sees the
 * composition or input events; real key presses (Enter, Backspace on an empty
 * field, hardware keys) still go through it.
 */
export function attachImeInput(host: HTMLElement, ta: HTMLTextAreaElement, send: (data: string) => void): () => void {
  /** Textarea content already sent to the shell. */
  let sent = "";
  let composing = false;
  let resyncTimer = 0;
  let resetTimer = 0;

  const flush = () => {
    const prev = Array.from(sent);
    const cur = Array.from(ta.value);
    let i = 0;
    while (i < prev.length && i < cur.length && prev[i] === cur[i]) i++;
    const out = "\x7f".repeat(prev.length - i) + cur.slice(i).join("").replace(/\r?\n/g, "\r");
    sent = ta.value;
    if (out) send(out);
  };
  const reset = () => {
    ta.value = "";
    sent = "";
  };
  // Emptying the field mid-edit races the keyboard: tapping a suggestion is
  // several IME operations (end the composition, drop the typed part, commit
  // the word...) arriving as separate tasks, and one landing after the reset
  // re-sends the whole word. Until then the diff handles any edit.
  const settle = () => {
    flush();
    window.clearTimeout(resetTimer);
    if (composing) return;
    resetTimer = window.setTimeout(() => {
      if (composing) return;
      flush();
      reset();
    }, RESET_IDLE_MS);
  };

  const onCompositionStart = (e: Event) => {
    if (e.target !== ta) return;
    e.stopPropagation();
    window.clearTimeout(resetTimer);
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
    window.setTimeout(settle, 0);
  };
  const onInput = (e: Event) => {
    if (e.target !== ta) return;
    e.stopPropagation();
    if ((e as InputEvent).isComposing) composing = true;
    settle();
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
      if (!composing) reset();
      else sent = ta.value;
    }, 0);
  };
  // xterm empties the textarea on blur.
  const onFocusChange = (e: Event) => {
    if (e.target !== ta) return;
    composing = false;
    window.clearTimeout(resetTimer);
    reset();
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
  return () => {
    window.clearTimeout(resyncTimer);
    window.clearTimeout(resetTimer);
    listeners.forEach(([n, fn]) => host.removeEventListener(n, fn as EventListener, true));
  };
}
