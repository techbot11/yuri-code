// safeStorage-backed credential storage.
//
// Spec 6.3: ciphertext in the app's own Application Support directory,
// plaintext never on disk, and the values handed to the children as
// environment variables -- which also means they outrank every file in
// backend/config.py's precedence chain (real env beats every .env), so a
// stale dotfile cannot shadow a Keychain value.
//
// Nothing here logs a value. Key NAMES and counts only.
import { app, safeStorage } from "electron";
import fs from "node:fs";
import path from "node:path";

import {
  isSecretKey, parseCredentials, serializeCredentials,
} from "../lib/credentials";

function storePath(): string {
  return path.join(app.getPath("userData"), "credentials.enc");
}

/** Whether the Keychain is actually available. False on a machine where
 *  safeStorage cannot reach a keyring, in which case the .env path remains
 *  the only store and Setup must keep working through it. */
export function credentialsAvailable(): boolean {
  return safeStorage.isEncryptionAvailable();
}

/** Every stored credential, or {} if there is no store, it is unreadable, or
 *  encryption is unavailable. Never throws: this runs before any window
 *  exists.
 *
 *  "unreadable" and "no keys set" are NOT the same fact, and collapsing them
 *  into one `{}` would hide the one failure mode spike R1 flagged as likely:
 *  an unsigned app's Keychain access is gated on its own identity, so a
 *  rebuilt bundle can lose the ability to decrypt a store it wrote under a
 *  previous build. `readCredentials()` alone cannot fix that -- it has no
 *  window to tell anyone -- but it must not let the distinction vanish
 *  before it reaches a caller who can. Use `readCredentialsDetailed()` where
 *  that distinction matters; this wrapper stays for call sites (env
 *  construction) that only ever wanted the values. */
export function readCredentials(): Record<string, string> {
  return readCredentialsDetailed().values;
}

export type CredentialReadResult = {
  values: Record<string, string>;
  /** True exactly when a store file exists but could not be turned back into
   *  credentials -- a different machine, a reset Keychain, safeStorage newly
   *  unavailable. Distinct from "no store yet" (ordinary first run) and from
   *  "store read fine, and it was empty" -- both of which also return
   *  `values: {}` but leave this false. A caller that only ever looked at
   *  `values` could not tell "you have no keys" from "your keys are
   *  unreadable"; this field is what lets Setup say the second thing rather
   *  than silently behaving like the first. */
  unreadable: boolean;
};

export function readCredentialsDetailed(): CredentialReadResult {
  const p = storePath();
  let cipher: Buffer;
  try {
    cipher = fs.readFileSync(p);
  } catch {
    return { values: {}, unreadable: false };   // no store yet is the normal first-run case
  }
  if (!credentialsAvailable()) {
    // A store exists but nothing on this machine can decrypt it right now.
    // Reported as unreadable, not as "no keys set" -- the whole reason this
    // type exists.
    console.error("[yuri] credentials.enc exists but the Keychain is unavailable");
    return { values: {}, unreadable: true };
  }
  try {
    return { values: parseCredentials(safeStorage.decryptString(cipher)), unreadable: false };
  } catch (err) {
    // A store we cannot decrypt (a different machine, a reset Keychain, an
    // unsigned app's identity changing across a rebuild -- see spike R1)
    // is reported by name only, never by value.
    console.error("[yuri] credentials.enc could not be decrypted:",
                  err instanceof Error ? err.message : "unknown error");
    return { values: {}, unreadable: true };
  }
}

/** Merge `updates` into the store. An empty-string value REMOVES a key --
 *  Setup's way of clearing one -- so writing "" cannot store an empty
 *  credential that then masks a real one from the environment. */
export function writeCredentials(updates: Record<string, string>): { written: string[] } {
  if (!credentialsAvailable()) {
    throw new Error("the system keychain is unavailable");
  }
  // Deliberately NOT readCredentials(): a write that starts from an
  // unreadable store (readCredentials()'s {} for that case) would silently
  // discard every credential the store could not decrypt this run, which is
  // the "keys quietly vanish" failure this whole module exists to avoid --
  // see readCredentialsDetailed()'s comment. Refuse instead: the caller
  // (Setup) can then say so, rather than a merge quietly re-encrypting a
  // stale, incomplete set under the new value.
  const before = readCredentialsDetailed();
  if (before.unreadable) {
    throw new Error("the existing credential store could not be decrypted on this machine " +
      "-- saving now would silently discard whatever it held");
  }
  const current = before.values;
  const written: string[] = [];
  for (const [k, v] of Object.entries(updates)) {
    // Refused rather than silently dropped: a caller trying to store a
    // non-secret here has made a mistake worth surfacing.
    if (!isSecretKey(k)) throw new Error(`${k} is not a credential`);
    if (v === "") delete current[k];
    else current[k] = v;
    written.push(k);
  }
  fs.mkdirSync(path.dirname(storePath()), { recursive: true });
  fs.writeFileSync(storePath(), safeStorage.encryptString(serializeCredentials(current)),
                   { mode: 0o600 });
  console.log(`[yuri] credentials updated: ${written.join(", ") || "none"}`);
  return { written };
}
