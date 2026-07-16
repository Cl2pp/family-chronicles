/** Chromium fires this before showing its own install UI; not in the TS DOM lib yet. */
export interface BeforeInstallPromptEvent extends Event {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: 'accepted' | 'dismissed' }>;
}

type Subscriber = (event: BeforeInstallPromptEvent) => void;

let stashed: BeforeInstallPromptEvent | null = null;
let listening = false;
const subscribers = new Set<Subscriber>();

/**
 * Start holding on to Chromium's `beforeinstallprompt`. The browser fires it
 * once per document, shortly after load — typically while the user is still
 * on the login page, long before the app shell (and with it the install
 * nudge) has mounted. Called from module scope of the global client
 * providers so the listener exists from the first script evaluation of
 * every document; the nudge picks the event up later via
 * `onPwaInstallPrompt`.
 */
export function capturePwaInstallPrompt() {
  if (listening || typeof window === 'undefined') return;
  listening = true;
  window.addEventListener('beforeinstallprompt', (event) => {
    event.preventDefault();
    stashed = event as BeforeInstallPromptEvent;
    for (const notify of subscribers) notify(stashed);
  });
}

/** Subscribe to the install event; an already-captured one replays immediately. */
export function onPwaInstallPrompt(subscriber: Subscriber) {
  if (stashed) subscriber(stashed);
  subscribers.add(subscriber);
  return () => {
    subscribers.delete(subscriber);
  };
}
