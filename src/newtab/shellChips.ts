import type { ShellOption } from "../terminal/shellOptions";
import { sameShell } from "../terminal/wslPath";

/** The shells a new tab page offers as chips. "Default (X)" is just X: it is
 * dropped when a chip for X exists, and that chip stands for the default
 * instead of listing the shell twice. The configured default comes first. */
export function shellChips(options: ShellOption[], defaultShell: string) {
  const systemLabel = options.find((o) => o.id === "system")?.label;
  const twin = systemLabel ? options.find((o) => o.id !== "system" && o.label === systemLabel) : undefined;
  /** The shell id a chip stands for. */
  const chipShell = (opt: ShellOption) => (opt === twin && sameShell(defaultShell, "system") ? "system" : opt.id);
  const shown = twin ? options.filter((o) => o.id !== "system") : options;
  const isDefaultChip = (opt: ShellOption) => sameShell(chipShell(opt), defaultShell);
  const chips = [...shown.filter(isDefaultChip), ...shown.filter((o) => !isDefaultChip(o))];
  const defaultLabel = systemLabel ?? "";
  return { chips, chipShell, defaultLabel };
}
