---
description: Hand this OpenCode session to Yuri so you can keep going by voice
---

Register the session running in this directory with the local Yuri backend.
`$1` is an optional session id, needed only when more than one session is open
in this directory.

Backend response:

!`bash "$HOME/.config/opencode/commands/voice-handoff-bin/handoff.sh" $1`

Using the JSON response above, tell the user in one or two short sentences:

- If it has a `message`: relay it. Say plainly that their terminal keeps
  working — unlike the Claude Code handoff there is nothing to exit and
  nothing to attach, because both they and Yuri are talking to the same
  OpenCode server. Name the session she took, so a wrong one is obvious.
- If it names more than one session: list the titles and ids and ask which,
  then tell them to run `/voice-handoff <session-id>`.
- If it has an `error`: relay it plainly. The usual causes are the Yuri
  backend not running, or `YURI_URL`/`YURI_TOKEN` needing to be set for a
  remote backend.

Do not run any other commands.
