# SDD ledger — plan: docs/superpowers/plans/2026-09-05-yuri-os-config-and-setup.md

Spec: docs/superpowers/specs/2026-09-05-yuri-desktop-app-design.md (§6 is this plan's scope) — read, reachable.
Worktree: .claude/worktrees/yuri-os-config-setup on feat/yuri-os-config-setup, branched from local HEAD f358087.
Baseline verified before Task 1: backend 1561 OK, frontend 296 pass / 0 fail.

Note on the branch point: EnterWorktree's default baseRef is `fresh` (origin/main),
which would have branched from bd9e21c and lost the six local commits that carry the
spec and this plan. The worktree was created from local HEAD instead.

## Pre-flight scan

### Pairs sharing a file or an interface

| Tasks | What one produces / the other consumes | Found |
|---|---|---|
| T2 & T3 | both modify `backend/config.py` | No conflict. T2 edits the loader calls (lines 61-64); T3 appends after `summary()`. T3 consumes `_source_of`, which T2 does not touch. |
| T1 → T4 | `Check(name, ok, detail, required)`, `REQUIRED_CHECKS` | Match. T4's route reads exactly those four fields and computes `all(c.ok for c in rows if c.required)`. |
| T3 → T4 | `managed_status()`, `MANAGED_KEYS[].name/.effect`, `masked_hint` | Match. T4's `known[n].effect` resolves against T3's `ManagedKey.effect`. |
| T4 → T5 | the three JSON shapes | Match. `/doctor` → 4 fields = `DoctorCheck`; `/config` → the 8 keys `managed_status()` emits = `ManagedKey`; `PUT` → `{written, effects, path}` and T5 consumes `effects`. |
| T5 → T6 | `blocking`, `canSave`, `effectsSentence`, `pendingChanges`, both types | Match, all exported by T5. |
| T5 → T7 | `gateOpen`, `DoctorCheck` | Match. |
| T6 → T7 | `SetupPanel({ onPass })` | Match. T7 passes `onPass`; T6's signature accepts it as optional. |
| T6 → T7 | `.setup-view` CSS class | T6 defines it in `globals.css`, T7 uses it. Ordering dependency only — T6 runs first. |
| T6 & T7 | frontend shell files | Different files (`Rail.tsx` + `app/setup/page.tsx` vs `app/layout.tsx`). No overlap. |

### Each task against its own text

| Task | Verdict |
|---|---|
| T1 | Agrees. Tests are added inside the existing `class Doctor`, whose `setUp` already pins `OPENCODE_URL` and `YURI_AGENTS`, so the new tests inherit that pinning. The exit-code change (from every check to required-only) is stated in the task text rather than smuggled. |
| T2 | **DEFECT — see Ruling 1.** The test patches `_BACKEND_ENV` and then calls `importlib.reload(cfg)`; reload re-executes the module top level, which recomputes `_BACKEND_ENV` from `__file__` and discards the patch. The planted file would never be read, so the test could pass without the fix. |
| T3 | **DEFECT — see Ruling 2.** `test_a_short_secret_is_masked_entirely` asserts `masked_hint("") == "set"`, but the specified implementation returns `""` for an empty value. Its first assertion is also incoherent (`short[-4:] if len(short) > 7 else "\x00"`) and tests nothing. |
| T4 | **DEFECT — see Ruling 3.** The harness does `from main import app`, which boots the real application and its container. Every other API test in this repo builds its own `FastAPI()` with `build_router(guard)` and `yapp.test_container(...)` — see `tests/test_phase7_api.py:29-55`. |
| T5 | Agrees. Checked each fixture against each assertion: `SECRET`'s last four are `4f2a`; the non-secret compare-against-hint case, the secret always-a-change case, and the clear-a-set-key case are mutually consistent with the specified `pendingChanges`. |
| T6 | Agrees, after the token fix already applied to the plan (`--good`, not `--ok` — verified present at `globals.css:12`). Uses `yput`, which `lib/api.ts:78` exports. |
| T7 | Agrees. Gate stays shut on `null` and on `[]`, and `/setup` is exempted so a failing check cannot make its own fix unreachable. |

### Rulings made before execution

**Ruling 1 — T2's precedence test is rewritten to exercise the loader directly, not via `importlib.reload`.**
Why: `_BACKEND_ENV` is computed from `__file__` at import, so no patch survives a reload; the test as written cannot fail. Calling `config._load_env_file` twice in the same order `config.py` does tests the actual precedence sequence with no reload at all, and one additional test asserts the call sites use `override=False` by planting a value and checking it is not clobbered. Cost if wrong: the test covers the loader's semantics rather than module-import behaviour, so a future change that reorders the two call sites in `config.py` would not be caught by it — mitigated by the second test, which pins the observable outcome.

**Ruling 2 — T3's short-secret test is split, and the empty case asserts `""`.**
Why: the specified `masked_hint` returns `""` for an empty value (there is nothing to hint at) and `"set"` for a short one (a hint would reveal most of it). Both behaviours are right; the test conflated them. Cost if wrong: none — this corrects a test to match a specification the same task defines.

**Ruling 3 — T4's harness follows `tests/test_phase7_api.py:29-55`: its own `FastAPI()` + `build_router(guard)` + `yapp.test_container(...)`.**
Why: `from main import app` boots the real container against the developer's real `YURI_HOME`, which is how this session already contaminated the user's data once today. The repo has an established isolated-app pattern and the plan should not invent a second one. Cost if wrong: the test exercises the router rather than the fully-assembled app, so a defect in `main.py`'s wiring of these three routes specifically would not be caught. Accepted: the other API tests make the same trade, and Task 6's browser verification exercises the real app end to end.

The three rulings are applied to the plan file itself, so each implementer's brief carries the corrected text rather than a correction bolted on beside it.

## Progress

### Rulings from Task 1's report (found during execution, not the pre-flight scan)

**Ruling 4 — `yuri doctor`'s exit code goes back to "non-zero if ANY check fails". `REQUIRED_CHECKS` drives only the API's `ok` field and the UI gate.**
Why: the implementer had to weaken three pre-existing tests (allowed roots, and two opencode cases) from exit 1 to exit 0. Tests needing to be weakened is the smell that says the change was wrong, and it was: the spec (§6.2) defines "required" only for *what gates the app*, and says nothing about the CLI. Making the CLI agree with the gate silently turned `yuri doctor` from "tell me everything that is wrong" into "tell me if Yuri is dead", which is a worse tool and a regression for anyone scripting it. Cost if wrong: the CLI and the API now disagree about the word "ok" — mitigated by the API field being named `ok` in a payload that also carries every check's own `required` flag, so a reader can see both.

**Ruling 5 — `PUT /yuri/config` must also set `os.environ` for the keys it writes.**
Why: this is load-bearing and the plan is broken without it. `voice_keys_found()` and `allowed_project_roots()` both read `os.getenv` live, from the *process* environment. Writing a `.env` file does not change the running uvicorn's environment, so every "takes effect straight away" label would be false, and — worse — Task 6's save-then-re-check flow and Task 7's gate dismissal could never succeed: the re-read of `/yuri/doctor` would still report "voice keys: none found" after a key was saved. Cost if wrong: the process environment and the file can diverge if a write half-fails; mitigated by setting `os.environ` only after `setup_store.write` returns.

**Ruling 6 — `ALLOWED_PROJECT_ROOTS` becomes a managed key (non-secret, effect `now`).**
Why: Task 1's own message text says "fix ALLOWED_PROJECT_ROOTS in Setup", but the plan's `MANAGED_KEYS` did not include it, so the message pointed at a screen that could not set it. It is read live by `allowed_project_roots()`, so with Ruling 5 its effect is genuinely `now`. It is also the setting that decides where Yuri may work at all, which makes it the one most worth having in the UI. Cost if wrong: a user can now widen Yuri's filesystem sandbox from the UI rather than a file — that is a real increase in what the UI can do, but it is the same value the same user could already set in `.env`, and `resolve_within_roots` still gates every session on it.

**Ruling 7 — `REQUIRED_CHECKS` keeps all four members; the SPEC sentence was the loose one and has been corrected.**
Why: the task reviewer flagged real drift — spec §6.2 said "Required means: `claude` present, and at least one voice key configured" (two checks) while the plan specifies four (`home`, `database`, `claude`, `voice keys`). The four-member set is the correct one: a failed `home` or `database` check means Yuri has no storage at all, so gating on them is strictly right, and the spec sentence was naming the interesting cases rather than enumerating. Corrected the spec rather than narrowing the code, and spelled out there why `tmux` and `opencode` are excluded — Task 4 builds the UI gate on this membership, so the authority document had to stop contradicting it. Cost if wrong: the gate blocks on two conditions the spec did not originally name; both are conditions under which nothing works anyway.

Task 1: fix round 1/5 (1 addressed, 0 open — doctor exit code restored to ANY-failure; commits 7f400c6..e88dcb7)
Task 1: minor (deferred): doctor.py:1-2 module docstring still says "exit 0 when everything required is present", which now reads as REQUIRED_CHECKS rather than "every check" — a reader could re-introduce the bug Ruling 4 reverted.
Task 1: complete (commits ec4c8a4..e88dcb7, review clean — spec ✅, quality approved, 1 minor deferred)
Task 2: complete (commits 04bf984..2349977, review clean — spec ✅, quality approved, 0 minors)
  Reviewer confirmed each new test would fail against a revert, which was this task's whole risk.
  Its ⚠️ (does Electron actually inject the env?) is sub-project 2's, not a gap here.
Task 3: complete (commits 2349977..9c74ef0, review clean — spec ✅, quality approved, 2 minors deferred)
  Reviewer independently verified the implementer's claim that no existing test asserted the old
  missing_key_detail wording. It holds.
Task 3: minor (deferred): backend/main.py:124 startup log still says 'Fix: run `yapcode config`',
  the same removed workflow missing_key_detail stopped pointing at. Belongs to the rename
  sub-project (spec §7.1 prose), not to this plan — but it is now the only place giving that advice.
Task 3: minor (deferred): config.py managed_status() has a redundant ternary — masked_hint("")
  already returns "", so `if raw else ""` is dead. Harmless.

**Ruling 8 — a non-secret value that carries credentials in a URL must have them masked.**
Why: the reviewer flagged that `masked_hint(secret=False)` returns `ANTHROPIC_BASE_URL` in full, so `https://user:token@gateway` is returned by `GET /yuri/config` verbatim. That directly violates this plan's binding constraint ("a secret value is never returned"), so it is not out of scope even though the brief sanctioned it. Keeping the key non-secret is right — its value is what makes the field usable — so the fix is targeted: strip a URL's `user:pass@` userinfo in `masked_hint`. Cost if wrong: a user who legitimately wants to see the userinfo they typed cannot; they can retype it, and the alternative leaks a credential to anything that can read the response.

**Ruling 9 — the same URL-userinfo exposure in `GET /yuri/doctor`'s opencode detail is parked, not fixed here.**
Why: `doctor.py` puts `config.OPENCODE_URL` in its detail text, so a password embedded there would be returned. It is pre-existing CLI behaviour that this plan only newly exposes over loopback HTTP, and fixing it properly means sanitising every URL the doctor prints — a wider change than this task, with its own test surface. Cost if wrong: a user who puts a password in `OPENCODE_URL` rather than `OPENCODE_SERVER_PASSWORD` has it visible in the Setup screen's checks list. Recorded for the final review to triage.

Task 4: fix round 1/5 dispatched — 5 Important, 2 Minor promoted (see below)
Task 4: fix round 1/5 (7 addressed, 1 new open — env_files_checked() omits the third .env source the
  same fix added; commits 7cf7fff..4506dc5)
Task 4: fix round 2/5 (1 addressed, 0 open; commits 4506dc5..0e388ef)
  Re-reviewer independently verified the guard test ties the reported location count to the actual
  number of _load_env_file call sites (via inspect.getsource), and would fail against pre-fix code.
Task 4: minor (deferred): config.py env_files_checked() says "not found" for the Homebrew entry and
  "not present" for the other two — pre-existing wording inconsistency, now in one string together.
Task 4: complete (commits 9c74ef0..0e388ef, review clean after 2 fix rounds — spec ✅, quality
  approved, 3 minors deferred, 2 parked by ruling)
Task 5: complete (commits 0e388ef..4648e1b, review clean — spec ✅, quality approved, 2 minors)

**Ruling 10 — the masked hint is a PLACEHOLDER only, never a field value. Carried into Task 6 as a bound.**
Why: the reviewer spotted that Ruling 8's URL masking interacts with `pendingChanges`, which compares a
non-secret's typed value against `hint`. For `ANTHROPIC_BASE_URL` the hint is now masked
(`https://***@gw`), so a UI that pre-filled the input with the hint would write the literal `***` on
save. Task 6's brief already binds `value={draft[k.name] ?? ""}` and uses the hint only as
`placeholder`, so the corruption path does not exist today — but nothing enforces it, and it is a
one-character edit away. Recorded as an explicit constraint in Task 6's dispatch. Cost if wrong: a
user with credentials in their base URL cannot see the full value in the field, only the masked
placeholder — which is the same trade every secret field already makes, and the alternative is
returning the credential to the browser.
Task 5: minor (deferred): the effectLabel test uses loose regexes (/restart/i) that would pass many
  wrong wordings. Brief-prescribed, not the implementer's choice.
Task 6: fix round 1/5 (2 addressed, 0 open; commits d1c6783..ecd72ae)
Task 6: complete (commits 4648e1b..ecd72ae, review clean — spec ✅, quality approved)
  Environment fix by the controller, not a code finding: frontend/node_modules was symlinked into
  the main repo, which Turbopack refuses ("points out of the filesystem root"), so `next build`
  could not run at all. Replaced with a real `npm ci` in the worktree; build now compiles with
  /setup in the route table. The implementer diagnosed this correctly rather than assuming its own
  work was broken.
Task 7: fix round 1/5 (1 addressed, 0 open; commits 8af2563..fcadb65)
  The implementer also spotted, unprompted, that SetupGate's inline onPass arrow would feed
  SetupPanel.load's new dependency array and cause avoidable refetches, and memoized it. The
  re-reviewer confirmed the memoization is real (closes only over setDismissed) and that no
  render loop is possible.
Task 7: complete (commits ecd72ae..fcadb65, review clean — spec ✅, quality approved, 1 minor)
Task 7: minor (deferred): SetupGate's boot state uses the same .empty class and near-identical text
  as ordinary "nothing here" empty views, so it reads as distinct only by its sentence. Matches the
  app's existing convention across ~15 call sites.

All seven tasks complete. Dispatching the whole-branch review.

## Whole-branch review — findings must be fixed first

**Ruling 11 — Ruling 9 is REVERSED. The doctor's URL userinfo is sanitised before merge.**
Why: the final reviewer is right and I was wrong. Ruling 9 parked the `OPENCODE_URL` exposure on the
grounds that sanitising every URL the doctor prints was too wide for that task. But Ruling 8 — made
later, in this same branch — built `config._strip_url_userinfo` for exactly this problem. What is
left is four f-string call sites in `_opencode_status` and one test. Parking it ships two adjacent
code paths that disagree about whether a URL credential may cross the HTTP boundary, and the plan's
binding rule says one of them is wrong. Cost if wrong: none I can see; the doctor's detail still
names the host and port, which is what the check is for.

**Ruling 12 — Ruling 6 stands, but its recorded cost was wrong and is corrected here.**
Why: Ruling 6 said making `ALLOWED_PROJECT_ROOTS` manageable was "the same value the same user could
already set in `.env`". The reviewer correctly points out that is a different threat model: widening
the sandbox used to need write access to a 0600 file, and now needs one HTTP request that — per the
review's Critical 2 — any localhost-origin page in the user's browser can make. The setting stays
managed, because the doctor's own message points users at Setup for it, but it is the strongest
single reason to tighten the origin check on the config routes, which is now in the fix wave.

Deferred-minor triage from the final review: minors 1 and 2 are must-fix (the doctor docstring
contradicts main()'s own comment and is the misconception Ruling 4 reverted; main.py:124 recommends a
command that now edits the lowest-precedence file). Minors 3, 4, 5 ship as-is. Minor 6 is revisited
as part of Critical 1.

Controller doc fix, not dispatched: spec §6.4 listed ALLOWED_PROJECT_ROOTS in the restart group while
Ruling 6 declares it effect="now". The code is right; corrected the spec, per the convention
Ruling 7 set.

**Critical 1 is the finding my own deferred verification should have caught.** Task 7's Step 4
required confirming in a browser that `/` shows "Before Yuri can start". I told the implementer to
skip it because I would run it myself, and then dispatched the final review before doing so. The
reviewer found it by reading Stage's `panelOpen = pathname !== "/"` against `page.tsx` returning
null. Verification I defer is verification I may not do.

Final review: 2 Critical + 6 Important + 7 minor → ONE fix wave (commits fcadb65..98c2946,
  backend 1613→1640, frontend 307→317). Scoped re-review: all 15 dispatched findings ADDRESSED,
  both security fixes sound (Critical 2 survived every bypass the reviewer constructed, including
  the proxy same-site path). THREE new Important defects introduced by the wave itself.

**Ruling 13 — I am dispatching a second, tightly-scoped fix rather than parking three known defects.**
Why: the skill's "no second fix wave" exists to stop per-finding fixer waves that cost more than the
tasks did. That is not this. The three residuals are load-bearing, each has an exact file and line,
and two of them are regressions this wave caused rather than pre-existing debt:
  - `run-network.sh` searches only `backend/.env` and `$YAPCODE_CONFIG_DIR/.env`, but the wizard now
    writes `VC_AUTH_TOKEN` to `$YURI_HOME/config/.env` — so network/phone mode hard-fails on a fresh
    clone and tells the user to edit a file nothing writes.
  - `bin/yapcode`'s `load_env` exports every line before spawning the backend, so `config.py` skips
    the file for those keys and never stamps `ENV_SOURCES`; `_source_of` therefore returns "process
    environment" for EVERY set key, and the new shell-shadow warning fires on all of them with
    advice that is both false and unactionable. This wave turned a directionally-true warning into a
    plainly false one.
  - the mobile `.setup-gate` override sits in a media block at globals.css:2811 while the base rule
    is at :4619 — identical specificity, later wins, so the override is dead and the gate clips on a
    phone, which is exactly what its own comment says it prevents.
Cost if wrong: one more review cycle's time. Shipping instead would mean a broken network mode and a
false warning shown to every user of the documented launcher.

## Controller browser verification (the part I had reserved and nearly skipped)

Isolated stack: scratch YURI_HOME + scratch YAPCODE_CONFIG_DIR, backend on 8166, frontend BUILT
with BACKEND_URL=8166 (not merely started with it). backend/.env is a symlink to the developer's
real config, which made `voice keys` pass and hid the gate — so the SYMLINK was moved aside for the
test (never the target) and restored afterwards, verified intact.

- **Critical 1 fixed.** On `/`: title "Before Yuri can start", `.setup-gate` has `inVpanel: false`,
  `opacity: 1`, `pointerEvents: auto`, width 1224px in a `56px 1224px` shell grid, no horizontal
  overflow. `dockPresent: false` — the talk button that could not work is absent rather than
  disabled, exactly as the implementer predicted when choosing option (a).
- **Three-state styling reads at a glance.** `voice keys` danger (required), `allowed roots` warn
  plus "Optional — she works without it.", the rest good. Banner: "One thing is stopping her:
  voice keys." — only the required failure counts.
- **Critical 3 (the untested cascade fix) verified at 375x812.** `max-height: none`,
  `overflow-y: visible`, `gateIsInnerScroller: false`, page scrolls normally, no horizontal
  overflow. The override applies now; before the move the base rule at :4619 won.
- **Critical 2 verified live on all three routes.** No `Origin` (the legitimate proxy path):
  GET 200, PUT 200. `Origin: http://localhost:9999`: PUT 403, GET /config 403, GET /doctor 403.
  `Origin: http://192.168.1.50:3000`: PUT 403. The CSRF vector is closed on reads as well as writes.
- **Write lands correctly.** `-rw-------` at the scratch config dir; the developer's ~/Yuri/config
  never created.
- **Full round trip.** Typed a Gemini key, saved, and the gate dismissed itself with no reload —
  dock and orb returned. `GET /yuri/config` then contains ZERO occurrences of the raw key and
  reports `hint='…9f31' source='Setup' effect=now`; the doctor flips to `ok: True`.
- **Ruling 13's provenance fix confirmed in the UI**: the model field reads "from Setup", not
  "process environment", so the shell-shadow warning does not fire spuriously.

Teardown: both scratch servers stopped, scratch home and config removed, the 8166-pointed
frontend/.next removed, backend/.env symlink restored and its target verified readable.
Note: `backend/.venv` shows as untracked in this worktree (a symlink I created during setup; the
repo ignores `.venv/` as a directory, which a symlink does not match). It must not be committed.
