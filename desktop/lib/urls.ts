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
