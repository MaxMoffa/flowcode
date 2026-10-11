// 20px stroke icons, inline so the app needs no icon font or network.
import type { ReactNode } from "react";

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const AgentsIcon = () => (
  <Svg>
    <rect x="4" y="7" width="16" height="12" rx="4" />
    <path d="M12 7V4" />
    <circle cx="12" cy="3.5" r="0.6" />
    <circle cx="9" cy="13" r="0.8" />
    <circle cx="15" cy="13" r="0.8" />
  </Svg>
);

export const TerminalIcon = () => (
  <Svg>
    <rect x="3" y="5" width="18" height="14" rx="3" />
    <path d="m7.5 10 2.5 2-2.5 2" />
    <path d="M13 14.5h3.5" />
  </Svg>
);

export const FolderIcon = () => (
  <Svg>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h3.6l2 2.2h7.4a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Svg>
);

export const FileIcon = () => (
  <Svg>
    <path d="M7 3.5h6.5L18 8v11a1.5 1.5 0 0 1-1.5 1.5h-9A1.5 1.5 0 0 1 6 19V5A1.5 1.5 0 0 1 7.500 3.500z" />
    <path d="M13.500 3.500V8H18" />
  </Svg>
);

export const BoltIcon = () => (
  <Svg>
    <path d="M13 3 5.500 13.500H11L10 21l7.500-10.500H12z" />
  </Svg>
);

export const BackIcon = () => (
  <Svg size={22}>
    <path d="m14.500 6-6 6 6 6" />
  </Svg>
);

export const ChevronIcon = () => (
  <Svg size={18}>
    <path d="m9.500 6 6 6-6 6" />
  </Svg>
);

export const QrIcon = () => (
  <Svg>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M20 16v2a2 2 0 0 1-2 2h-2M8 20H6a2 2 0 0 1-2-2v-2" />
    <path d="M8 12h8" />
  </Svg>
);

export const SendIcon = () => (
  <Svg>
    <path d="M5 12h13" />
    <path d="m13 6 6 6-6 6" />
  </Svg>
);
