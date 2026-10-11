import type { RemoteTab, Status } from "./client";
import { t } from "./i18n";

/** Last two path segments - the whole path never fits a phone. */
export function shortCwd(cwd: string): string {
  const parts = cwd.split(/[\\/]+/).filter(Boolean);
  if (parts.length <= 2) return cwd;
  return `.../${parts.slice(-2).join("/")}`;
}

export function AgentBadge({ tab }: { tab: Pick<RemoteTab, "cli" | "status"> }) {
  if (!tab.cli) return null;
  const st = tab.status ?? "idle";
  return (
    <span className={`rm-badge is-${st}`}>
      <i />
      {tab.cli} - {t(`status_${st}`)}
    </span>
  );
}

export function StatusPill({ status }: { status: Status }) {
  if (status === "online") return null;
  return <span className="rm-conn">{status === "connecting" ? t("connecting") : t("offline")}</span>;
}

export function TabsScreen({
  tabs,
  status,
  onOpen,
  onUnpair,
}: {
  tabs: RemoteTab[] | null;
  status: Status;
  onOpen: (ptyId: string) => void;
  onUnpair: () => void;
}) {
  const windows = [...new Set((tabs ?? []).map((x) => x.window))];
  return (
    <div className="rm-screen">
      <header className="rm-header">
        <h1>{t("tabs")}</h1>
        <StatusPill status={status} />
        <button type="button" className="rm-ghost" onClick={onUnpair}>
          {t("forget")}
        </button>
      </header>
      <div className="rm-scroll">
        {tabs && tabs.length === 0 && <p className="rm-empty">{t("noTabs")}</p>}
        {windows.map((w, i) => (
          <section key={w}>
            {windows.length > 1 && <h2 className="rm-group">{t("window", { n: i + 1 })}</h2>}
            <ul className="rm-list">
              {tabs!
                .filter((x) => x.window === w)
                .map((tab) => (
                  <li key={tab.ptyId}>
                    <button type="button" className="rm-tab" onClick={() => onOpen(tab.ptyId)}>
                      <span className="rm-tab-label">{tab.label}</span>
                      <span className="rm-tab-cwd">{shortCwd(tab.cwd)}</span>
                      <AgentBadge tab={tab} />
                    </button>
                  </li>
                ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
