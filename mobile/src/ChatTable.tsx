import type { ReactNode } from "react";
import { SharedChatTable } from "../../shared/ChatTable";
import type { MdTable } from "../../src/chat/markdownTable";
import { useBackHandler, useEscape } from "./back";
import { t } from "./i18n";

function usePhoneDismiss(open: boolean, close: () => void) {
  useEscape(open, close);
  useBackHandler(open, close);
}

export function ChatTable({ table, cell }: { table: MdTable; cell: (text: string, key: string) => ReactNode }) {
  return <SharedChatTable table={table} cell={cell} useDismiss={usePhoneDismiss} fullScreen labels={{
    size: t("chatTableSize", { rows: table.rows.length, cols: table.header.length }),
    copied: t("chatTableCopied"), close: t("chatTableClose"), expand: t("chatTableExpand"), sort: t("chatTableSort"),
  }} />;
}
