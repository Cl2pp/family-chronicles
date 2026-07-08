/**
 * Hours of chat inactivity after which the app starts a fresh conversation.
 * Lives in its own module (no db imports) so the chat client can share it.
 */
export const CONVERSATION_IDLE_HOURS = 24;

export const CONVERSATION_IDLE_MS = CONVERSATION_IDLE_HOURS * 60 * 60 * 1000;
