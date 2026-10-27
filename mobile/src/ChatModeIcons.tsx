import { Svg } from "./icons";
import type { ModeKind } from "./chatModeDefaults";

/** One icon per mode family; stroke icons like the rest of icons.tsx. */
export function ModeIcon({ kind, size = 18 }: { kind: ModeKind; size?: number }) {
  switch (kind) {
    case "ask":
      return (
        <Svg size={size}>
          <path d="M8 12V5.5a1.5 1.5 0 0 1 3 0V11M11 10V4.5a1.5 1.5 0 0 1 3 0V11M14 10V6a1.5 1.5 0 0 1 3 0v6M8 12l-1.8-2.2a1.500 1.500 0 0 0-2.400 1.800L7 17a6 6 0 0 0 5 3h1.500a4.500 4.500 0 0 0 4.500-4.500V12" />
        </Svg>
      );
    case "edit":
      return (
        <Svg size={size}>
          <path d="M4 20l1-4L16 5a2.1 2.1 0 0 1 3 3L8 19z" />
          <path d="m14 7 3 3M13 20l2 2 5-5" />
        </Svg>
      );
    case "plan":
      return (
        <Svg size={size}>
          <path d="M9 4 3.5 6v14L9 18l6 2 5.5-2V4L15 6z" />
          <path d="M9 4v14M15 6v14" />
        </Svg>
      );
    case "bolt":
      return (
        <Svg size={size}>
          <path d="M13 3 5 13.5h6L10 21l9-11h-6z" />
        </Svg>
      );
    case "eye":
      return (
        <Svg size={size}>
          <path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z" />
          <circle cx="12" cy="12" r="2.8" />
        </Svg>
      );
    case "wand":
      return (
        <Svg size={size}>
          <path d="m4 20 11-11M14 6l4 4" />
          <path d="M18 3v3M16.5 4.5h3M7 4v2M6 5h2M20 14v2M19 15h2" />
        </Svg>
      );
    case "code":
      return (
        <Svg size={size}>
          <path d="m8 7-5 5 5 5M16 7l5 5-5 5M14 5l-4 14" />
        </Svg>
      );
    case "chat":
      return (
        <Svg size={size}>
          <path d="M4 5.500A2.500 2.500 0 0 1 6.500 3h11A2.500 2.500 0 0 1 20 5.500v8a2.500 2.500 0 0 1-2.500 2.500H10l-4.500 4v-4H6.500A2.500 2.500 0 0 1 4 13.500z" />
        </Svg>
      );
    default:
      return (
        <Svg size={size}>
          <circle cx="12" cy="12" r="8.500" />
          <path d="M12 7.500V12l3 2" />
        </Svg>
      );
  }
}

export const StarIcon = ({ filled }: { filled: boolean }) => (
  <svg width="20" height="20" viewBox="0 0 24 24" fill={filled ? "currentColor" : "none"} stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="m12 3.5 2.6 5.4 5.9.8-4.3 4.1 1 5.8L12 16.8 6.8 19.6l1-5.8-4.3-4.1 5.9-.8z" />
  </svg>
);
