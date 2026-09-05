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

/** What to tell the user, in their terms, for the failures that actually
 *  happen. The DOMException `name` is the reliable discriminator — `message`
 *  varies by browser and says things like "Requested device not found". */
export function micErrorMessage(err: unknown): string {
  const name = (err as { name?: string } | null)?.name || "";
  if (name === MIC_TIMED_OUT) {
    return "The microphone didn't respond. Another tab or app may be holding it — " +
           "close the other Yuri tab and try again.";
  }
  if (name === "NotAllowedError" || name === "SecurityError") {
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
