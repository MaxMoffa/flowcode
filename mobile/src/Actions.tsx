import { useState } from "react";
import { t } from "./i18n";
import { BoltIcon } from "./icons";
import { send, showToast, type Action, type Tab } from "./remote";

export function ActionsScreen({ tabs, actions, lastOpened }: { tabs: Tab[] | null; actions: Action[]; lastOpened: string | null }) {
  const list = tabs ?? [];
  const [picked, setPicked] = useState<string | null>(null);
  const target = list.find((x) => x.ptyId === picked) ?? list.find((x) => x.ptyId === lastOpened) ?? list[0];

  function run(a: Action) {
    send({ t: "action", id: a.id, ptyId: target?.ptyId });
    showToast(t("done"));
  }

  return (
    <>
      <header className="top">
        <h1>{t("actions")}</h1>
      </header>
      <label className="select">
        <span>{t("target")}</span>
        <select value={target?.ptyId ?? ""} onChange={(e) => setPicked(e.target.value)} disabled={list.length === 0}>
          {list.length === 0 && <option value="">{t("noTarget")}</option>}
          {list.map((x) => (
            <option key={x.ptyId} value={x.ptyId}>
              {x.label}
            </option>
          ))}
        </select>
      </label>
      {actions.length === 0 && <div className="empty">{t("noActions")}</div>}
      <div className="stack tight">
        {actions.map((a) => (
          <button key={a.id} type="button" className="card row" onClick={() => run(a)}>
            <span className="row-icon">
              <BoltIcon />
            </span>
            <span className="row-body">
              <span className="row-title">{a.label}</span>
            </span>
            <span className="run">{t("run")}</span>
          </button>
        ))}
      </div>
    </>
  );
}
