import unittest

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
