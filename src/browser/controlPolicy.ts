// What an agent may do in the in-app browser: the pure part (settings + what the user granted + what the
// page is -> allow, deny with a reason, or ask). Impure parts (cards, pages, the bridge) live in control.ts.
import type { BrowserSettings } from "./browserSettings";
import { isLocalUrl, type ControlOwner } from "./browserStore";

export type ControlAction = "read" | "interact" | "eval" | "open";

/** What a "who owns it" check compares. */
export const ownerKey = (o: ControlOwner) => `${o.kind}:${o.id}`;
export const sameOwner = (a: ControlOwner, b: ControlOwner) => a.kind === b.kind && a.id === b.id;

/** Parses the owner the backend sends; null for anything else. */
export function parseOwner(raw: unknown): ControlOwner | null {
  if (!raw || typeof raw !== "object") return null;
  const { kind, id } = raw as { kind?: unknown; id?: unknown };
  if ((kind !== "chat" && kind !== "terminal") || typeof id !== "string" || !id) return null;
  return { kind, id };
}

/** What one owner's session has been granted so far (in memory, gone with the chat / tab). */
export interface ControlGrants {
  /** "none": not asked yet; "read": looking only; "full": click, type... too. "denied": the user said no. */
  access: "none" | "read" | "full" | "denied";
  /** Hosts where running code in the page is allowed for the session. */
  evalHosts: string[];
  /** Hosts (non-local) where clicking and typing is allowed for the session. */
  interactHosts: string[];
}

export const noGrants = (): ControlGrants => ({ access: "none", evalHosts: [], interactHosts: [] });

type ControlPolicySettings = Pick<BrowserSettings, "control" | "eval" | "externalInteract">;

/** The card the user must answer before the action can go on. */
export type ControlCard = "access" | "interact" | "eval";

export type ControlDecision = { decision: "allow" } | { decision: "deny"; reason: string } | { decision: "ask"; card: ControlCard };

/** localhost, loopback and files on disk: what "local" means for the control settings. */
export function isLocalTarget(url: string | null): boolean {
  if (!url) return false;
  return /^file:/i.test(url) || isLocalUrl(url);
}

export function hostOfUrl(url: string | null): string {
  if (!url) return "";
  try {
    return new URL(url).host.toLowerCase();
  } catch {
    return "";
  }
}

export interface ControlPolicyInput {
  settings: ControlPolicySettings;
  grants: ControlGrants;
  action: ControlAction;
  /** The address the action touches: the page's, or where `open` goes. Null: no page yet. */
  url: string | null;
  /** The page is one the owner drives. Always true for `open` of a new page. */
  owned: boolean;
  /** The user is using the page. */
  paused: boolean;
}

const DENIED = "The user denied browser access for this session.";

/** The decision for one action. Order: settings off -> ownership -> the user's access answer -> pause -> action-specific rules. */
export function decideControl(i: ControlPolicyInput): ControlDecision {
  const { settings, grants, action, url, owned, paused } = i;
  if (settings.control === "off") return { decision: "deny", reason: "Browser control by agents is turned off in Flowcode's settings." };
  if (!owned) return { decision: "deny", reason: "that tab is not one you can control: use browser_tabs to list yours, or browser_navigate with a url to open one" };
  if (grants.access === "denied") return { decision: "deny", reason: DENIED };

  const local = isLocalTarget(url);
  // "local": local pages need no question; everything else (other sites, reading included) is asked once per session.
  const implicit = settings.control === "local" && local;
  if (grants.access === "none" && !implicit) return { decision: "ask", card: "access" };
  const access = grants.access === "none" ? "full" : grants.access;

  if (paused && (action === "interact" || action === "eval")) return { decision: "deny", reason: "the user is using this tab; wait and try again later" };

  if (action === "read") return { decision: "allow" };
  if (action === "open") return { decision: "allow" };

  if (access === "read") return { decision: "deny", reason: "the user allowed read-only browser access: you can use browser_snapshot, browser_screenshot and browser_console but not click, type or run code" };

  const host = hostOfUrl(url);
  if (action === "interact") {
    if (local || settings.externalInteract === "yes") return { decision: "allow" };
    if (settings.externalInteract === "no") return { decision: "deny", reason: "interacting with sites that are not local is turned off in Flowcode's settings; you can still read the page" };
    return grants.interactHosts.includes(host) ? { decision: "allow" } : { decision: "ask", card: "interact" };
  }

  // eval
  switch (settings.eval) {
    case "never":
      return { decision: "deny", reason: "running code in pages (browser_eval) is turned off in Flowcode's settings" };
    case "always":
      return { decision: "allow" };
    case "local":
      return local ? { decision: "allow" } : { decision: "deny", reason: "browser_eval only runs on localhost and local files; Flowcode's settings don't allow it on other sites" };
    default:
      if (local) return { decision: "allow" };
      return grants.evalHosts.includes(host) ? { decision: "allow" } : { decision: "ask", card: "eval" };
  }
}

/** What each card answer does to the grants. `once` leaves them alone (only the action goes on). Returns null when the answer is a no for this request. */
export type ConsentChoice = "full" | "read" | "deny" | "once" | "site";

export function applyConsent(grants: ControlGrants, card: ControlCard, choice: ConsentChoice, host: string): { grants: ControlGrants; allowed: boolean } {
  if (choice === "deny") return { grants: card === "access" ? { ...grants, access: "denied" } : grants, allowed: false };
  if (card === "access") return { grants: { ...grants, access: choice === "read" ? "read" : "full" }, allowed: true };
  if (choice === "site") {
    if (card === "eval") return { grants: { ...grants, evalHosts: [...grants.evalHosts, host] }, allowed: true };
    return { grants: { ...grants, interactHosts: [...grants.interactHosts, host] }, allowed: true };
  }
  return { grants, allowed: true };
}
