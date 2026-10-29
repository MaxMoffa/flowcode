import { classify, type CommandKind } from "./commandMenu";

const KIND_LETTER: Record<CommandKind, string> = { flowcode: "F", command: "›", skill: "S", plugin: "P", mcp: "M" };

/** Small rounded square telling the kind of a command; tinted by `.is-<kind>`. */
export function KindIcon({ kind }: { kind: CommandKind }) {
  return (
    <span className={`chat-kind-icon is-${kind}`} aria-hidden="true">
      {KIND_LETTER[kind]}
    </span>
  );
}

interface CommandChipProps {
  kind: CommandKind;
  /** The command's name, without its "/" or "$": the chip already says it is a command. */
  name: string;
  title?: string;
  selected?: boolean;
  /** Set in the composer only: sent messages keep the chip fixed. */
  onRemove?: () => void;
  removeLabel?: string;
}

/** A picked command shown as a coloured chip: in the composer (removable) and in the sent message. */
export function CommandChip({ kind, name, title, selected, onRemove, removeLabel }: CommandChipProps) {
  return (
    <span className={`chat-cmd-chip is-${kind}${selected ? " is-selected" : ""}${onRemove ? " is-removable" : ""}`} title={title}>
      <KindIcon kind={kind} />
      <span className="chat-cmd-chip-name">{name}</span>
      {onRemove && (
        <button type="button" className="chat-cmd-chip-x" aria-label={removeLabel} title={removeLabel} tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={onRemove}>
          {"×"}
        </button>
      )}
    </span>
  );
}

const LEADING_COMMAND = /^([/$])([A-Za-z0-9][\w:.-]*)(?=\s|$)/;
const NO_CLIENT_COMMANDS = new Set<string>();

/** A sent message's text; a leading "/name" or "$name" shows as the same chip the composer had. */
export function UserText({ text }: { text: string }) {
  const m = LEADING_COMMAND.exec(text);
  if (!m) return <>{text}</>;
  // "clear" is ours, though it is never sent as text; kept for messages typed by hand.
  const entry = classify({ name: m[1] === "$" ? `$${m[2]}` : m[2] }, m[2] === "clear" ? new Set(["clear"]) : NO_CLIENT_COMMANDS);
  return (
    <>
      <CommandChip kind={entry.kind} name={m[2]} />
      {text.slice(m[0].length)}
    </>
  );
}
