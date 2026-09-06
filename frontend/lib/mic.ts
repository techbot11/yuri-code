// Getting the microphone, and saying what went wrong when we don't.
//
// `getUserMedia` is the one step in a voice connect that can hang forever: it
// has no timeout, and it does not reject while a permission prompt sits
// unanswered or the device is wedged. A connect that hangs there leaves the UI
// showing neither "connected" nor a failure, which is unhelpable — the user
// reported exactly that, with a second tab of the same app already holding the
// mic.
//
// Pure message-mapping lives here so `node --test` can reach it; the browser
// call is a thin wrapper.

/** Long enough for a user to answer a permission prompt, short enough that a
 *  wedged device does not hang the connect indefinitely. */
export const MIC_TIMEOUT_MS = 30_000;

export const MIC_TIMED_OUT = "mic-timeout";

/** Where a refused microphone is actually un-refused in the packaged app, and
 *  the string both the message and the offer key off — so the button and the
 *  sentence that promises it cannot drift apart. Mirrors what
 *  desktop/lib/mic.ts's MIC_SETTINGS_URL opens. */
export const MIC_SETTINGS_SENTENCE =
  "System Settings → Privacy & Security → Microphone";

/** The desktop shell's "open that settings pane for me" bridge, or undefined
 *  in a browser tab.
 *
 *  The same window.yuriBoot.openMicSettings the boot splash uses (Task 4's
 *  mic:settings channel) — which was wired into the splash ONLY, and the
 *  splash shows only while the backend is unreachable, so on a warm start the
 *  user who is actually denied never sees it. This is how the surface they do
 *  reach gets to offer the same thing.
 *
 *  Impure and guarded on purpose; every pure rule below takes the answer as an
 *  argument instead of reaching for it. */
export function micSettingsOpener(): (() => void) | undefined {
  if (typeof window === "undefined") return undefined;
  const bridge = (window as unknown as {
    yuriBoot?: { openMicSettings?: () => void };
  }).yuriBoot;
  const open = bridge?.openMicSettings;
  return typeof open === "function" ? () => open.call(bridge) : undefined;
}

/** Whether a failure message is one whose fix is that settings pane, so a
 *  surface showing the message can offer to open it. Keyed off the shared
 *  sentence above rather than off the error name, because by the time a
 *  component has the text the error itself is long gone. */
export function offersMicSettings(text: string): boolean {
  return (text || "").includes(MIC_SETTINGS_SENTENCE);
}

/** What to tell the user, in their terms, for the failures that actually
 *  happen. The DOMException `name` is the reliable discriminator — `message`
 *  varies by browser and says things like "Requested device not found".
 *
 *  `desktop` decides where a REFUSED permission is fixed, and getting it wrong
 *  is not a nuance: the packaged app has no address bar to allow anything in
 *  (there is no browser chrome at all — see desktop/main/index.ts's window),
 *  and macOS, not the page, is what refused. It defaults to whether the shell
 *  bridge is there, so existing call sites (lib/realtime.ts, lib/gemini.ts)
 *  need not know; pass it explicitly to keep the function pure. */
export function micErrorMessage(
  err: unknown,
  desktop: boolean = micSettingsOpener() !== undefined,
): string {
  const name = (err as { name?: string } | null)?.name || "";
  if (name === MIC_TIMED_OUT) {
    return "The microphone didn't respond. Another tab or app may be holding it — " +
           "close the other Yuri tab and try again.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
    if (desktop) {
      return "Microphone access was refused. macOS is what refused it, not this window: " +
             `open ${MIC_SETTINGS_SENTENCE} and switch Yuri OS on, then connect again.`;
    }
    return "Microphone access was refused. Allow it for this site in your " +
           "browser's address bar, then connect again.";
  }
  if (name === "NotFoundError" || name === "OverconstrainedError") {
    return "No microphone was found. Check your input device and try again.";
  }
  if (name === "NotReadableError" || name === "AbortError") {
    return "The microphone is in use by something else — often another tab of " +
           "this app. Close it and try again.";
  }
  const msg = (err as { message?: string } | null)?.message;
  return msg ? `Microphone error: ${msg}` : "Could not open the microphone.";
}

/** The mic stream, or a rejection that `micErrorMessage` can explain.
 *
 *  The timeout is the point: without it a stalled `getUserMedia` never settles
 *  and the connect neither succeeds nor fails. */
export async function getMicStream(
  constraints: MediaStreamConstraints,
  timeoutMs: number = MIC_TIMEOUT_MS,
): Promise<MediaStream> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      const e = new Error("the microphone did not respond in time");
      e.name = MIC_TIMED_OUT;
      reject(e);
    }, timeoutMs);
  });
  try {
    return await Promise.race([
      navigator.mediaDevices.getUserMedia(constraints),
      timeout,
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}
