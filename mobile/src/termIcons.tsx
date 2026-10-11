// Icons used only by the terminal page, same 20px stroke style as icons.tsx.
import type { ReactNode } from "react";

function Svg({ children, size = 20 }: { children: ReactNode; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

export const CloseIcon = () => (
  <Svg>
    <path d="m6 6 12 12M18 6 6 18" />
  </Svg>
);

export const ArrowUpIcon = () => (
  <Svg size={18}>
    <path d="M12 19V5m-6 6 6-6 6 6" />
  </Svg>
);

export const ArrowDownIcon = () => (
  <Svg size={18}>
    <path d="M12 5v14m-6-6 6 6 6-6" />
  </Svg>
);

export const ArrowLeftIcon = () => (
  <Svg size={18}>
    <path d="M19 12H5m6-6-6 6 6 6" />
  </Svg>
);

export const ArrowRightIcon = () => (
  <Svg size={18}>
    <path d="M5 12h14m-6-6 6 6-6 6" />
  </Svg>
);

export const KeyboardIcon = () => (
  <Svg>
    <rect x="3" y="6" width="18" height="12" rx="3" />
    <path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" />
  </Svg>
);
