// Microphone permission, as something the UI can say out loud.
//
// Spike R1 measured that an unsigned packaged app can use the microphone --
// but also that a grant does NOT survive a rebuild, so during development
// every packaged build starts at "not-determined" again. That makes "voice
// stopped working" a frequent, expected event with an unhelpful default
// symptom: nothing at all. Hence this.

/** Electron's `systemPreferences.getMediaAccessStatus("microphone")` values,
 *  plus `unknown` for anything we do not recognise. */
export type MicStatus =
  | "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** Opens System Settings at Privacy & Security -> Microphone. */
export const MIC_SETTINGS_URL =
  "x-apple.systempreferences:com.apple.preference.security?Privacy_Microphone";

const KNOWN: MicStatus[] = ["not-determined", "granted", "denied", "restricted"];

/** Anything unrecognised becomes `unknown` rather than being trusted. Reading
 *  an unexpected value as "granted" would hide the exact condition this
 *  module exists to surface. */
export function normalizeMicStatus(raw: string): MicStatus {
  return (KNOWN as string[]).includes(raw) ? (raw as MicStatus) : "unknown";
}

/** Whether the boot checklist should carry a microphone row at all.
 *
 *  Only the two states the reader can act on. `granted` is silent because an
 *  always-green row is furniture; `not-determined` is silent because the TCC
 *  prompt arrives on the first getUserMedia and announcing it in advance
 *  gives the reader nothing to do. */
export function micNeedsSaying(s: MicStatus): boolean {
  return s === "denied" || s === "restricted";
}
