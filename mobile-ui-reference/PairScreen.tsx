import { useState } from "react";
import { t } from "./i18n";

function defaultDeviceName(): string {
  const ua = navigator.userAgent;
  if (/iPhone/.test(ua)) return "iPhone";
  if (/iPad/.test(ua)) return "iPad";
  if (/Android/.test(ua)) return "Android";
  return "Browser";
}

export function PairScreen({ code, onPaired }: { code: string; onPaired: (token: string) => void }) {
  const [name, setName] = useState(defaultDeviceName);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/pair", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code, deviceName: name.trim() || defaultDeviceName() }),
      });
      const body = (await res.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!res.ok || !body.token) throw new Error(body.error || t("pairFailed"));
      onPaired(body.token);
    } catch (err) {
      setError(err instanceof Error ? err.message : t("pairFailed"));
      setBusy(false);
    }
  }

  return (
    <main className="rm-center">
      <form className="rm-card" onSubmit={submit}>
        <h1>{t("pairTitle")}</h1>
        <p>{t("pairBody")}</p>
        <label className="rm-field">
          <span>{t("deviceName")}</span>
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={40} autoCapitalize="words" autoComplete="off" />
        </label>
        {error && <p className="rm-error">{error}</p>}
        <button type="submit" className="rm-primary" disabled={busy}>
          {busy ? t("pairing") : t("pairButton")}
        </button>
      </form>
    </main>
  );
}

export function UnpairedScreen() {
  return (
    <main className="rm-center">
      <div className="rm-card">
        <h1>{t("unpairedTitle")}</h1>
        <p>{t("unpairedBody")}</p>
      </div>
    </main>
  );
}
