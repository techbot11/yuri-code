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


class TclTk(unittest.TestCase):
    """PRUNE_SEGMENTS claimed to remove the GUI toolkit and did not: the
    directories carry their version in the name (tcl8.6, tk8.6, itcl4.2.4) so a
    literal segment match never saw them, and 7.8 MB of Tcl/Tk was shipping in
    an app whose only UI is the renderer."""

    def test_versioned_tk_directories_are_pruned(self):
        for rel in ("lib/tcl8.6", "lib/tk8.6", "lib/itcl4.2.4", "lib/itk3.4"):
            self.assertTrue(payload.should_prune(rel), rel)

    def test_the_versioned_rule_cannot_reach_real_packages(self):
        # It is anchored to "one of these words then only digits and dots", so
        # it can never behave like the substring rule the tests above reject.
        for rel in ("lib/python3.14/site-packages/tenacity",
                    "lib/python3.14/site-packages/typing_extensions",
                    "lib/python3.14/site-packages/tqdm",
                    "lib/python3.14/site-packages/itsdangerous"):
            self.assertFalse(payload.should_prune(rel), rel)

    def test_the_toolkit_s_loose_files_are_pruned(self):
        for rel in ("lib/libtcl8.6.dylib", "lib/libtk8.6.dylib",
                    "lib/python3.14/lib-dynload/_tkinter.cpython-314-darwin.so"):
            self.assertTrue(payload.should_prune_file(rel), rel)

    def test_the_file_rule_spares_what_the_app_links_against(self):
        # The single most destructive mistake available here: deleting the
        # interpreter's own shared library, or a native wheel's extension.
        for rel in ("lib/libpython3.14.dylib", "bin/python3",
                    "lib/python3.14/site-packages/_cffi_backend.abi3.so",
                    "lib/python3.14/lib-dynload/_socket.cpython-314-darwin.so"):
            self.assertFalse(payload.should_prune_file(rel), rel)


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
