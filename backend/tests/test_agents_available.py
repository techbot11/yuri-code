import unittest

import agents_available as aa


class Build(unittest.TestCase):
    def test_an_installed_enabled_agent_is_available(self):
        got = aa.build(enabled=("claude-code",),
                       found={"claude": "/opt/bin/claude"},
                       versions={"/opt/bin/claude": "2.1.261"})
        claude = next(a for a in got if a.name == "claude-code")
        self.assertTrue(claude.available)
        self.assertTrue(claude.enabled)
        self.assertIn("2.1.261", claude.detail)

    def test_a_missing_agent_is_offline_not_an_error(self):
        got = aa.build(enabled=("claude-code",), found={}, versions={})
        claude = next(a for a in got if a.name == "claude-code")
        self.assertFalse(claude.available)
        self.assertTrue(claude.enabled)
        # The wording matters: this is the string a user reads to understand
        # that nothing is broken, they simply have not installed it.
        self.assertIn("not installed", claude.detail)

    def test_an_agent_not_enabled_is_reported_but_flagged_disabled(self):
        # opencode installed but YURI_AGENTS does not ask for it: shown, so the
        # user can see it is there to turn on, but not claimed as in use.
        got = aa.build(enabled=("claude-code",),
                       found={"claude": "/c", "opencode": "/o"}, versions={})
        oc = next(a for a in got if a.name == "opencode")
        self.assertTrue(oc.available)
        self.assertFalse(oc.enabled)

    def test_every_known_agent_appears_regardless(self):
        # A registry, not a list of what happens to be installed: an agent
        # missing from the UI entirely cannot be discovered by the user.
        names = {a.name for a in aa.build(enabled=(), found={}, versions={})}
        self.assertEqual(names, {"claude-code", "opencode"})


class AnyAvailable(unittest.TestCase):
    def test_none_installed(self):
        self.assertFalse(
            aa.any_available(aa.build(enabled=("claude-code",), found={}, versions={})))

    def test_installed_but_not_enabled_is_not_usable(self):
        got = aa.build(enabled=("claude-code",), found={"opencode": "/o"}, versions={})
        # opencode is present but YURI_AGENTS does not use it, so she still has
        # no agent she can actually run.
        self.assertFalse(aa.any_available(got))

    def test_one_installed_and_enabled(self):
        got = aa.build(enabled=("claude-code",), found={"claude": "/c"}, versions={})
        self.assertTrue(aa.any_available(got))


if __name__ == "__main__":
    unittest.main()
