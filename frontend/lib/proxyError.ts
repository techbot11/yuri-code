// What to say when the proxy cannot reach the backend at all.
//
// The proxy used to just `await fetch(...)` with no catch, so a refused
// connection threw out of the route handler and Next answered a bare 500 with
// no body. lib/api.ts's readable() then had nothing to read and fell back to
// "HTTP 500" -- which is what Setup showed the user while the actual situation
// was "the backend is not running". A server error and an absent server are
// different problems with different fixes, and the UI was reporting the wrong
// one.
//
// Pure so `node --test` reaches it: there is no DOM test environment here.

/** A fetch failure that means "nothing answered", as opposed to a backend that
 *  answered with an error of its own. TypeError is what fetch throws for a
 *  refused connection, a DNS failure or an aborted socket. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof TypeError
    || (err instanceof Error && /ECONNREFUSED|ENOTFOUND|fetch failed|socket/i.test(err.message));
}

export type ProxyFailure = { status: number; detail: string };

/** The reply to send when the backend did not answer.
 *
 *  503, not 500: the frontend is fine and something upstream is missing, which
 *  is what 503 means and what the reader needs to know. The message names the
 *  condition in plain words rather than echoing an errno, because it is
 *  rendered directly on the field that failed to load.
 *
 *  A non-network error is re-reported as a 500 with its own message, so a
 *  genuine bug in the proxy is not disguised as an absent backend -- the
 *  inverse of the mistake this file exists to fix. */
export function proxyFailure(err: unknown): ProxyFailure {
  if (isUnreachable(err)) {
    return { status: 503, detail: "Yuri's backend is not answering. It may still be starting up." };
  }
  const msg = err instanceof Error ? err.message : String(err);
  return { status: 500, detail: `The interface could not reach the backend: ${msg}` };
}
