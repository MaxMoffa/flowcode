import type { ReactNode } from "react";
import { Svg } from "./icons";

export type SectionId = "appearance" | "terminal" | "agents" | "resume" | "profiles" | "language" | "security" | "background" | "updates" | "phone";

const svg = (children: ReactNode) => <Svg size={18}>{children}</Svg>;

export const ICONS: Record<SectionId, { tone: string; icon: ReactNode }> = {
  appearance: {
    tone: "violet",
    icon: svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M12 3a9 9 0 0 0 0 18z" fill="currentColor" />
      </>,
    ),
  },
  terminal: {
    tone: "blue",
    icon: svg(
      <>
        <rect x="3" y="4" width="18" height="16" rx="3" />
        <path d="M7 9l3 3-3 3M12 15h5" />
      </>,
    ),
  },
  agents: {
    tone: "amber",
    icon: svg(
      <>
        <path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4z" />
        <path d="M10 21h4" />
      </>,
    ),
  },
  profiles: {
    tone: "blue",
    icon: svg(
      <>
        <circle cx="9" cy="8" r="3.5" />
        <path d="M2.5 20c0-3.6 2.9-6 6.5-6s6.5 2.4 6.5 6M16 4.8a3.5 3.5 0 0 1 0 6.4M18 14.3c2 .8 3.5 2.6 3.5 5.7" />
      </>,
    ),
  },
  resume: { tone: "green", icon: svg(<path d="M4 12a8 8 0 0 1 14-5.3L20 9M20 4v5h-5M20 12a8 8 0 0 1-14 5.3L4 15M4 20v-5h5" />) },
  language: {
    tone: "plain",
    icon: svg(
      <>
        <circle cx="12" cy="12" r="9" />
        <path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18" />
      </>,
    ),
  },
  security: {
    tone: "green",
    icon: svg(
      <>
        <rect x="5" y="11" width="14" height="10" rx="2" />
        <path d="M8 11V8a4 4 0 0 1 8 0v3" />
      </>,
    ),
  },
  background: {
    tone: "amber",
    icon: svg(
      <>
        <path d="M5 12.5a10 10 0 0 1 14 0M8.5 16a5 5 0 0 1 7 0" />
        <circle cx="12" cy="19" r="1" fill="currentColor" />
      </>,
    ),
  },
  updates: {
    tone: "green",
    icon: svg(<path d="M12 4v11M7.5 10.5L12 15l4.5-4.5M5 19h14" />),
  },
  phone: {
    tone: "plain",
    icon: svg(
      <>
        <rect x="7" y="2" width="10" height="20" rx="2" />
        <path d="M11 18h2" />
      </>,
    ),
  },
};
