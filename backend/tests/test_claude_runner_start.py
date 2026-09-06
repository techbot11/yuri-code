"""Task 1 (review fix): the one line the whole task exists for had no test.

`SDKClaudeRunner.start()` passes `cli_path` into `sdk.ClaudeAgentOptions(...)`
via `agent_cli.resolve()` -- see claude_runner.py and agent_cli.py's module
docstring for why: the SDK ships its own bundled `claude` and prefers it over
PATH, so without this an SDK-backed session and a CLI-backed session silently
run different Claude Code versions. Nothing exercised that line before this
file: every test that builds a real SDKClaudeRunner either constructs a
`_Session` directly without calling `.start()` (test_answer_claim.py), or
drives a stub runner instead. A future edit that reorders those kwargs would
silently undo the whole task with nothing failing.

Task 7 (review fix): `StartPreflightsMissingClaude` below covers the other
half -- what happens when nothing resolves at all. Before that fix, "nothing
resolves" meant `cli_path` was silently omitted and the SDK's own exception
took over, which main.py's blanket `except Exception` turns into a generic
"failed unexpectedly" that discards the actionable detail. Now `start()`
raises the same ValueError shape tmux_runner's `_preflight` already raises,
so the message reaches the user by the same soft-error route.

This monkeypatches `claude_runner.sdk.ClaudeAgentOptions` and
`claude_runner.sdk.ClaudeSDKClient` to record what start() actually builds,
without standing up a real SDK connection.

    python -m unittest discover -s backend/tests
"""
import os
import sys
import unittest
from unittest import mock

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

import claude_runner  # noqa: E402
import tmux_runner  # noqa: E402
from claude_runner import SDKClaudeRunner  # noqa: E402


class _FakeSDKClient:
    """Stands in for sdk.ClaudeSDKClient: records the options it was built
    with and offers a no-op async connect(), so start() can run to
    completion without a real subprocess or transport."""

    def __init__(self, options):
        self.options = options

    async def connect(self):
        return None


class StartPassesCliPath(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        # Real cwd validation is orthogonal to what this test pins; the
        # existing tmux harness patches the same seam the same way.
        self.patches = [
            mock.patch.object(claude_runner.config, "resolve_within_roots", lambda p: p),
            mock.patch.object(claude_runner.sdk, "ClaudeSDKClient", _FakeSDKClient),
        ]
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])

    async def _start_and_capture_kwargs(self, resolved_path):
        captured = {}

        def fake_options(**kwargs):
            captured.update(kwargs)
            return kwargs  # start() only threads this into ClaudeSDKClient(), which is faked too

        with mock.patch.object(claude_runner.sdk, "ClaudeAgentOptions", fake_options), \
             mock.patch.object(claude_runner.agent_cli, "resolve", lambda: resolved_path):
            runner = SDKClaudeRunner(default_model="opus")
            await runner.start("/tmp", model="opus", mode="default")
        return captured

    async def test_cli_path_present_and_equal_to_the_resolved_path_when_found(self):
        captured = await self._start_and_capture_kwargs("/opt/bin/claude")
        self.assertIn("cli_path", captured)
        self.assertEqual(captured["cli_path"], "/opt/bin/claude")

    async def test_nothing_resolving_raises_instead_of_silently_omitting_cli_path(self):
        # Superseded by the Task 7 preflight: "nothing resolves" used to mean
        # cli_path was silently omitted and the SDK's own (swallowed) error
        # took over. Now it must fail loudly, before ever reaching the SDK.
        with self.assertRaises(ValueError):
            await self._start_and_capture_kwargs(None)


class StartPreflightsMissingClaude(unittest.IsolatedAsyncioTestCase):
    """Task 7 review fix: with backend="sdk" and no `claude` on PATH, start()
    must raise the same actionable ValueError tmux_runner's `_preflight`
    raises, rather than letting the SDK's own exception fall through to
    main.py's blanket `except Exception` (which discards str(exc) in favor of
    a generic "failed unexpectedly")."""

    def setUp(self):
        self.patches = [
            mock.patch.object(claude_runner.config, "resolve_within_roots", lambda p: p),
        ]
        for p in self.patches:
            p.start()
        self.addCleanup(lambda: [p.stop() for p in self.patches])

    async def test_raises_valueerror_naming_claude_and_the_install_command(self):
        with mock.patch.object(claude_runner.agent_cli, "resolve", lambda: None):
            runner = SDKClaudeRunner()
            with self.assertRaises(ValueError) as cm:
                await runner.start("/tmp")
        msg = str(cm.exception)
        self.assertIn("claude", msg)
        self.assertIn("install", msg.lower())

    async def test_the_sdk_is_never_reached_when_preflight_fails(self):
        # A silent failure hides behind the SDK's own exception only if the
        # SDK gets called at all -- pin that the preflight raises first.
        with mock.patch.object(claude_runner.agent_cli, "resolve", lambda: None), \
             mock.patch.object(claude_runner.sdk, "ClaudeAgentOptions",
                               mock.Mock(side_effect=AssertionError(
                                   "the SDK must not be reached when preflight fails"))):
            runner = SDKClaudeRunner()
            with self.assertRaises(ValueError):
                await runner.start("/tmp")

    async def test_message_matches_tmux_runners_preflight_word_for_word(self):
        # One wording for one problem: both backends must tell the user
        # exactly the same thing when `claude` is missing, or the two
        # messages can silently drift apart from each other.
        tmux = tmux_runner.TmuxClaudeRunner()
        with mock.patch.object(tmux_runner.shutil, "which",
                               lambda n: "/usr/bin/tmux" if n == "tmux" else None):
            with self.assertRaises(ValueError) as tmux_exc:
                tmux._preflight("/tmp")

        with mock.patch.object(claude_runner.agent_cli, "resolve", lambda: None):
            runner = SDKClaudeRunner()
            with self.assertRaises(ValueError) as sdk_exc:
                await runner.start("/tmp")

        self.assertEqual(str(tmux_exc.exception), str(sdk_exc.exception))


if __name__ == "__main__":
    unittest.main()
