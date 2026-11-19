import type { ReactNode } from "react";
import type { AgentViewDef } from "./types";

/** The session menu's top: the session's name, then who runs it and where. */
export function SessionMenuHead({ title, lines, path }: { title: string; lines: string[]; path?: string }) {
  return (
    <div className="chat-menu-head">
      <b title={title}>{title}</b>
      {lines.filter(Boolean).map((line) => (
        <small key={line} title={line}>{line}</small>
      ))}
      {path && <small className="is-mono" title={path}>{path}</small>}
    </div>
  );
}

export interface ViewOption {
  id: string;
  label: string;
  icon: ReactNode;
  checked: boolean;
  disabled?: boolean;
  title?: string;
  onPick: () => void;
}

/** How to look at the session, as segmented pills like the phone's; `hint` sits under them. */
export function ViewSwitch({ label, options, hint }: { label: string; options: ViewOption[]; hint?: ReactNode }) {
  return (
    <>
      <div className="chat-menu-views" role="radiogroup" aria-label={label}>
        {options.map((o) => (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={o.checked}
            disabled={o.disabled && !o.checked}
            title={o.title}
            onClick={o.onPick}
          >
            {o.icon}
            <span>{o.label}</span>
          </button>
        ))}
      </div>
      {hint && <div className="chat-menu-views-hint">{hint}</div>}
    </>
  );
}

const svg = (children: ReactNode) => (
  <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);

export const ChatViewIcon = () => svg(<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />);
export const TerminalViewIcon = () => svg(<><polyline points="4 17 10 11 4 5" /><line x1="12" y1="19" x2="20" y2="19" /></>);
const PluginViewIcon = () => svg(<><rect x="3" y="3" width="7" height="7" rx="1.5" /><rect x="14" y="3" width="7" height="7" rx="1.5" /><rect x="3" y="14" width="7" height="7" rx="1.5" /><rect x="14" y="14" width="7" height="7" rx="1.5" /></>);
export const CopyIcon = () => svg(<><rect x="9" y="9" width="13" height="13" rx="2" /><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1" /></>);
export const StopIcon = () => svg(<rect x="6" y="6" width="12" height="12" rx="2" />);

/** The pill icon for a view: the terminal, the built-in chat, or a plugin's. */
export function viewIcon(view: AgentViewDef): ReactNode {
  if (view.transport === "pty") return <TerminalViewIcon />;
  return view.id === "chat" ? <ChatViewIcon /> : <PluginViewIcon />;
}
