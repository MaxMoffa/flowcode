import { isRootPath, separatorOf, comparablePath, isWindowsHostPath } from "../lib/path";
import { toWslPath, wslDistroOfPath } from "../terminal/wslPath";

/** Whether an agent works in the project folder or somewhere below it. An
 * agent inside WSL reports a Linux path, so the project folder is brought to
 * that form first; a folder on another machine's file system never matches.
 * A tab sitting on a root ("C:\", "/") is not a project. */
export function inProject(
  agentCwd: string | null | undefined,
  agentWslDistro: string | null | undefined,
  projectCwd: string,
  projectWslDistro: string | undefined,
): boolean {
  if (!agentCwd) return false;
  let project = projectCwd;
  if (agentWslDistro) {
    const projectDistro = wslDistroOfPath(projectCwd) ?? projectWslDistro;
    if (projectDistro && projectDistro.toLowerCase() !== agentWslDistro.toLowerCase()) return false;
    if (!project.startsWith("/")) {
      const converted = toWslPath(agentWslDistro, project);
      if (converted === null) return false;
      project = converted;
    }
  } else if (project.startsWith("/") && isWindowsHostPath(agentCwd)) {
    return false;
  }
  const a = comparablePath(agentCwd);
  const b = comparablePath(project);
  if (isRootPath(b)) return false;
  return a === b || a.startsWith(b + separatorOf(b));
}

/** The previous array when the polled one has the same content, so an
 * unchanged poll doesn't re-render the list. */
export function keepIfSame<T>(prev: T[], next: T[]): T[] {
  return JSON.stringify(prev) === JSON.stringify(next) ? prev : next;
}
