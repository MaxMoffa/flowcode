import { useEffect, useState } from "react";
import { compactChatViewport } from "./compactChat";

/** Layout viewport only: opening the soft keyboard must not switch chat layouts. */
export function useCompactChat(): boolean {
  const read = () => compactChatViewport(window.innerWidth, window.innerHeight, window.screen.width, window.screen.height);
  const [compact, setCompact] = useState(read);
  useEffect(() => {
    const sync = () => {
      const focused = document.activeElement;
      if (focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement || (focused instanceof HTMLElement && focused.isContentEditable)) return;
      setCompact(read());
    };
    const onBlur = () => { requestAnimationFrame(sync); };
    window.addEventListener("resize", sync);
    window.addEventListener("orientationchange", sync);
    document.addEventListener("focusout", onBlur);
    return () => {
      window.removeEventListener("resize", sync);
      window.removeEventListener("orientationchange", sync);
      document.removeEventListener("focusout", onBlur);
    };
  }, []);
  return compact;
}
