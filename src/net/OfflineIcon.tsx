/** Wi-Fi with a slash through it: the "no connection" mark. */
export function OfflineIcon({ size = 14, className }: { size?: number; className?: string }) {
  return (
    <svg
      className={className}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.4"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M1.5 6a9.5 9.5 0 0 1 4-2.2" />
      <path d="M14.5 6a9.5 9.5 0 0 0-3.2-1.9" />
      <path d="M4 8.7a5.5 5.5 0 0 1 2-1.2" />
      <path d="M12 8.7a5.5 5.5 0 0 0-1.4-1" />
      <path d="M6.6 11.2a2.4 2.4 0 0 1 2.8 0" />
      <circle cx="8" cy="13" r="0.6" fill="currentColor" />
      <path d="M2 2l12 12" />
    </svg>
  );
}
