// Is a URL the app's own, or somewhere else?
//
// `startsWith` is NOT an origin check, and getting this wrong is a real
// bypass rather than a style point: "http://localhost:3000@evil.com/" is a
// VALID url whose host is evil.com (the part before @ is a username), and it
// begins with the app's origin character for character. There is no address
// bar in this window, so a navigation that slips through shows the user
// nothing to tell them where they are.
//
// Pure so `node --test` reaches it.

/** Whether `url` belongs to `appOrigin`. Anything unparseable is NOT ours:
 *  failing closed sends it to the user's browser, which is safe, whereas
 *  failing open navigates the trusted window. */
export function isAppUrl(url: string, appOrigin: string): boolean {
  try {
    return new URL(url).origin === new URL(appOrigin).origin;
  } catch {
    return false;
  }
}

/** Whether `url` may be handed to shell.openExternal().
 *
 *  isAppUrl() decides whether to NAVIGATE; this decides whether the fallback
 *  ACTION is safe, which was left unguarded. shell.openExternal() asks the
 *  OS to open whatever it is given: `file:` opens a local path, and a
 *  registered custom scheme LAUNCHES A LOCAL APPLICATION with an argument
 *  the page chose. http/https only, and nothing unparseable.
 *
 *  Returns the rejected scheme rather than just false, so the caller can say
 *  what it refused -- the scheme alone, never the URL, which can carry a
 *  token in its query. */
export function externalOpenScheme(url: string): { ok: boolean; scheme: string } {
  let scheme: string;
  try {
    scheme = new URL(url).protocol;
  } catch {
    return { ok: false, scheme: "" }; // not a URL at all
  }
  return { ok: /^https?:$/.test(scheme), scheme };
}
