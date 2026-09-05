"""Turning history into memories (spec §5.3).

Read from the event LOG rather than a bus subscriber, which is the design: a
subscriber would have to infer "failed twice" from one event, meaning it holds
state, meaning it is wrong after a restart. Every test here therefore also
asserts idempotence somewhere — re-running must write nothing new.
"""
from __future__ import annotations

import datetime
import os
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from yuri.domain.event import EventType, YuriEvent  # noqa: E402
from yuri.domain.mission import Mission  # noqa: E402
from yuri.domain.project import Project  # noqa: E402
from yuri.home import Home  # noqa: E402
from yuri.services.rollup import (NOTHING, REVISIT_THRESHOLD,  # noqa: E402
                                  FakeSummariser, roll_all, roll_days,
                                  roll_observations)
from yuri.store.sqlite import SqliteStore  # noqa: E402


def yesterday(offset: int = 1) -> str:
    return (datetime.date.today() - datetime.timedelta(days=offset)).isoformat()


class Base(unittest.IsolatedAsyncioTestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.home = Home(os.path.join(self.tmp.name, "Yuri")).ensure()
        self.store = SqliteStore(self.home.db_path)
        self.store.migrate()
        self.addCleanup(self.tmp.cleanup)
        self.addCleanup(self.store.close)
        self.project = Project(slug="yuri-code", name="Yuri", root_path=self.tmp.name)
        self.store.projects.insert(self.project)

    def _journal(self, date: str, text: str) -> None:
        with open(os.path.join(self.home.journal_dir, f"{date}.md"), "w") as f:
            f.write(text)

    def _mission(self, title="the billing fix") -> Mission:
        m = Mission(project_id=self.project.id, title=title, created_by="test")
        self.store.missions.insert(m)
        return m

    def _event(self, type_, mission_id=None, **payload) -> YuriEvent:
        ev = YuriEvent.make(type_, mission_id=mission_id, payload=payload)
        self.store.events.insert(ev)
        return ev

    def _memories(self, kind):
        return [m.body for m in self.store.memories.current(kinds=[kind])]


class DayTests(Base):
    async def test_a_past_day_with_a_journal_gets_one_summary(self):
        self._journal(yesterday(), "# yesterday\n\n- 10:00  fixed the cycle detector\n")
        n = await roll_days(self.store, self.home, FakeSummariser("They fixed the detector."))
        self.assertEqual(n, 1)
        self.assertEqual(self._memories("day"), ["They fixed the detector."])

    async def test_the_summary_is_dated_the_day_it_describes(self):
        # The core tier picks the last three days by created_at; a summary
        # stamped today would sort wrong and crowd out the real recent ones.
        day = yesterday(3)
        self._journal(day, "- 10:00  something happened\n")
        await roll_days(self.store, self.home, FakeSummariser("They did something."))
        [m] = self.store.memories.current(kinds=["day"])
        self.assertEqual(m.created_at[:10], day)

    async def test_today_is_not_summarised(self):
        # The day is not over. The core tier carries today's journal until it
        # is.
        self._journal(datetime.date.today().isoformat(), "- 10:00  still going\n")
        self.assertEqual(await roll_days(self.store, self.home, FakeSummariser("x")), 0)

    async def test_a_day_that_already_has_a_summary_is_left_alone(self):
        self._journal(yesterday(), "- 10:00  a thing\n")
        s = FakeSummariser("They did a thing.")
        await roll_days(self.store, self.home, s)
        await roll_days(self.store, self.home, s)
        self.assertEqual(len(s.calls), 1, "the same day was summarised twice")
        self.assertEqual(len(self._memories("day")), 1)

    async def test_a_day_of_pure_bookkeeping_produces_no_memory(self):
        # Writing "nothing happened" would crowd her prompt with the absence
        # of news.
        self._journal(yesterday(), "- 10:00  mission 'x': paused -> cancelled\n")
        n = await roll_days(self.store, self.home, FakeSummariser(NOTHING))
        self.assertEqual(n, 0)
        self.assertEqual(self._memories("day"), [])

    async def test_a_summariser_failure_skips_that_day_and_retries_later(self):
        class Broken:
            async def summarise(self, text):
                raise RuntimeError("no key")

        self._journal(yesterday(), "- 10:00  a thing\n")
        self.assertEqual(await roll_days(self.store, self.home, Broken()), 0)
        # And the next run picks it up, because nothing was recorded.
        self.assertEqual(await roll_days(self.store, self.home, FakeSummariser("They did it.")), 1)

    async def test_the_summary_is_bounded(self):
        self._journal(yesterday(), "- 10:00  a thing\n")
        await roll_days(self.store, self.home, FakeSummariser("x" * 2000))
        [m] = self.store.memories.current(kinds=["day"])
        self.assertLessEqual(len(m.body), 400)

    async def test_it_reads_no_further_back_than_asked(self):
        for offset in range(1, 6):
            self._journal(yesterday(offset), f"- 10:00  day minus {offset}\n")
        n = await roll_days(self.store, self.home, FakeSummariser("A day."), back=2)
        self.assertEqual(n, 1, "back=2 should summarise at most 2 days, deduped to 1 body")

    async def test_an_empty_journal_is_not_summarised(self):
        self._journal(yesterday(), "   \n")
        self.assertEqual(await roll_days(self.store, self.home, FakeSummariser("x")), 0)

    async def test_no_journal_directory_at_all_is_not_an_error(self):
        import shutil
        shutil.rmtree(self.home.journal_dir)
        self.assertEqual(await roll_days(self.store, self.home, FakeSummariser("x")), 0)


class ObservationTests(Base):
    def test_a_check_that_failed_twice_becomes_one_observation(self):
        m = self._mission()
        for _ in range(2):
            self._event(EventType.VERIFICATION_FAILED, mission_id=m.id,
                        task_id="t1", title="Run the tests",
                        failed=[{"check": "tests_pass", "verdict": "fail", "detail": "2 failed"}])
        self.assertEqual(roll_observations(self.store), 1)
        [body] = self._memories("observation")
        self.assertIn("Run the tests", body)
        self.assertIn("tests_pass", body)

    def test_a_single_failure_produces_nothing(self):
        # "Twice" means twice; one failure is a Tuesday, not a pattern.
        m = self._mission()
        self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                    title="Run the tests",
                    failed=[{"check": "tests_pass", "verdict": "fail"}])
        self.assertEqual(roll_observations(self.store), 0)

    def test_its_subject_is_the_project_slug_not_the_mission_id(self):
        # The core tier and recall both filter by slug; an observation
        # subjected to a mission id would be findable only by someone who
        # already knew the id.
        m = self._mission()
        for _ in range(2):
            self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                        title="T", failed=[{"check": "tests_pass", "verdict": "fail"}])
        roll_observations(self.store)
        [row] = self.store.memories.current(kinds=["observation"])
        self.assertEqual(row.subject, "yuri-code")

    def test_a_check_that_could_not_run_is_its_own_observation(self):
        # Distinct from a failure, because the remedy is different: configure
        # the command, not fix the code.
        m = self._mission()
        self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                    title="Run the tests",
                    failed=[{"check": "tests_pass", "verdict": "unavailable",
                             "detail": "no test command configured"}])
        self.assertEqual(roll_observations(self.store), 1)
        [body] = self._memories("observation")
        self.assertIn("could not run", body)
        self.assertIn("no test command", body)

    def test_one_unavailable_is_enough(self):
        # Unlike a failure: a check that cannot run will never run, so waiting
        # for a second occurrence would just delay telling the user.
        m = self._mission()
        self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                    title="T", failed=[{"check": "typecheck_pass", "verdict": "unavailable"}])
        self.assertEqual(roll_observations(self.store), 1)

    def test_a_mission_picked_back_up_repeatedly_becomes_an_observation(self):
        m = self._mission("the flaky one")
        for _ in range(REVISIT_THRESHOLD):
            self._event(EventType.MISSION_STATUS_CHANGED, mission_id=m.id,
                        title=m.title, to="running")
        self.assertEqual(roll_observations(self.store), 1)
        self.assertIn("picked back up", self._memories("observation")[0])

    def test_below_the_threshold_produces_nothing(self):
        m = self._mission()
        for _ in range(REVISIT_THRESHOLD - 1):
            self._event(EventType.MISSION_STATUS_CHANGED, mission_id=m.id,
                        title=m.title, to="running")
        self.assertEqual(roll_observations(self.store), 0)

    def test_observations_are_marked_observed_and_never_stated(self):
        # The honesty rule as a test: she did not conclude this and the user
        # did not say it — it happened.
        m = self._mission()
        for _ in range(2):
            self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                        title="T", failed=[{"check": "tests_pass", "verdict": "fail"}])
        roll_observations(self.store)
        [row] = self.store.memories.current(kinds=["observation"])
        self.assertEqual((row.source, row.origin), ("observed", "mission"))

    def test_running_it_twice_writes_nothing_new(self):
        # Idempotence, which is what makes reading the whole log safe.
        m = self._mission()
        for _ in range(2):
            self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                        title="T", failed=[{"check": "tests_pass", "verdict": "fail"}])
        self.assertEqual(roll_observations(self.store), 1)
        self.assertEqual(roll_observations(self.store), 0)

    def test_an_event_with_no_mission_is_dropped_rather_than_misfiled(self):
        # No mission means no project means no subject, and a subject-less
        # observation could never be selected or recalled.
        for _ in range(2):
            self._event(EventType.VERIFICATION_FAILED, task_id="t1", title="T",
                        failed=[{"check": "tests_pass", "verdict": "fail"}])
        self.assertEqual(roll_observations(self.store), 0)

    def test_a_malformed_payload_is_skipped_not_fatal(self):
        m = self._mission()
        self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, failed="not a list")
        self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, failed=[None, {}])
        self.assertEqual(roll_observations(self.store), 0)


class RollAllTests(Base):
    async def test_it_runs_both_and_never_raises(self):
        self._journal(yesterday(), "- 10:00  a thing\n")
        m = self._mission()
        for _ in range(2):
            self._event(EventType.VERIFICATION_FAILED, mission_id=m.id, task_id="t1",
                        title="T", failed=[{"check": "tests_pass", "verdict": "fail"}])
        out = await roll_all(self.store, self.home, FakeSummariser("They did a thing."))
        self.assertEqual(out, {"days": 1, "observations": 1})

    async def test_a_broken_store_does_not_raise_into_startup(self):
        out = await roll_all(object(), self.home, FakeSummariser("x"))
        self.assertEqual(out, {"days": 0, "observations": 0})
