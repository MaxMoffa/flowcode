import { useI18n } from "../i18n";
import { cliName } from "../agents/cliInfo";
import { useControlConsents, type ControlConsent } from "./control";
import type { ConsentChoice } from "./controlPolicy";
import "./browser-control.css";

const BrowserIcon = () => (
  <svg width="13" height="13" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
    <rect x="1.5" y="2.5" width="13" height="10" rx="1.5" />
    <path d="M1.5 5.5h13" />
  </svg>
);

function Card({ consent }: { consent: ControlConsent }) {
  const { t } = useI18n();
  const agent = consent.agent ? cliName(consent.agent) : t("browserControl.anAgent");
  const answer = (choice: ConsentChoice) => consent.answer(choice);
  const { card } = consent;
  const buttons: { choice: ConsentChoice; label: string; tone?: "main" | "ghost" }[] =
    card === "access"
      ? [
          { choice: "full", label: t("browserControl.access.session"), tone: "main" },
          { choice: "read", label: t("browserControl.access.read") },
          { choice: "deny", label: t("browserControl.deny"), tone: "ghost" },
        ]
      : card === "eval"
        ? [
            { choice: "once", label: t("browserControl.eval.once"), tone: "main" },
            { choice: "site", label: t("browserControl.eval.site") },
            { choice: "deny", label: t("browserControl.deny"), tone: "ghost" },
          ]
        : [
            { choice: "site", label: t("browserControl.interact.site"), tone: "main" },
            { choice: "once", label: t("browserControl.interact.once") },
            { choice: "deny", label: t("browserControl.deny"), tone: "ghost" },
          ];
  const detail = card === "access" ? (consent.target ? `▸ ${consent.target}` : "") : (consent.code ?? "");
  return (
    <div className="bctl-card" role="alertdialog" aria-label={t(`browserControl.${card}.title`, { agent })}>
      <h4>
        <span className="bctl-card-ic">{card === "eval" ? "{ }" : <BrowserIcon />}</span>
        {t(`browserControl.${card}.title`, { agent })}
      </h4>
      <p>{t(`browserControl.${card}.body`, { host: consent.target })}</p>
      {detail && <div className={"bctl-card-target" + (card === "eval" ? " is-code" : "")}>{detail}</div>}
      <div className="bctl-card-row">
        {buttons.map((b) => (
          <button key={b.choice} type="button" className={"bctl-btn" + (b.tone ? ` is-${b.tone}` : "")} onClick={() => answer(b.choice)}>
            {b.label}
          </button>
        ))}
      </div>
    </div>
  );
}

/** The questions an agent's browser use raises, shown where its chat / terminal is: one card per open question. */
export function BrowserControlCards({ hostId, terminal }: { hostId: string | null; terminal?: boolean }) {
  const consents = useControlConsents(hostId);
  if (consents.length === 0) return null;
  return (
    <div className={"bctl-cards" + (terminal ? " is-terminal" : "")}>
      {consents.map((c) => (
        <Card key={c.id} consent={c} />
      ))}
    </div>
  );
}
