import test from "node:test";
import assert from "node:assert/strict";
import {
  blocking, canSave, DISCARD_UNREADABLE_CONFIRM, DISCARD_UNREADABLE_LABEL,
  effectLabel, effectsSentence, fieldPlaceholder, fieldValue,
  fixAction, gateOpen, pendingChanges, saveTransport, secretSaveBlockedReason,
  shadowedByShell, shellShadowWarning, SHELL_SOURCE, UNREADABLE_STORE_BANNER,
  type DoctorCheck, type ManagedKey,
} from "./setup.ts";

const check = (over: Partial<DoctorCheck> = {}): DoctorCheck => ({
  name: "claude", ok: true, detail: "/opt/homebrew/bin/claude", required: true, ...over,
});

const key = (over: Partial<ManagedKey> = {}): ManagedKey => ({
  name: "GEMINI_API_KEY", label: "Gemini API key", secret: true, effect: "now",
  blurb: "Lets her talk over Gemini Live.", set: false, hint: "", masked: false,
  source: "not set", ...over,
});

test("only a FAILING REQUIRED check blocks", () => {
  // tmux failing costs the live terminal pane, not the app — so it must not
  // hold the whole UI hostage.
  const rows = [
    check({ name: "claude", ok: true }),
    check({ name: "tmux", ok: false, required: false }),
    check({ name: "voice keys", ok: false, required: true }),
  ];
  assert.deepEqual(blocking(rows).map((c) => c.name), ["voice keys"]);
});

test("the gate is open when every required check passes", () => {
  assert.equal(gateOpen([check({ ok: true }), check({ name: "tmux", ok: false, required: false })]), true);
  assert.equal(gateOpen([check({ ok: false })]), false);
});

test("the gate stays SHUT while the checks are unknown", () => {
  // null is "not loaded yet". Treating it as open would flash the whole app
  // and then yank it away; treating it as shut shows the boot state, which is
  // what is actually true.
  assert.equal(gateOpen(null), false);
});

test("an empty check list does not silently open the gate", () => {
  // No checks means the endpoint told us nothing, not that all is well.
  assert.equal(gateOpen([]), false);
});

test("each effect scope has plain words", () => {
  assert.match(effectLabel("now"), /now|straight away|immediately/i);
  assert.match(effectLabel("next-session"), /next/i);
  assert.match(effectLabel("restart"), /restart/i);
});

test("the effects sentence names the strongest requirement", () => {
  assert.match(effectsSentence(["now"]), /now|straight away|immediately/i);
  assert.match(effectsSentence(["now", "restart"]), /restart/i,
    "a change needing a restart must not be reported as taking effect now");
  assert.equal(effectsSentence([]), "");
});

test("a pending change is one that differs from what is saved", () => {
  const keys = [key({ name: "ANTHROPIC_MODEL", secret: false, set: true, hint: "claude-opus-5" }),
                key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  // Same value as the visible hint on a NON-secret is not a change.
  assert.deepEqual(pendingChanges(keys, { ANTHROPIC_MODEL: "claude-opus-5" }), []);
  assert.deepEqual(pendingChanges(keys, { ANTHROPIC_MODEL: "claude-sonnet-5" }),
                   ["ANTHROPIC_MODEL"]);
});

test("typing into a SECRET field is always a change", () => {
  // Its current value is unknown to the client by design, so it can never be
  // compared — anything typed has to be treated as new.
  const keys = [key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  assert.deepEqual(pendingChanges(keys, { GEMINI_API_KEY: "anything" }),
                   ["GEMINI_API_KEY"]);
});

test("clearing a set key is a change; clearing an unset one is not", () => {
  const set = [key({ name: "ANTHROPIC_MODEL", secret: false, set: true, hint: "m1" })];
  assert.deepEqual(pendingChanges(set, { ANTHROPIC_MODEL: "" }), ["ANTHROPIC_MODEL"]);
  const unset = [key({ name: "ANTHROPIC_MODEL", secret: false, set: false, hint: "" })];
  assert.deepEqual(pendingChanges(unset, { ANTHROPIC_MODEL: "" }), []);
});

test("an untouched field is never a change", () => {
  const keys = [key({ name: "GEMINI_API_KEY", set: true, hint: "…4f2a" })];
  assert.deepEqual(pendingChanges(keys, {}), []);
});

test("save needs at least one pending change", () => {
  const keys = [key({ name: "ANTHROPIC_MODEL", secret: false, set: false })];
  assert.equal(canSave(keys, {}), false);
  assert.equal(canSave(keys, { ANTHROPIC_MODEL: "  " }), false, "whitespace is not a value");
  assert.equal(canSave(keys, { ANTHROPIC_MODEL: "claude-opus-5" }), true);
});

// --- the per-check fix affordance (spec §6.2) --------------------------------

test("a failing check's URL fix becomes a link", () => {
  const a = fixAction(check({
    name: "claude", ok: false, required: true,
    fix: {
      kind: "url",
      payload: "https://docs.claude.com/en/docs/claude-code/overview",
      label: "How to install Claude Code",
    },
  }));
  assert.deepEqual(a, {
    kind: "url",
    href: "https://docs.claude.com/en/docs/claude-code/overview",
    label: "How to install Claude Code",
  });
});

test("a failing check's command fix becomes copyable text", () => {
  const a = fixAction(check({
    name: "tmux", ok: false, required: false,
    fix: { kind: "command", payload: "brew install tmux", label: "Copy install command" },
  }));
  assert.deepEqual(a, {
    kind: "command", command: "brew install tmux", label: "Copy install command",
  });
});

test("a PASSING check offers no fix, even when one came down the wire", () => {
  // "Here is how to install claude" beside a green tick is noise. The backend
  // drops it too — this is the second of the two places that must agree.
  assert.equal(fixAction(check({
    ok: true, fix: { kind: "url", payload: "https://example.com", label: "x" },
  })), null);
});

test("a check with no fix renders nothing", () => {
  assert.equal(fixAction(check({ name: "database", ok: false })), null);
  assert.equal(fixAction(check({ name: "database", ok: false, fix: null })), null);
});

test("an UNKNOWN fix kind renders nothing rather than guessing", () => {
  // A newer backend adding a kind must not put a mystery control on the one
  // screen that has to work when everything else is broken.
  assert.equal(fixAction(check({
    ok: false, fix: { kind: "restart", payload: "whatever", label: "Do it" },
  })), null);
});

test("a url fix whose scheme is not http(s) never becomes an href", () => {
  // An unchecked scheme is a javascript:/data: sink one backend bug away.
  for (const payload of ["javascript:alert(1)", "data:text/html,<b>",
                         "file:///etc/passwd", "//evil.example.com"]) {
    assert.equal(
      fixAction(check({ ok: false, fix: { kind: "url", payload, label: "Open" } })),
      null, payload);
  }
});

test("an empty payload is not an affordance", () => {
  assert.equal(fixAction(check({
    ok: false, fix: { kind: "command", payload: "   ", label: "Copy" },
  })), null);
});

// --- a save the user's own shell will undo (spec §6.3) ----------------------

test("a value exported in the shell is flagged as shadowing a save", () => {
  // Precedence is real environment > config dir > $YURI_HOME/config/.env >
  // backend/.env. PUT writes the file AND os.environ, so the save works now
  // and silently reverts at the next start — while reporting "takes effect
  // straight away". This warning is all that stands between the user and that.
  const k = key({ set: true, source: SHELL_SOURCE, hint: "…9f31" });
  assert.equal(shadowedByShell(k), true);
  const warning = shellShadowWarning(k);
  assert.match(warning, /GEMINI_API_KEY/);
  assert.match(warning, /shell/);
  assert.match(warning, /next time Yuri starts/);
});

test("a value from a file Setup can write is not flagged", () => {
  for (const source of ["Setup", "~/Yuri/config/.env", "backend/.env",
                        "~/.config/yapcode/.env"]) {
    const k = key({ set: true, source });
    assert.equal(shadowedByShell(k), false, source);
    assert.equal(shellShadowWarning(k), "", source);
  }
});

test("an UNSET key is never flagged, whatever its source says", () => {
  // `source` reads "not set" then, and there is nothing for the shell to
  // shadow — a warning here would land on every empty field.
  assert.equal(shadowedByShell(key({ set: false, source: SHELL_SOURCE })), false);
  assert.equal(shellShadowWarning(key({ set: false, source: SHELL_SOURCE })), "");
});

// --- and the one case where that warning was itself the lie ----------------

test("a SECRET the Keychain will carry gets NO shell warning", () => {
  // The bug: both halves of the sentence are false for a secret in the desktop
  // app. The save does NOT take effect straight away (it goes to the Keychain
  // and nowhere else, which is why save() forces the "restart" effect), and
  // the exported value does NOT win again (servers.ts merges credentialsEnv()
  // last, over the shell env, on purpose). So the user was told to unset a
  // variable their other tools may need, to fix a problem that does not exist.
  //
  // Asserted as an ABSENCE deliberately: this is the fourth bug on this branch
  // of exactly this shape -- a UI string asserting something untrue -- and a
  // test that only checks the cases that already read correctly cannot catch
  // one. If the rule regresses to warning here, this line fails.
  const k = key({ secret: true, set: true, source: SHELL_SOURCE, hint: "…9f31" });
  assert.equal(saveTransport(k, true), "keychain");
  assert.equal(shellShadowWarning(k, true), "");
});

test("the shell warning stands wherever HTTP and the .env file are the store", () => {
  // The other three of the four combinations. Each one really does go over
  // PUT /yuri/config into the .env file that the shell outranks.
  const nonSecretWithBridge = key({ name: "ANTHROPIC_MODEL", secret: false, set: true,
                                    source: SHELL_SOURCE, hint: "claude-opus-5" });
  const nonSecretNoBridge = { ...nonSecretWithBridge };
  const secretNoBridge = key({ secret: true, set: true, source: SHELL_SOURCE, hint: "…9f31" });

  for (const [k, hasBridge, why] of [
    [nonSecretWithBridge, true, "a non-secret in the desktop app still goes over HTTP"],
    [nonSecretNoBridge, false, "a non-secret in a browser tab, likewise"],
    [secretNoBridge, false, "a secret in a browser tab has no Keychain to go to"],
  ] as [ManagedKey, boolean, string][]) {
    assert.equal(saveTransport(k, hasBridge), "http", why);
    const warning = shellShadowWarning(k, hasBridge);
    assert.match(warning, new RegExp(k.name), why);
    assert.match(warning, /next time Yuri starts/, why);
  }
});

test("the default is the browser's reading, so an un-passed bridge cannot silence it", () => {
  // shellShadowWarning(k) with no second argument must behave as the HTTP
  // transport: a call site that forgot to say must not accidentally suppress a
  // warning that is true.
  const k = key({ secret: true, set: true, source: SHELL_SOURCE, hint: "…9f31" });
  assert.match(shellShadowWarning(k), /next time Yuri starts/);
});

// --- a Keychain store this build cannot read (spike R1) --------------------

test("the unreadable-store banner promises what the code will actually do", () => {
  // It used to say "Re-enter them below", which main/credentials.ts refuses
  // outright -- the save threw, and its real remedy (delete credentials.enc)
  // was named nowhere in the UI.
  assert.match(UNREADABLE_STORE_BANNER, /cannot decrypt/i, "the true fact");
  assert.match(UNREADABLE_STORE_BANNER, /will not save/i, "the refusal, said up front");
  assert.match(UNREADABLE_STORE_BANNER, /discard/i, "the way through");
  assert.doesNotMatch(UNREADABLE_STORE_BANNER, /re-enter them below/i,
                      "the instruction the code refuses");
});

test("the discard confirmation says what is lost, not just yes/no", () => {
  assert.match(DISCARD_UNREADABLE_CONFIRM, /permanently/i);
  assert.match(DISCARD_UNREADABLE_CONFIRM, /deleted/i);
});

test("a blocked secret save names the control that unblocks it", () => {
  // Reachability is the requirement: no path may end in an error whose remedy
  // is not an action on this screen.
  const reason = secretSaveBlockedReason(true, ["GEMINI_API_KEY", "OPENAI_API_KEY"]);
  assert.match(reason, /GEMINI_API_KEY/);
  assert.match(reason, /OPENAI_API_KEY/);
  assert.ok(reason.includes(DISCARD_UNREADABLE_LABEL),
            "the reason must name the button, verbatim");
});

test("nothing is blocked when the store reads fine, or when no secret is pending", () => {
  // A non-secret still saves over HTTP with an unreadable Keychain store --
  // that store has nothing to do with the .env file -- so blocking the whole
  // Save button here would be its own lie.
  assert.equal(secretSaveBlockedReason(false, ["GEMINI_API_KEY"]), "");
  assert.equal(secretSaveBlockedReason(true, []), "");
  assert.equal(secretSaveBlockedReason(false, []), "");
});

// --- what a field shows when you come back --------------------------------

test("a saved NON-secret is pre-filled, so it does not look lost", () => {
  // The complaint this exists for: a value shown only as a greyed placeholder
  // reads as an empty field, as though the save never happened.
  const k = key({ name: "ANTHROPIC_MODEL", secret: false, set: true,
                  hint: "claude-opus-5", masked: false });
  assert.equal(fieldValue(k, {}), "claude-opus-5");
  assert.equal(fieldPlaceholder(k), "");
});

test("a MASKED value is never pre-filled, or the mask gets saved as the value", () => {
  // A secret's hint is "…9f31"; a non-secret URL's userinfo becomes "***".
  // Either one, pre-filled, would be written verbatim on the next save.
  const secret = key({ name: "GEMINI_API_KEY", secret: true, set: true,
                       hint: "…9f31", masked: true });
  assert.equal(fieldValue(secret, {}), "");
  assert.match(fieldPlaceholder(secret), /…9f31/);
  assert.match(fieldPlaceholder(secret), /leave blank to keep it/);

  const url = key({ name: "ANTHROPIC_BASE_URL", secret: false, set: true,
                    hint: "https://***@gw/v1", masked: true });
  assert.equal(fieldValue(url, {}), "",
    "a URL whose credentials were stripped is masked, non-secret or not");
});

test("an unset field says so, and shows nothing", () => {
  const k = key({ set: false, hint: "", masked: false });
  assert.equal(fieldValue(k, {}), "");
  assert.equal(fieldPlaceholder(k), "not set");
});

test("a set secret does not look like an unset one", () => {
  // Both fields are empty; only the placeholder distinguishes them.
  const set = key({ set: true, hint: "…9f31", masked: true });
  const unset = key({ set: false, hint: "", masked: false });
  assert.notEqual(fieldPlaceholder(set), fieldPlaceholder(unset));
});

test("what the user typed always wins over the saved value", () => {
  const k = key({ name: "ANTHROPIC_MODEL", secret: false, set: true,
                  hint: "claude-opus-5", masked: false });
  assert.equal(fieldValue(k, { ANTHROPIC_MODEL: "claude-sonnet-5" }), "claude-sonnet-5");
  // Including an explicit clear, which must not fall back to the saved value.
  assert.equal(fieldValue(k, { ANTHROPIC_MODEL: "" }), "");
});
