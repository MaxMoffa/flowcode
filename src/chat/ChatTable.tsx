import { useEffect, type ReactNode } from "react";
import { SharedChatTable } from "../../shared/ChatTable";
import type { MdTable } from "./markdownTable";
import { useI18n } from "../i18n";

function useDesktopDismiss(open: boolean, close: () => void) {
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      // Capture phase: stop it here so Escape doesn't reach the composer and cancel the turn.
      event.stopPropagation();
      close();
    };
    window.addEventListener("keydown", onKeyDown, true);
    return () => window.removeEventListener("keydown", onKeyDown, true);
  }, [open, close]);
}

export function ChatTable({ table, cell }: { table: MdTable; cell: (text: string, key: string) => ReactNode }) {
  const { t } = useI18n();
  return <SharedChatTable table={table} cell={cell} useDismiss={useDesktopDismiss} labels={{
    size: t("chat.table.size", { rows: table.rows.length, cols: table.header.length }),
    copied: t("chat.table.copied"), close: t("chat.table.close"), expand: t("chat.table.expand"), sort: t("chat.table.sort"),
    back: t("chat.table.back"), filter: t("chat.table.filter"),
    shown: (shown, total) => t("chat.table.shown", { shown, total }),
    copyMarkdownTitle: t("chat.table.copyMarkdownTitle"), copyCsvTitle: t("chat.table.copyCsvTitle"),
  }} />;
}
