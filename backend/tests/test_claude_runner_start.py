"""Task 1 (review fix): the one line the whole task exists for had no test.

`SDKClaudeRunner.start()` passes `cli_path` into `sdk.ClaudeAgentOptions(...)`
via `**({"cli_path": p} if (p := agent_cli.resolve()) else {})` -- see
claude_runner.py and agent_cli.py's module docstring for why: the SDK ships
its own bundled `claude` and prefers it over PATH, so without this an
SDK-backed session and a CLI-backed session silently run different Claude
Code versions. Nothing exercised that line before this file: every test that
builds a real SDKClaudeRunner either constructs a `_Session` directly without
calling `.start()` (test_answer_claim.py), or drives a stub runner instead.
A future edit that reorders those kwargs or "simplifies" the walrus would
silently undo the whole task with nothing failing.

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

    async def test_cli_path_key_is_absent_entirely_when_nothing_resolves(self):
        # Not present-and-None -- omitted. cli_path=None and omitting the key
        # are equivalent to the SDK today, so this assertion is about the
        # code SAYING what it means, and about catching a future change that
        # always omits the key regardless of what agent_cli.resolve() found.
        captured = await self._start_and_capture_kwargs(None)
        self.assertNotIn("cli_path", captured)


if __name__ == "__main__":
    unittest.main()
