import { useTheme } from "./ThemeContext";

export function ThemeToggle() {
  const { theme, toggleTheme } = useTheme();
  const isDark = theme === "dark";
  return (
    <button
      className="theme-toggle"
      onClick={toggleTheme}
      aria-label={isDark ? "Switch to light theme" : "Switch to dark theme"}
      title="Toggle theme"
    >
      {isDark ? (
        <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <path d="M21 12.6A9 9 0 1 1 11.4 3a7 7 0 0 0 9.6 9.6z" />
        </svg>
      ) : (
        <svg viewBox="0 0 24 24" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round">
          <circle cx="12" cy="12" r="4.2" />
          <line x1="12" y1="2.5" x2="12" y2="5" />
          <line x1="12" y1="19" x2="12" y2="21.5" />
          <line x1="2.5" y1="12" x2="5" y2="12" />
          <line x1="19" y1="12" x2="21.5" y2="12" />
          <line x1="4.9" y1="4.9" x2="6.6" y2="6.6" />
          <line x1="17.4" y1="17.4" x2="19.1" y2="19.1" />
          <line x1="4.9" y1="19.1" x2="6.6" y2="17.4" />
          <line x1="17.4" y1="6.6" x2="19.1" y2="4.9" />
        </svg>
      )}
    </button>
  );
}
