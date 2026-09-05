"""One thing Yuri remembers (spec §3).

The validation here is load-bearing rather than defensive. Two rules in
particular:

  * `subject` is forced to match `kind`. The core tier selects preferences and
    facts under `"user"` and project facts BY SLUG, so a preference filed
    under a project would never be selected — a memory that exists and
    silently does nothing, which is worse than one that was refused.
  * `source` is a closed set of three, because her prompt renders each one
    differently. "You told me", "it happened" and "I think" must never be able
    to read alike, and a fourth value would render as one of them by accident.
"""
from __future__ import annotations

import re
from dataclasses import asdict, dataclass, field

from .ids import new_id, utcnow

KINDS: tuple[str, ...] = ("preference", "fact", "observation", "day", "project")
SOURCES: tuple[str, ...] = ("stated", "observed", "inferred")
ORIGINS: tuple[str, ...] = ("voice", "ui", "journal", "mission")

# One sentence. Bounded because every one of these can land in her prompt, and
# a 5,000-character "memory" is a document.
BODY_MAX = 500

USER = "user"
# Kinds whose subject is always the user. A slug on one of these is a filing
# error, and correcting it beats storing something unfindable.
USER_KINDS: frozenset[str] = frozenset({"preference", "fact", "day"})
# Kinds that MUST carry a project slug, for the same reason in reverse.
SLUG_KINDS: frozenset[str] = frozenset({"project", "observation"})

_SLUG_RE = re.compile(r"^[a-z0-9-]{1,64}$")


class InvalidMemory(ValueError):
    """Names the offending value, because a memory refused without saying why
    is a memory the caller will try to write again."""


@dataclass
class Memory:
    body: str
    kind: str
    subject: str = USER
    id: str = field(default_factory=new_id)
    source: str = "stated"
    origin: str = "voice"
    superseded_by: str | None = None
    pinned: bool = False
    # 768 float32 little-endian, or None until the background embedder gets to
    # it (spec §7.2) — a row is findable by the cheap path immediately and
    # semantically searchable a second later.
    embedding: bytes | None = None
    created_at: str = field(default_factory=utcnow)
    updated_at: str = field(default_factory=utcnow)

    def __post_init__(self) -> None:
        self.body = " ".join(str(self.body or "").split())[:BODY_MAX]
        if not self.body:
            raise InvalidMemory("a memory needs a body")
        for name, allowed in (("kind", KINDS), ("source", SOURCES), ("origin", ORIGINS)):
            value = getattr(self, name)
            if value not in allowed:
                raise InvalidMemory(f"unknown {name}: {value!r}; expected one of {list(allowed)}")
        self.subject = self._subject_for_kind()

    def _subject_for_kind(self) -> str:
        subject = str(self.subject or "").strip()
        if self.kind in USER_KINDS:
            # Corrected, not refused: a caller passing a slug for a preference
            # meant the preference, and the slug is meaningless for it.
            return USER
        if self.kind in SLUG_KINDS:
            if not subject or subject == USER:
                raise InvalidMemory(
                    f"a {self.kind!r} memory needs a project slug as its subject; "
                    "the core tier and recall both select these by slug")
            if not _SLUG_RE.match(subject):
                raise InvalidMemory(
                    f"{subject!r} is not a project slug (lowercase letters, digits, dashes)")
            return subject
        return subject or USER      # unreachable: every kind is in one set

    @property
    def is_current(self) -> bool:
        return self.superseded_by is None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, d: dict) -> "Memory":
        return cls(**{k: d[k] for k in cls.__dataclass_fields__ if k in d})
