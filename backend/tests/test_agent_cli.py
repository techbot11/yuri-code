import subprocess
import unittest
from unittest import mock

import agent_cli


class ParseVersion(unittest.TestCase):
    def test_the_normal_output(self):
        self.assertEqual(agent_cli.parse_version("2.1.261 (Claude Code)\n"), "2.1.261")

    def test_a_bare_version(self):
        self.assertEqual(agent_cli.parse_version("2.1.150\n"), "2.1.150")

    def test_leading_noise_before_the_version(self):
        # A shell that prints a banner first must not defeat the parse.
        self.assertEqual(
            agent_cli.parse_version("nvm: using node 22\n2.1.261 (Claude Code)\n"), "2.1.261")

    def test_nothing_usable(self):
        for out in ("", "\n", "command not found", "Claude Code"):
            self.assertIsNone(agent_cli.parse_version(out), out)


class Resolve(unittest.TestCase):
    def test_uses_the_injected_lookup(self):
        self.assertEqual(agent_cli.resolve(which=lambda _n: "/opt/bin/claude"), "/opt/bin/claude")

    def test_absent_is_none_not_an_exception(self):
        # doctor already reports a missing claude as a required failure; this
        # must not raise on the way there.
        self.assertIsNone(agent_cli.resolve(which=lambda _n: None))


def _completed(stdout: str = "", stderr: str = "") -> subprocess.CompletedProcess:
    return subprocess.CompletedProcess(args=["claude", "--version"], returncode=0,
                                       stdout=stdout, stderr=stderr)


class Version(unittest.TestCase):
    """version()'s success path -- previously only its exception branch was
    covered, and only incidentally (a fake path that happens not to exist on
    disk rather than a deliberate assertion). agent_cli looks up
    `subprocess.run` as a module attribute inside the function body, so
    patching it here reaches the call made at run time."""

    def test_version_on_stdout(self):
        with mock.patch.object(agent_cli.subprocess, "run",
                               return_value=_completed(stdout="2.1.261 (Claude Code)\n")):
            self.assertEqual(agent_cli.version("/opt/bin/claude"), "2.1.261")

    def test_version_on_stderr_when_stdout_is_empty(self):
        # Some builds print --version to stderr; version() falls back to it.
        with mock.patch.object(agent_cli.subprocess, "run",
                               return_value=_completed(stdout="", stderr="2.1.150\n")):
            self.assertEqual(agent_cli.version("/opt/bin/claude"), "2.1.150")

    def test_successful_run_with_no_version_in_output_is_none(self):
        # A zero-exit run whose output has no parseable version must not
        # raise -- it is a "we cannot show a version" case, not a failure.
        with mock.patch.object(agent_cli.subprocess, "run",
                               return_value=_completed(stdout="command not found")):
            self.assertIsNone(agent_cli.version("/opt/bin/claude"))


class Describe(unittest.TestCase):
    def test_path_and_version_together(self):
        # Both, because a path alone cannot show skew and a version alone
        # cannot show WHICH binary produced it.
        self.assertEqual(agent_cli.describe("/opt/bin/claude", "2.1.261"),
                         "/opt/bin/claude (2.1.261)")

    def test_version_unknown_still_names_the_path(self):
        self.assertEqual(agent_cli.describe("/opt/bin/claude", None),
                         "/opt/bin/claude (version unknown)")

    def test_absent(self):
        self.assertEqual(agent_cli.describe(None, None),
                         "not on PATH — install Claude Code")


if __name__ == "__main__":
    unittest.main()
