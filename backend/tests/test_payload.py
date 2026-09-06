import unittest

from yuri import payload


class ShouldPrune(unittest.TestCase):
    def test_prunes_the_big_four(self):
        for rel in ("lib/python3.14/site-packages/claude_agent_sdk/_bundled",
                    "lib/python3.14/site-packages/pip",
                    "lib/python3.14/site-packages/setuptools",
                    "lib/python3.14/__pycache__"):
            self.assertTrue(payload.should_prune(rel), rel)

    def test_prunes_nested_pycache(self):
        self.assertTrue(payload.should_prune("lib/python3.14/site-packages/anyio/__pycache__"))

    def test_keeps_what_the_app_imports(self):
        # R2 confirmed every native import works; pruning any of these breaks
        # the backend at startup, which is the failure this test prevents.
        for rel in ("lib/python3.14/site-packages/pydantic_core",
                    "lib/python3.14/site-packages/rpds",
                    "lib/python3.14/site-packages/charset_normalizer",
                    "lib/python3.14/site-packages/websockets",
                    "lib/python3.14/site-packages/_cffi_backend.abi3.so",
                    "lib/python3.14/site-packages/claude_agent_sdk/_internal",
                    "bin/python3.14"):
            self.assertFalse(payload.should_prune(rel), rel)

    def test_matches_whole_segments_not_substrings(self):
        # The bug this catches: a substring rule for "test" prunes pytest_asyncio
        # and "latest", and a substring rule for "pip" prunes "pipeline".
        for rel in ("lib/python3.14/site-packages/pytest_asyncio",
                    "lib/python3.14/site-packages/latest_thing",
                    "lib/python3.14/site-packages/pipeline",
                    "lib/python3.14/site-packages/setuptools_scm_helper"):
            self.assertFalse(payload.should_prune(rel), rel)

    def test_a_segment_named_tests_is_pruned(self):
        self.assertTrue(payload.should_prune("lib/python3.14/site-packages/anyio/tests"))


class Budget(unittest.TestCase):
    def test_the_budget_is_a_real_ceiling_not_a_placeholder(self):
        # 355 MB is the UNtrimmed measurement from spike R2. A budget at or
        # above it would gate nothing.
        self.assertLess(payload.MAX_PAYLOAD_BYTES, 355 * 1024 * 1024)

    def test_within_budget(self):
        self.assertTrue(payload.within_budget(payload.MAX_PAYLOAD_BYTES))
        self.assertFalse(payload.within_budget(payload.MAX_PAYLOAD_BYTES + 1))

    def test_human_is_readable(self):
        self.assertEqual(payload.human(1024 * 1024), "1.0 MB")
        self.assertEqual(payload.human(157 * 1024 * 1024), "157.0 MB")


if __name__ == "__main__":
    unittest.main()
