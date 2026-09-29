import type { ReactElement } from "react";

export function iconSvg(children: ReactElement) {
  return (
    // Explicit size, not just viewBox: an inline <svg> with no width/height
    // of its own falls back to the browser's default replaced-element size
    // (300x150) wherever the container doesn't happen to set one via CSS -
    // which is exactly what made the search icon balloon relative to its
    // neighbors (kebab has its own width/height set directly, so it was
    // never affected). This is a default, not an override - any container
    // with its own `svg { width; height }` rule still wins over this.
    <svg
      viewBox="0 0 24 24"
      width="15"
      height="15"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      fill="none"
      stroke="currentColor"
    >
      {children}
    </svg>
  );
}

/** Icons for context menu rows outside the file explorer (which keeps its own
 * set next to its menus) - same 15px stroke style, so every menu reads alike. */
export const MenuIcons = {
  rename: iconSvg(<path d="M16.5 3.5 20.5 7.5 8 20 3.5 20.5 4 16z" />),
  duplicate: iconSvg(
    <>
      <rect x="8.5" y="8.5" width="11" height="11" rx="1.6" />
      <path d="M15.5 8.5V5.6A1.6 1.6 0 0 0 13.9 4H5.6A1.6 1.6 0 0 0 4 5.6v8.3A1.6 1.6 0 0 0 5.6 15.5H8.5" />
    </>,
  ),
  close: iconSvg(
    <>
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="18" y1="6" x2="6" y2="18" />
    </>,
  ),
  bell: iconSvg(
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
    </>,
  ),
  bellOff: iconSvg(
    <>
      <path d="M6 16.5V11a6 6 0 0 1 12 0v5.5l1.5 1.5h-15z" />
      <path d="M10 20.5a2 2 0 0 0 4 0" />
      <line x1="4" y1="4" x2="20" y2="20" />
    </>,
  ),
  cut: iconSvg(
    <>
      <circle cx="6" cy="6.5" r="2.5" />
      <circle cx="6" cy="17.5" r="2.5" />
      <path d="M8 8 20 18M8 16 20 6" />
    </>,
  ),
  paste: iconSvg(
    <>
      <rect x="6" y="4.5" width="12" height="16" rx="1.6" />
      <rect x="9" y="3" width="6" height="3.4" rx="1" />
    </>,
  ),
  selectAll: iconSvg(
    <>
      <rect x="4" y="4" width="16" height="16" rx="2" strokeDasharray="3 2.6" />
      <path d="m9 12.3 2.2 2.2L15.5 10" />
    </>,
  ),
  clear: iconSvg(
    <>
      <path d="M8 20 4.5 16.5a1.5 1.5 0 0 1 0-2.1L14 4.9a1.5 1.5 0 0 1 2.1 0l3 3a1.5 1.5 0 0 1 0 2.1L11 18.5" />
      <path d="M8 20h11" />
      <path d="m8.5 9.5 6 6" />
    </>,
  ),
  openExternal: iconSvg(
    <>
      <path d="M14 4.5h5.5V10" />
      <path d="M19.5 4.5 11 13" />
      <path d="M17.5 14v4a1.5 1.5 0 0 1-1.5 1.5H6A1.5 1.5 0 0 1 4.5 18V8A1.5 1.5 0 0 1 6 6.5h4" />
    </>,
  ),
  checkCircle: iconSvg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="m8.5 12.3 2.4 2.4 4.6-4.9" />
    </>,
  ),
  link: iconSvg(
    <>
      <path d="M9.5 14.5 14.5 9.5" />
      <path d="M11 7.5 13 5.5a3 3 0 0 1 4.24 4.24l-2 2" />
      <path d="M13 16.5 11 18.5a3 3 0 0 1-4.24-4.24l2-2" />
    </>,
  ),
  globe: iconSvg(
    <>
      <circle cx="12" cy="12" r="8.5" />
      <path d="M3.5 12h17" />
      <path d="M12 3.5c2.5 2.5 3.5 5.5 3.5 8.5s-1 6-3.5 8.5c-2.5-2.5-3.5-5.5-3.5-8.5s1-6 3.5-8.5z" />
    </>,
  ),
  trash: iconSvg(
    <>
      <path d="M5 7.5h14" />
      <path d="M9.5 7.5V5.6c0-.6.4-1 1-1h3c.6 0 1 .4 1 1v1.9" />
      <path d="M7 7.5 7.7 19a1.3 1.3 0 0 0 1.3 1.3h6a1.3 1.3 0 0 0 1.3-1.3l.7-11.5" />
    </>,
  ),
  /** Side panel modes: adapts to the window, fixed beside the terminal, floating over it. */
  sidebarAuto: iconSvg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
      <path d="M12.5 12h5M15.5 9.5l2.5 2.5-2.5 2.5" />
    </>,
  ),
  sidebarDocked: iconSvg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <line x1="9.5" y1="4.5" x2="9.5" y2="19.5" />
    </>,
  ),
  sidebarFloating: iconSvg(
    <>
      <rect x="3.5" y="4.5" width="17" height="15" rx="2.5" />
      <rect x="6" y="7" width="5" height="10" rx="1.4" />
    </>,
  ),
};
