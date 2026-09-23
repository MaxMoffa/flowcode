import { readBool, writeBool } from "../lib/storage";

/** A missing/blocked storage just means the flow shows again next launch.
 * Kept apart from WelcomeFlow.tsx so App can check it without pulling the
 * (lazily loaded) flow and its dependencies into the main bundle. */
const WELCOME_SEEN_KEY = "flowcode.hasSeenWelcome";

export const hasSeenWelcome = () => readBool(WELCOME_SEEN_KEY, false);
export const markWelcomeSeen = () => writeBool(WELCOME_SEEN_KEY, true);
