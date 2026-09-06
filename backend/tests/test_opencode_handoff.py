import unittest

from yuri.providers.opencode import handoff


def s(sid, directory, updated, title="work"):
    return {"id": sid, "location": {"directory": directory},
            "time": {"updated": updated}, "title": title}


class Pick(unittest.TestCase):
    def test_one_match_is_taken(self):
        got = handoff.pick([s("a", "/w/app", 100)], "/w/app")
        self.assertEqual(got.session["id"], "a")
        self.assertEqual(got.ambiguous, [])

    def test_a_different_directory_is_not_a_match(self):
        got = handoff.pick([s("a", "/w/other", 100)], "/w/app")
        self.assertIsNone(got.session)
        self.assertIn("no OpenCode session", got.reason)

    def test_nothing_at_all(self):
        got = handoff.pick([], "/w/app")
        self.assertIsNone(got.session)
        self.assertIn("no OpenCode session", got.reason)

    def test_two_in_the_same_directory_adopts_NEITHER(self):
        # Guessing between two of the user's own sessions is exactly the
        # "putting her in charge" the provider's design refuses. Name them and
        # let the user choose.
        got = handoff.pick([s("a", "/w/app", 100, "api"), s("b", "/w/app", 200, "ui")], "/w/app")
        self.assertIsNone(got.session)
        self.assertEqual({x["id"] for x in got.ambiguous}, {"a", "b"})
        self.assertIn("more than one", got.reason)

    def test_a_match_elsewhere_does_not_make_it_ambiguous(self):
        got = handoff.pick([s("a", "/w/app", 100), s("b", "/w/other", 200)], "/w/app")
        self.assertEqual(got.session["id"], "a")
        self.assertEqual(got.ambiguous, [])

    def test_trailing_slashes_do_not_defeat_the_match(self):
        # `pwd` and the server can disagree about a trailing slash; a handoff
        # that fails for that reason would look like a broken integration.
        self.assertEqual(handoff.pick([s("a", "/w/app/", 100)], "/w/app").session["id"], "a")
        self.assertEqual(handoff.pick([s("a", "/w/app", 100)], "/w/app/").session["id"], "a")

    def test_a_session_with_no_directory_is_ignored_not_crashed_on(self):
        got = handoff.pick([{"id": "a"}, s("b", "/w/app", 100)], "/w/app")
        self.assertEqual(got.session["id"], "b")

    def test_a_missing_updated_time_sorts_last_rather_than_raising(self):
        got = handoff.pick([{"id": "a", "location": {"directory": "/w/app"}}], "/w/app")
        # Still the only match, so still taken.
        self.assertEqual(got.session["id"], "a")


if __name__ == "__main__":
    unittest.main()
