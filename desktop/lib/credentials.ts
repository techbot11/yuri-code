// The shape of the encrypted credential blob, and which keys belong in it.
//
// Pure: no safeStorage, no filesystem, so `node --test` reaches it.
// main/credentials.ts does the encrypting.
//
// JSON rather than dotenv, deliberately. A token containing a newline
// truncates a KEY=VALUE file and one containing a quote corrupts it, and
// these values are opaque strings from five different providers -- assuming
// anything about their characters is how a credential store loses a
// credential.

export type CredentialBlob = { version: 1; values: Record<string, string> };

/** Mirrors `backend/config.py`'s MANAGED_KEYS entries with `secret=True`.
 *  Held by hand: the two live in different languages in different processes.
 *  credentials.test.ts pins this list, and that test is the record of what it
 *  must match -- config.py is the source of truth. */
export const SECRET_KEYS: readonly string[] = [
  "GEMINI_API_KEY",
  "OPENAI_API_KEY",
  "AZURE_OPENAI_API_KEY",
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
];

/** Whether a key belongs in the Keychain. Non-secrets (paths, ports, roots)
 *  stay in the .env file: a user may reasonably want to read and edit those
 *  in a text editor, and encrypting them would only make that harder. */
export function isSecretKey(name: string): boolean {
  return SECRET_KEYS.includes(name);
}

export function serializeCredentials(values: Record<string, string>): string {
  const blob: CredentialBlob = { version: 1, values };
  return JSON.stringify(blob);
}

/** Credentials from a blob, or `{}` for anything unreadable.
 *
 *  Never throws. This is called before the window exists, and a corrupt or
 *  truncated file must degrade to "no keys set" -- a state Setup already
 *  renders -- rather than take down the main process with no UI to say why.
 *  A version we do not know is treated as unreadable rather than guessed at. */
export function parseCredentials(raw: string): Record<string, string> {
  let blob: unknown;
  try {
    blob = JSON.parse(raw);
  } catch {
    return {};
  }
  if (typeof blob !== "object" || blob === null) return {};
  const b = blob as Partial<CredentialBlob>;
  if (b.version !== 1 || typeof b.values !== "object" || b.values === null) return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(b.values)) {
    // Dropped, not coerced: String(null) is "null", which would be stored and
    // sent to a provider as a literal credential.
    if (typeof v === "string") out[k] = v;
  }
  return out;
}
