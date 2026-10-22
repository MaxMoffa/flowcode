import { useI18n } from "../i18n";

/** "5 minutes ago", "yesterday"... for an epoch-milliseconds time, in the UI language. */
export function useRelativeTime() {
  const { language } = useI18n();
  const format = new Intl.RelativeTimeFormat(language, { numeric: "auto" });
  return (at: number) => {
    const minutes = Math.round((at - Date.now()) / 60000);
    if (Math.abs(minutes) < 60) return format.format(minutes, "minute");
    const hours = Math.round(minutes / 60);
    if (Math.abs(hours) < 24) return format.format(hours, "hour");
    return format.format(Math.round(hours / 24), "day");
  };
}
