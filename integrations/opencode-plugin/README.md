# Yuri — OpenCode integration

Bring the [Yuri](../../) voice agent into an [OpenCode](https://opencode.ai) session
you're running in your terminal, so you can **keep going by voice while your terminal
keeps working exactly as before**.

## What's different from the Claude Code plugin

`integrations/claude-code-plugin` hands over a Claude Code session by *reopening* it
in a hooked tmux pane, because a Claude Code process is something Yuri knows nothing
about until told, and two processes must not write one session — so the handoff ends
with a Ctrl-D and a `tmux attach`.

OpenCode is a **server**: every session lives server-side, enumerable at
`GET /api/session`, and Yuri's OpenCode provider already talks to it directly. That
means:

- **There is no attach step.** The server is already the single writer. Yuri talks to
  the same session your terminal is talking to; nothing needs reopening, nothing needs
  exiting.
- **Your terminal is unaffected.** Run `/voice-handoff`, keep typing in the OpenCode
  TUI exactly as before — the handoff is pure consent, not a handover.

## What's in here

- **`commands/voice-handoff.md`** — an OpenCode custom command (`/voice-handoff`) that
  registers the session running in the current directory with the local Yuri backend.
- **`bin/handoff.sh`** — the script the command runs. Always exits 0 and prints JSON,
  so a stopped backend produces a sentence rather than a broken command.

There is deliberately **no `.opencode/plugins/` entry here**. This is not an
npm-installable OpenCode plugin. OpenCode's JS plugin API (`.opencode/plugins/`,
whose hooks receive `project`, `directory`, `worktree`, `client` and `$`) documents no
session id either, and gives a plugin no way to register a slash command — so a
markdown command plus a script is the mechanism that actually exists for this.

## Install

```bash
mkdir -p ~/.config/opencode/commands/voice-handoff-bin
cp integrations/opencode-plugin/commands/voice-handoff.md ~/.config/opencode/commands/
cp integrations/opencode-plugin/bin/handoff.sh ~/.config/opencode/commands/voice-handoff-bin/
chmod +x ~/.config/opencode/commands/voice-handoff-bin/handoff.sh
```

(Or `.opencode/commands/` instead of `~/.config/opencode/commands/`, for a per-project
install — OpenCode supports both.)

The command's `!`bash ...`` line hard-codes the path this install step puts the script
at, because OpenCode commands are plain markdown with no documented equivalent of
Claude Code's `${CLAUDE_PLUGIN_ROOT}`. If OpenCode later exposes a plugin-root
variable to commands, use it and update the command file — for now, the install path
above is what the command actually looks for.

## Uninstall

Remove exactly the two paths Install creates above (swap in `.opencode/commands/` if
that's where you installed):

```bash
rm ~/.config/opencode/commands/voice-handoff.md
rm -r ~/.config/opencode/commands/voice-handoff-bin
```

## Configure (only for a remote / tunneled backend)

On the same machine, no config is needed — it talks to `http://localhost:8000` and
localhost needs no token (Yuri's own dev instance runs on a different port; set
`YURI_URL` to match whatever your backend actually listens on). To reach a remote
backend, set:

```bash
export YURI_URL="https://your-backend"      # e.g. a tunnel URL
export YURI_TOKEN="your VC_AUTH_TOKEN"        # required when the backend has one set
```

`YAPCODE_URL` / `YAPCODE_TOKEN` are still honoured as fallbacks — the Claude Code
plugin documents those older names and hasn't been renamed yet.

## Use it

```bash
opencode                # your normal OpenCode session
> …work normally, typing…
> /voice-handoff        # voice switches on — keep typing here, nothing to exit
```

## The honest limitation

OpenCode gives a command no session id — no documented way for `/voice-handoff` to
say *which* session it's running in. So the session is resolved from the working
directory: Yuri looks at every session on the server whose `location.directory`
matches this one.

- **One match**: adopted, and Yuri says which session she took, by title, so a wrong
  resolution is visible immediately.
- **No match**: reported plainly — nothing to adopt.
- **More than one match**: adopted **neither**. Guessing between two of your own
  sessions is exactly the kind of takeover Yuri's OpenCode provider is designed to
  refuse (she never adopts OpenCode work she didn't start). You'll be told the titles
  and ids of both; run `/voice-handoff <session-id>` to pick one.
