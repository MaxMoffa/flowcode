import { Fragment, useState, type HTMLAttributes } from "react";
import { displayName, type CommandKind, type MenuEntry, type MenuResult } from "../../src/chat/commandMenu";
import { KindIcon } from "../../src/chat/CommandChip";
import { t, type Key } from "./i18n";
import { ChevronDownIcon } from "./icons";

const GROUP: Record<CommandKind | "best", Key> = {
  flowcode: "chatCmdGroupFlowcode",
  command: "chatCmdGroupCommand",
  skill: "chatCmdGroupSkill",
  plugin: "chatCmdGroupPlugin",
  mcp: "chatCmdGroupMcp",
  best: "chatCmdGroupBest",
};

const SOURCE: Record<CommandKind, Key> = {
  flowcode: "chatCmdSourceFlowcode",
  command: "chatCmdSourceCommand",
  skill: "chatCmdSourceSkill",
  plugin: "chatCmdSourcePlugin",
  mcp: "chatCmdSourceMcp",
};

/** The name with the letters the query matched in the accent colour. */
function Name({ entry, hits }: { entry: MenuEntry; hits: number[] }) {
  return (
    <span className="chat-command-name">
      <i>{entry.sigil || "/"}</i>
      {[...displayName(entry)].map((ch, i) => (hits.includes(i) ? <mark key={i}>{ch}</mark> : ch))}
    </span>
  );
}

interface ChatCommandsProps extends HTMLAttributes<HTMLDivElement> {
  menu: MenuResult;
  query: string;
  /** The agent hasn't said its commands yet. */
  loading: boolean;
  onPick: (entry: MenuEntry) => void;
}

/** The "/" panel over the composer: a tap on a row picks it, the arrow beside it reads the whole entry without picking. */
export function ChatCommands({ menu, query, loading, onPick, ...rest }: ChatCommandsProps) {
  const [open, setOpen] = useState<string | null>(null);
  const { entries, grouped } = menu;
  return (
    <div className="chat-commands" {...rest}>
      <div className="chat-commands-list" role="listbox" aria-label={t("chatCmdTitle")}>
        {entries.length === 0 && !loading && <div className="chat-commands-none">{t("chatCmdNone", { query })}</div>}
        {entries.map(({ entry, hits }, i) => {
          const name = entry.command.name;
          const group: CommandKind | "best" | null = grouped ? entry.kind : i === 0 ? "best" : null;
          const first = group !== null && (!grouped || entries[i - 1]?.entry.kind !== entry.kind);
          const expanded = open === name;
          return (
            <Fragment key={name}>
              {first && group && (
                <div className="chat-commands-group" role="presentation">
                  {t(GROUP[group])}
                  <span>{group === "best" ? entries.length : entries.filter((x) => x.entry.kind === group).length}</span>
                </div>
              )}
              <div className={"chat-command" + (expanded ? " is-open" : "")}>
                <button type="button" role="option" aria-selected={false} className="chat-command-pick" onClick={() => onPick(entry)}>
                  <KindIcon kind={entry.kind} />
                  <span className="chat-command-text">
                    <Name entry={entry} hits={hits} />
                    {entry.command.description && <span className="chat-command-desc">{entry.command.description}</span>}
                  </span>
                </button>
                <button type="button" className="chat-command-more" aria-expanded={expanded} aria-label={t("chatCmdDetails", { name: displayName(entry) })} onClick={() => setOpen(expanded ? null : name)}>
                  <ChevronDownIcon />
                </button>
              </div>
              {expanded && (
                <div className="chat-command-detail">
                  <p>{[t(SOURCE[entry.kind]), entry.namespace, ...entry.also].filter(Boolean).join(" · ")}</p>
                  {entry.hint && <p>{t("chatCmdInstructions", { hint: entry.hint })}</p>}
                </div>
              )}
            </Fragment>
          );
        })}
        {loading && <div className="chat-commands-wait">{t("chatCmdLoading")}</div>}
      </div>
    </div>
  );
}
