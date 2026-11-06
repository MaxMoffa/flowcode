import type { ReactNode } from "react";
import "./session-top.css";
import { useBackHandler, useEscape } from "./back";
import { viewChoices, type ViewChoice } from "./ChatMenu";
import { t } from "./i18n";
import { BackIcon, ChevronDownIcon, DotsIcon } from "./icons";

/** A menu entry: without `run` it shows greyed out. */
export interface MenuRow {
  label: string;
  icon: ReactNode;
  run?: () => void;
  danger?: boolean;
  note?: string;
}

/** The phone's session top: back, the project in its capsule (or `center` instead: a crumb, the rename field) and the tools button, with no bar behind them. `floating` lays it over a thread that scrolls under it; otherwise it takes its own band. The menus go in `children`, so they anchor to it. */
export function SessionTop(props: { name: string; state: string; stateText: string; backLabel: string; onBack: () => void; onSession: () => void; center?: ReactNode; onTools: () => void; toolsLabel: string; waiting: number; floating?: boolean; children: ReactNode }) {
  const { name, state, stateText, center, waiting } = props;
  return (
    <header className={"st-top" + (props.floating ? " is-floating" : "")}>
      <button type="button" className="st-btn" aria-label={props.backLabel} onClick={props.onBack}>
        <BackIcon />
      </button>
      {center ? (
        <div className="st-capsule">{center}</div>
      ) : (
        <button type="button" className="st-capsule" aria-haspopup="dialog" onClick={props.onSession}>
          <i className={"st-dot is-" + state} role="img" aria-label={stateText} title={stateText} />
          <b>{name}</b>
          <ChevronDownIcon />
        </button>
      )}
      <button type="button" className="st-btn" aria-haspopup="dialog" aria-label={props.toolsLabel} onClick={props.onTools}>
        <DotsIcon />
        {waiting > 0 && <b className="term-pill-badge">{waiting}</b>}
      </button>
      {props.children}
    </header>
  );
}

function Popover({ open, onClose, label, centered, children }: { open: boolean; onClose: () => void; label: string; centered?: boolean; children: ReactNode }) {
  useBackHandler(open, onClose);
  useEscape(open, onClose);
  if (!open) return null;
  return (
    <>
      <div className="st-scrim" onClick={onClose} />
      <div className={"st-menu" + (centered ? " is-centered" : "")} role="dialog" aria-label={label}>
        {children}
      </div>
    </>
  );
}

function Row({ row, onClose }: { row: MenuRow; onClose: () => void }) {
  return (
    <button
      type="button"
      className={"st-row" + (row.danger ? " danger" : "")}
      disabled={!row.run}
      onClick={() => {
        onClose();
        row.run?.();
      }}
    >
      {row.icon}
      <span>{row.label}</span>
      {row.note && <small>{row.note}</small>}
    </button>
  );
}

/** The capsule's menu: what the session is, how to look at it, its name, and closing it. `views` (the plugin views) is omitted when the session has no other view. */
export function SessionMenu(props: { open: boolean; onClose: () => void; title: string; subtitle: string; path: string; views?: ViewChoice[]; view: string; onView: (id: string) => void; viewsDisabled?: boolean; rows: MenuRow[]; closeRow?: MenuRow; hint?: string }) {
  const { open, onClose, views, view, closeRow } = props;
  return (
    <Popover open={open} onClose={onClose} label={t("chatMenuTitle")} centered>
      <div className="st-head">
        <b>{props.title}</b>
        <small>{props.subtitle}</small>
        <small className="mono">{props.path}</small>
      </div>
      {views && (
        <div className="st-views" role="radiogroup" aria-label={t("chatViewAs")}>
          {viewChoices(views).map((c) => (
            <button
              key={c.id}
              type="button"
              role="radio"
              aria-checked={c.id === view}
              disabled={props.viewsDisabled && c.id !== view}
              onClick={() => {
                onClose();
                if (c.id !== view) props.onView(c.id);
              }}
            >
              {c.icon}
              <span>{c.label}</span>
            </button>
          ))}
        </div>
      )}
      {props.rows.map((r) => (
        <Row key={r.label} row={r} onClose={onClose} />
      ))}
      {closeRow && (
        <>
          <hr />
          <Row row={closeRow} onClose={onClose} />
        </>
      )}
      {props.hint && <p className="st-hint">{props.hint}</p>}
    </Popover>
  );
}

/** The "⋯" menu: what to do in the session now. The danger rows sit apart at the end. */
export function ToolsMenu({ open, onClose, rows }: { open: boolean; onClose: () => void; rows: MenuRow[] }) {
  const safe = rows.filter((r) => !r.danger);
  const danger = rows.filter((r) => r.danger);
  return (
    <Popover open={open} onClose={onClose} label={t("sessionTools")}>
      {safe.map((r) => (
        <Row key={r.label} row={r} onClose={onClose} />
      ))}
      {danger.length > 0 && <hr />}
      {danger.map((r) => (
        <Row key={r.label} row={r} onClose={onClose} />
      ))}
    </Popover>
  );
}
