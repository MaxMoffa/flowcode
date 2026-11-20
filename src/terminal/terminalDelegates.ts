import { delegateFinished, delegateRequestKey, parseDelegate, type DelegateInfo, type DelegateRequest } from "../chat/chatModel";

/** What a terminal tab's agent delegated: the latest state per task (in start order) and the delegates' open requests. */
export interface TerminalDelegates {
  delegates: DelegateInfo[];
  requests: DelegateRequest[];
}

export const EMPTY_TERMINAL_DELEGATES: TerminalDelegates = { delegates: [], requests: [] };

/** Keeps the latest state per task, like a chat does: patched in place when known, appended otherwise; a finished task never goes back, and its open requests are dropped. */
export function upsertTerminalDelegate(state: TerminalDelegates, delegate: DelegateInfo): TerminalDelegates {
  const previous = state.delegates.find((d) => d.taskId === delegate.taskId);
  if (previous && delegateFinished(previous)) return state;
  const delegates = previous ? state.delegates.map((d) => (d.taskId === delegate.taskId ? delegate : d)) : [...state.delegates, delegate];
  const requests = delegateFinished(delegate) ? state.requests.filter((r) => r.taskId !== delegate.taskId) : state.requests;
  return { delegates, requests };
}

/** A delegate's new open request; ignored when already queued or when its task is finished. */
export function addTerminalRequest(state: TerminalDelegates, request: DelegateRequest): TerminalDelegates {
  const key = delegateRequestKey(request.childChatId, request.requestId);
  if (state.requests.some((r) => delegateRequestKey(r.childChatId, r.requestId) === key)) return state;
  if (state.delegates.some((d) => d.taskId === request.taskId && delegateFinished(d))) return state;
  return { ...state, requests: [...state.requests, request] };
}

/** A request is gone (answered, or its child ended). */
export function resolveTerminalRequest(state: TerminalDelegates, childChatId: string, requestId: string): TerminalDelegates {
  const key = delegateRequestKey(childChatId, requestId);
  const requests = state.requests.filter((r) => delegateRequestKey(r.childChatId, r.requestId) !== key);
  return requests.length === state.requests.length ? state : { ...state, requests };
}

/** Merges the backend's snapshot (`terminal_delegates`, raw `_flowcode/delegate` params) into the live state: tasks a live event already reported keep that (newer) state; entries that do not parse are skipped. */
export function seedTerminalDelegates(state: TerminalDelegates, raw: unknown): TerminalDelegates {
  if (!Array.isArray(raw)) return state;
  return raw.reduce<TerminalDelegates>((acc, item) => {
    const d = parseDelegate(item);
    return d && !acc.delegates.some((k) => k.taskId === d.taskId) ? upsertTerminalDelegate(acc, d) : acc;
  }, state);
}
