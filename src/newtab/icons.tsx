import type { SVGProps } from "react";

function Icon({ size = 16, children, ...rest }: { size?: number } & SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      fill="none"
      stroke="currentColor"
      strokeWidth="1.8"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...rest}
    >
      {children}
    </svg>
  );
}

export const SearchIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <circle cx="11" cy="11" r="6.5" />
    <path d="m16 16 4.5 4.5" />
  </Icon>
);

export const FolderIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
  </Icon>
);

export const HistoryIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 12a8 8 0 1 0 2.5-5.8" />
    <path d="M4 4.5v4h4" />
    <path d="M12 8v4.2l2.8 1.8" />
  </Icon>
);

export const PencilIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M4 20h4l10.5-10.5a2.1 2.1 0 0 0-3-3L5 17z" />
    <path d="m13.5 7.5 3 3" />
  </Icon>
);

export const CloseIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <path d="M6.5 6.5 17.5 17.5M17.5 6.5 6.5 17.5" />
  </Icon>
);

export const ImageIcon = ({ size }: { size?: number }) => (
  <Icon size={size}>
    <rect x="3.5" y="4.5" width="17" height="15" rx="2" />
    <circle cx="9" cy="10" r="1.6" />
    <path d="m4 17 5-4.5 4 3.5 3-2.5 4 3.5" />
  </Icon>
);
