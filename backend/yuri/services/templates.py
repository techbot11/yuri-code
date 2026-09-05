"""The user's own workflow templates (a plan shape they can edit).

Built-in templates are git-tracked JSON in `yuri/workflows/templates`. This
service never touches them: a `git pull` would clobber an edit, and an app
that rewrites its own source is an app whose diffs lie. A user template lives
in `~/Yuri/templates/<name>.json` and overrides a built-in one BY NAME;
deleting it restores the default. That is the same builtin/user pattern the
roster uses, including the way back.

**Validation is the existing `loader.validate`**, not a second copy. A save
runs the identical check the loader runs at startup, so a template that saves
is a template that will still load — and there is exactly one place that
knows what a dependency cycle is.
"""
from __future__ import annotations

import json
import logging
import os
import re

from yuri.workflows.loader import (Template, TemplateError, _template_from_dict,
                                   load_templates, validate)

log = logging.getLogger("yuri.templates")

# A template name becomes a filename, so it must survive a path: no slashes,
# no dots, no traversal.
NAME_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")


class TemplateStore:
    """The merged view, and the only writer of the user directory."""

    def __init__(self, user_dir: str):
        self.user_dir = user_dir

    # --- reading ----------------------------------------------------------

    def all(self) -> dict[str, Template]:
        """Built-ins overlaid with the user's. Validated, so what this returns
        is what can actually run."""
        return load_templates(user_dir=self.user_dir)

    def builtin_names(self) -> set[str]:
        return set(load_templates())

    def custom_names(self) -> set[str]:
        if not os.path.isdir(self.user_dir):
            return set()
        return {f[:-len(".json")] for f in os.listdir(self.user_dir) if f.endswith(".json")}

    def path_for(self, name: str) -> str:
        if not NAME_RE.match(name or ""):
            raise TemplateError(
                f"{name!r} is not a usable template name (lowercase letters, digits and "
                "dashes; it becomes a filename)")
        return os.path.join(self.user_dir, f"{name}.json")

    # --- writing ----------------------------------------------------------

    def save(self, name: str, data: dict) -> Template:
        """Validate, then write. Nothing is written if validation fails.

        The name in the PATH wins over any `name` in the body: a body that
        renamed itself would write one file and override a different template,
        which is the kind of surprise that is very hard to see afterwards.
        """
        path = self.path_for(name)
        body = dict(data or {})
        body["name"] = name
        try:
            template = _template_from_dict(body)
        except (TemplateError, TypeError, ValueError, KeyError) as exc:
            raise TemplateError(f"{name}: {exc}") from exc
        # The SAME check the loader runs at startup: unknown role, unknown
        # kind, a depends_on naming a task that is not here, duplicate ids, a
        # cycle (it names the members), the task cap, an unknown verification.
        validate(template)

        os.makedirs(self.user_dir, exist_ok=True)
        tmp = path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(body, f, indent=2)
            f.write("\n")
        # Atomic, so a crash mid-write cannot leave a file that fails to parse
        # at the next startup — which would take the whole template set with
        # it, since load_templates validates them all.
        os.replace(tmp, path)
        log.info("templates: saved %s", path)
        return template

    def remove(self, name: str) -> dict:
        """Delete the user's version. Returns what happened.

        A name that also exists as a built-in comes BACK as the default —
        that is the reset. A name that was only ever the user's is gone.
        """
        path = self.path_for(name)
        existed = os.path.exists(path)
        if existed:
            os.remove(path)
        builtin = name in self.builtin_names()
        return {"removed": existed, "reverted_to_default": existed and builtin,
                "still_exists": builtin}
