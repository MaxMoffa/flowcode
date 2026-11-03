import { useEffect, useMemo, useState } from "react";
import { BackgroundTerminalsCard } from "../../shared/BackgroundTerminalsCard";
import { backgroundTerminals } from "../../src/chat/backgroundTerminals";
import type { ChatItem } from "../../src/chat/chatModel";
import { t } from "./i18n";

/** The agent's running background commands, as a one-line card under the message card. */
export function BackgroundTerminals({ items, agent }: { items: ChatItem[]; agent: string }) {
  const terminals = useMemo(() => backgroundTerminals(items, agent).filter((term) => term.running), [items, agent]);
  const [expanded, setExpanded] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  useEffect(() => {
    if (terminals.length === 0) {
      setExpanded(false);
      setOpenId(null);
    }
  }, [terminals.length]);
  const labels = useMemo(
    () => ({
      count: (n: number) => t(n === 1 ? "chatTermCountOne" : "chatTermCountMany", { n }),
      hint: "",
      hintOpen: "",
      noOutput: t("chatTermNoOutput"),
    }),
    [],
  );
  return (
    <BackgroundTerminalsCard
      terminals={terminals}
      expanded={expanded}
      onToggle={() => {
        setExpanded((open) => !open);
        setOpenId(null);
      }}
      selected={-1}
      openId={openId}
      onRow={(i) => setOpenId((id) => (id === terminals[i]?.id ? null : (terminals[i]?.id ?? null)))}
      idPrefix="mobile"
      labels={labels}
    />
  );
}
