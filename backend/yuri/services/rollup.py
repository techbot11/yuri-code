"""Turning history into memories, in the background (spec §5.3).

Two unprompted paths, one module, because both are "read history, write
memories, idempotently":

  * a day's journal becomes one `day` summary;
  * the event log becomes `observed` memories — a check that failed twice, a
    check that could never run, a mission returned to again and again.

**Read from the log rather than from a bus subscriber**, and that is the
design rather than an accident. A subscriber would have to decide "failed the
same check twice" from a single event, which means holding state, which means
being wrong after a restart. Asking the whole history at once is stateless,
and re-running writes nothing new because an identical body is a no-op.

**Run at startup, never at connect.** Summarising is a 1–3s model call and
connect is exactly where a user would feel it.

Everything here is `observed`, never `stated`: it happened, she did not
conclude it and the user did not say it. That distinction is the whole point
of the `source` column.
"""
from __future__ import annotations

import datetime
import logging
import os
import re
from collections import Counter, defaultdict
from typing import Protocol

import httpx

from yuri.domain.event import EventType
from yuri.domain.memory import InvalidMemory, Memory

log = logging.getLogger("yuri.memory.rollup")

DAY_SUMMARY_MODEL = "gemini-2.5-flash"
DAY_SUMMARY_MAX = 400
DAY_SUMMARY_TIMEOUT_S = 30.0
# How far back to look. A first run on a long-lived home should not spend
# fourteen model calls, so this is also the bound on that.
ROLLUP_DAYS_BACK = 14
# Events scanned per rollup. Bounded for the same reason every other read in
# this codebase is.
EVENT_SCAN_MAX = 5000
# "Returned to again and again" needs a number. Three is the smallest that is
# not a coincidence.
REVISIT_THRESHOLD = 3

_URL = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"
_DATE_FILE = re.compile(r"^(\d{4}-\d{2}-\d{2})\.md$")

_PROMPT = (
    "This is one day from a log of what an assistant and its user did. Write at "
    "most two short sentences saying what actually happened that day, in plain "
    "prose, in the third person about the user (\"they\"). No lists, no markdown, "
    "no dates, no preamble. Mention what was worked on and anything that went "
    "wrong. If the day holds nothing but bookkeeping, reply with exactly: "
    "NOTHING WORTH KEEPING"
)
NOTHING = "NOTHING WORTH KEEPING"


class Summariser(Protocol):
    async def summarise(self, text: str) -> str: ...


class GeminiSummariser:
    """The same model and shape yuri/own/search.py uses."""

    def __init__(self, api_key: str | None = None):
        self._key = (api_key if api_key is not None else os.getenv("GEMINI_API_KEY", "")).strip()

    async def summarise(self, text: str) -> str:
        if not self._key:
            # Not an error: an installation with no key simply gets no day
            # summaries, and recall reads the raw journal instead.
            raise RuntimeError("GEMINI_API_KEY isn't set, so days cannot be summarised")
        body = {"contents": [{"parts": [{"text": text}]}],
                "systemInstruction": {"parts": [{"text": _PROMPT}]}}
        async with httpx.AsyncClient(timeout=DAY_SUMMARY_TIMEOUT_S) as client:
            r = await client.post(_URL.format(model=DAY_SUMMARY_MODEL),
                                  params={"key": self._key}, json=body)
        if r.status_code != 200:
            # The status only — an upstream body echoes the request, and the
            # request is the user's whole day.
            raise RuntimeError(f"the summariser answered {r.status_code}")
        data = r.json()
        parts = (data.get("candidates") or [{}])[0].get("content", {}).get("parts") or []
        return " ".join("".join(p.get("text", "") for p in parts).split())


class FakeSummariser:
    """A real implementation, not a mock."""

    def __init__(self, reply: str | None = None):
        self.reply = reply
        self.calls: list[str] = []

    async def summarise(self, text: str) -> str:
        self.calls.append(text)
        if self.reply is not None:
            return self.reply
        first = next((ln for ln in text.splitlines() if ln.strip().startswith("- ")), "")
        return f"They worked on things. {first.strip()[:120]}" if first else NOTHING


# --- days -------------------------------------------------------------------


def _past_days(journal_dir: str, back: int) -> list[tuple[str, str]]:
    """(date, path) for each past day's journal, newest first. TODAY IS
    EXCLUDED: the day is not over, and the core tier carries today's journal
    until it is."""
    if not os.path.isdir(journal_dir):
        return []
    today = datetime.date.today().isoformat()
    out = []
    for name in sorted(os.listdir(journal_dir), reverse=True):
        m = _DATE_FILE.match(name)
        if not m or m.group(1) >= today:
            continue
        out.append((m.group(1), os.path.join(journal_dir, name)))
        if len(out) >= back:
            break
    return out


def _already_summarised(store) -> set[str]:
    return {(m.created_at or "")[:10] for m in store.memories.current(kinds=["day"], limit=400)}


async def roll_days(store, home, summariser: Summariser,
                    back: int = ROLLUP_DAYS_BACK) -> int:
    """One `day` memory per past day that has a journal and no summary."""
    done = _already_summarised(store)
    written = 0
    for date, path in _past_days(home.journal_dir, back):
        if date in done:
            continue
        try:
            with open(path, encoding="utf-8") as f:
                raw = f.read()
        except OSError:
            log.warning("rollup: could not read %s", path)
            continue
        if not raw.strip():
            continue
        try:
            text = await summariser.summarise(raw)
        except Exception as exc:                          # noqa: BLE001
            # Skipped, not failed: the next startup retries, and a day with no
            # summary makes recall read the raw journal instead. Logged at
            # info because no key is a supported configuration.
            log.info("rollup: %s not summarised (%s)", date, exc)
            continue
        text = " ".join((text or "").split())
        if not text or text.upper().startswith(NOTHING):
            # A day of pure bookkeeping. Writing "nothing happened" as a
            # memory would crowd her prompt with the absence of news.
            continue
        try:
            m = Memory(body=text[:DAY_SUMMARY_MAX], kind="day",
                       source="observed", origin="journal")
        except InvalidMemory:
            continue
        # The date the day WAS, not today: the core tier picks the last three
        # days by created_at, and a summary stamped today would sort wrong.
        m.created_at = f"{date}T23:59:00+00:00"
        m.updated_at = m.created_at
        if store.memories.by_body(m.body) is not None:
            continue
        store.memories.insert(m)
        written += 1
    return written


# --- observations -----------------------------------------------------------


def _slug_for_mission(store, mission_id: str | None, cache: dict) -> str | None:
    """A mission's project slug, which is an observation's subject.

    The mission ID goes in the BODY instead: the core tier and recall both
    filter by slug, so an observation subjected to a mission id would be
    findable only by someone who already knew the id.
    """
    if not mission_id:
        return None
    if mission_id in cache:
        return cache[mission_id]
    slug = None
    m = store.missions.get(mission_id)
    if m is not None:
        p = store.projects.get(m.project_id)
        slug = p.slug if p else None
    cache[mission_id] = slug
    return slug


def roll_observations(store, limit: int = EVENT_SCAN_MAX) -> int:
    """Derive `observed` memories from the event log. Idempotent.

    The three patterns are a closed set on purpose. Each one is a fact with a
    remedy the user can act on, and none of them is a conclusion about the
    user — which is what keeps this path safe to run unprompted.
    """
    events = store.events.list(limit=limit)
    cache: dict[str, str | None] = {}
    written = 0

    # 1. the same check failing twice for one task, and 2. a check that could
    #    never run. Different remedies, so different memories.
    failures: dict[tuple[str, str], list] = defaultdict(list)
    unavailable: dict[tuple[str, str], list] = {}
    revisits: Counter = Counter()
    titles: dict[str, str] = {}

    for ev in events:
        p = ev.payload or {}
        if ev.type == EventType.VERIFICATION_FAILED:
            title = str(p.get("title") or "a task")
            for r in (p.get("failed") or []):
                if not isinstance(r, dict):
                    continue
                check = str(r.get("check") or "")
                if not check:
                    continue
                key = (str(p.get("task_id") or title), check)
                titles[key[0]] = title
                if r.get("verdict") == "unavailable":
                    unavailable.setdefault(key, [ev, r])
                else:
                    failures[key].append(ev)
        elif ev.type == EventType.MISSION_STATUS_CHANGED and p.get("to") == "running":
            if ev.mission_id:
                revisits[ev.mission_id] += 1
                titles[ev.mission_id] = str(p.get("title") or "a mission")

    def write(body: str, mission_id: str | None) -> None:
        nonlocal written
        slug = _slug_for_mission(store, mission_id, cache)
        if not slug:
            # No project means no subject, and a project-less observation
            # could never be selected or recalled. Dropped rather than filed
            # somewhere it would not be found.
            return
        if store.memories.by_body(body) is not None:
            return
        try:
            m = Memory(body=body, kind="observation", subject=slug,
                       source="observed", origin="mission")
        except InvalidMemory:
            return
        store.memories.insert(m)
        written += 1

    for (task_id, check), evs in failures.items():
        if len(evs) < 2:
            continue                      # "twice" means twice
        title = titles.get(task_id, "a task")
        write(f'"{title}" failed {check} {len(evs)} times', evs[-1].mission_id)

    for (task_id, check), (ev, result) in unavailable.items():
        title = titles.get(task_id, "a task")
        detail = " ".join(str(result.get("detail") or "").split())[:120]
        write(f'{check} could not run for "{title}"' + (f": {detail}" if detail else ""),
              ev.mission_id)

    for mission_id, count in revisits.items():
        if count < REVISIT_THRESHOLD:
            continue
        write(f'"{titles.get(mission_id, "a mission")}" was picked back up {count} times',
              mission_id)

    return written


async def roll_all(store, home, summariser: Summariser) -> dict:
    """Both paths. Never raises: this runs on a background task at startup,
    and a rollup that fails must not stop the backend."""
    out = {"days": 0, "observations": 0}
    try:
        out["days"] = await roll_days(store, home, summariser)
    except Exception:                                      # noqa: BLE001
        log.exception("rollup: summarising days failed")
    try:
        out["observations"] = roll_observations(store)
    except Exception:                                      # noqa: BLE001
        log.exception("rollup: deriving observations failed")
    return out
