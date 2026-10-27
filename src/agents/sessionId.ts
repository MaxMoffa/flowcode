/** Session ids the app types into a shell (`claude --resume <id>`, `codex resume <id>`...) must be plain tokens: an id read from a session file or a phone could otherwise carry shell syntax. */
const SAFE_SESSION_ID = /^[A-Za-z0-9_-]{1,128}$/;

export const isSafeSessionId = (id: string): boolean => SAFE_SESSION_ID.test(id);
