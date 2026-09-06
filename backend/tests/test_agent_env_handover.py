"""What travels from Yuri to an agent child, and what must not.

A tmux pane inherits the tmux SERVER's environment, and that server is
typically days old. Credentials were routed around that once (the login loop);
PATH was left behind and produced "/bin/sh: node: command not found" in a real
session, because the user's node is nvm-managed and its bin directory is
version-stamped -- it can never be a static fallback. These tests pin the
handover so the next variable nobody thought about is a decision rather than
another outage.

Nothing here prints a value. Assertions only.
"""
import os
import tempfile
import unittest

import config
import tmux_runner


class ShellVars(unittest.TestCase):
    def test_locale_and_proxy_travel_when_set(self):
        env = {"LANG": "en_GB.UTF-8", "HTTPS_PROXY": "http://proxy:3128"}
        got = config.agent_shell_env(getenv=env.get, exists=lambda _p: True)
        self.assertEqual(got, env)

    def test_blank_is_the_same_as_absent(self):
        # A blank would SHADOW whatever the child would otherwise have found.
        got = config.agent_shell_env(getenv={"LANG": "   "}.get, exists=lambda _p: True)
        self.assertEqual(got, {})

    def test_a_dead_ssh_socket_of_ours_never_replaces_a_live_one_of_theirs(self):
        env = {"SSH_AUTH_SOCK": "/tmp/ssh-stale/agent.1"}
        self.assertEqual(
            config.agent_shell_env(getenv=env.get, exists=lambda _p: False), {},
            "a socket that is not there must not be handed over")
        self.assertEqual(
            config.agent_shell_env(getenv=env.get, exists=lambda _p: True), env)

    def test_yuri_s_own_bookkeeping_never_travels(self):
        # The reason this is a list and not os.environ. VC_AUTH_TOKEN gates
        # Yuri's own API: an agent that could read it could authenticate as the
        # user. The YURI_*/YAPCODE_* vars are her internals.
        for name in ("VC_AUTH_TOKEN", "YURI_HOME", "YAPCODE_CONFIG_DIR",
                     "OPENCODE_SERVER_PASSWORD", "GEMINI_API_KEY"):
            self.assertNotIn(name, config.AGENT_SHELL_VARS, name)

    def test_the_three_deliberate_omissions_stay_omitted(self):
        # Each was found the hard way; see AGENT_SHELL_VARS' comment.
        for name in ("HOME", "NODE_OPTIONS", "TERM"):
            self.assertNotIn(name, config.AGENT_SHELL_VARS, name)

    def test_shell_vars_and_credentials_do_not_overlap(self):
        self.assertEqual(set(config.AGENT_SHELL_VARS) & set(config.AGENT_ENV_VARS), set())


class AgentEnvFile(unittest.TestCase):
    """The file a pane sources. Read back programmatically -- never printed."""

    def _write(self, environ):
        d = tempfile.mkdtemp()
        sess = type("S", (), {"ctrl": d})()
        old = dict(os.environ)
        try:
            os.environ.clear()
            os.environ.update(environ)
            tmux_runner.TmuxClaudeRunner._write_agent_env(
                tmux_runner.TmuxClaudeRunner(), sess)
        finally:
            os.environ.clear()
            os.environ.update(old)
        with open(os.path.join(d, "agent.env")) as f:
            return f.read()

    def test_path_is_prepended_not_replaced(self):
        # Replacing would fix node and could break something the tmux server
        # knew about that this process does not.
        body = self._write({"PATH": "/ours/bin"})
        self.assertIn("""PATH='/ours/bin'":$PATH\"""", body)

    def test_an_empty_path_writes_no_path_line(self):
        body = self._write({})
        self.assertNotIn("PATH=", body)

    def test_a_path_containing_a_space_survives_quoting(self):
        body = self._write({"PATH": "/Applications/Yuri OS.app/bin"})
        self.assertIn("'/Applications/Yuri OS.app/bin'", body)

    def test_the_file_is_owner_only(self):
        d = tempfile.mkdtemp()
        sess = type("S", (), {"ctrl": d})()
        tmux_runner.TmuxClaudeRunner._write_agent_env(
            tmux_runner.TmuxClaudeRunner(), sess)
        mode = os.stat(os.path.join(d, "agent.env")).st_mode & 0o777
        self.assertEqual(mode, 0o600, "it can hold a credential")


if __name__ == "__main__":
    unittest.main()
