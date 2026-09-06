import os, sys, unittest
sys.path.insert(0, os.path.abspath("backend"))
import config


class KeychainSources(unittest.TestCase):
    """The desktop app injects Keychain credentials as real env vars. Without a
    manifest naming them they fall through to _source_of's "process
    environment" default, and Setup then tells the user to unset a shell export
    that does not exist -- the same lie that already happened for the launcher
    and that _load_env_file's stamping exists to prevent."""

    def test_named_variables_are_labelled_as_the_keychain(self):
        env = {"YURI_KEYCHAIN_KEYS": "GEMINI_API_KEY,OPENAI_API_KEY",
               "GEMINI_API_KEY": "g", "OPENAI_API_KEY": "o"}
        self.assertEqual(config.keychain_sources(env.get),
                         {"GEMINI_API_KEY": config.KEYCHAIN_SOURCE,
                          "OPENAI_API_KEY": config.KEYCHAIN_SOURCE})

    def test_an_unnamed_variable_is_left_alone(self):
        # A shell export must still read as a shell export, or the warning that
        # DOES matter stops firing.
        env = {"YURI_KEYCHAIN_KEYS": "GEMINI_API_KEY",
               "GEMINI_API_KEY": "g", "ANTHROPIC_API_KEY": "shell"}
        self.assertNotIn("ANTHROPIC_API_KEY", config.keychain_sources(env.get))

    def test_a_named_but_empty_variable_is_skipped(self):
        env = {"YURI_KEYCHAIN_KEYS": "GEMINI_API_KEY", "GEMINI_API_KEY": "  "}
        self.assertEqual(config.keychain_sources(env.get), {})

    def test_no_manifest_labels_nothing(self):
        self.assertEqual(config.keychain_sources({}.get), {})
        self.assertEqual(config.keychain_sources({"YURI_KEYCHAIN_KEYS": ""}.get), {})

    def test_whitespace_and_trailing_commas_in_the_manifest(self):
        env = {"YURI_KEYCHAIN_KEYS": " GEMINI_API_KEY , ,", "GEMINI_API_KEY": "g"}
        self.assertEqual(config.keychain_sources(env.get),
                         {"GEMINI_API_KEY": config.KEYCHAIN_SOURCE})

    def test_the_label_is_not_the_one_that_triggers_the_shell_warning(self):
        # frontend/lib/setup.ts's SHELL_SOURCE. If these ever coincide the
        # warning fires on keychain-backed keys again.
        self.assertNotEqual(config.KEYCHAIN_SOURCE, "process environment")


if __name__ == "__main__":
    unittest.main()
