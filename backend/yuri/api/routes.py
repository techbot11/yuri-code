"""HTTP surface of the Yuri domain (spec §5.8). Routes validate, call a
service, and shape the response — no orchestration here. Built by
build_router(require_auth) so main.py's auth dependency applies to every route
without a circular import.

The two /events endpoints are the one remaining place that reads a repo
(`container().store.events`) directly: the event log has no service in front of
it — the EventBus is the write side — and adding one whose entire body proxies
`store.events.list` would put a layer in the way without owning any behavior.
Every other route goes through a service."""
from __future__ import annotations

import asyncio
import datetime
import json
import os
from dataclasses import replace
from typing import Callable

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.responses import StreamingResponse

import config
from yuri import doctor, setup_store
from yuri.app import container, last_spoke_at, narration_mode, set_narration_mode
from yuri.domain.memory import InvalidMemory, Memory
from yuri.domain.mission import InvalidTransition
from yuri.domain.specialist import ROLE_PREFERENCE, ROLES, TASK_CAPABILITIES
from yuri.domain.task import TASK_KINDS, InvalidTaskTransition
from yuri.domain.workflow import InvalidWorkflowTransition
from yuri.mcp import config as mcp_config
from yuri.mcp.manager import FAILED_VERDICT, probe
from yuri.services.missions import MissionInUse
from yuri.services.roster import DuplicateSpecialist, NoSpecialist, SpecialistInUse
from yuri.workflows.loader import (MAX_TASKS_PER_WORKFLOW, VERIFY_NAMES,
                                   TemplateError)
from yuri.narration.policy import MODES
from .schemas import (AssignBody, ConfigUpdate, McpEnabled, McpServerBody,
                      MemoryBody, MemorySearch, NarrationUpdate, ProjectCreate,
                      SpecialistBody, SupersedeBody, WorkflowBody)

ACTIVE = ("running", "waiting_for_approval", "paused", "queued")

# A caller-supplied `limit` must never translate into an unbounded read of the
# event log (state store or SSE replay) — clamp both endpoints that accept one.
EVENTS_LIMIT_MAX = 1000

# Today's journal in her prompt. Small: the core tier carries what she
# REMEMBERS, and this only has to carry what just happened.
JOURNAL_TODAY_MAX = 400


def _clamp_limit(limit: int) -> int:
    return max(1, min(limit, EVENTS_LIMIT_MAX))


def _by(request: Request) -> str:
    return "ui" if request.headers.get("origin") else "api"


async def require_strict_origin(request: Request) -> None:
    """Extra gate for the Setup routes, ON TOP OF the router's require_auth.

    require_auth judges an Origin with `config.origin_allowed`, whose default
    regex admits loopback and every private-LAN address on ANY port — so
    before this branch existed, "some other page on some other local port"
    was an acceptable caller of every route. That was survivable while no
    endpoint could write a credential. PUT /yuri/config can: it persists into
    the `.env` read at every boot, so `{"ANTHROPIC_BASE_URL": "https://attacker/"}`
    makes the next agent session hand over the user's real Anthropic
    credential, and `{"ALLOWED_PROJECT_ROOTS": "/"}` widens the filesystem
    sandbox immediately (effect "now") and permanently.

    So here: no Origin at all, or an Origin in the exact
    `config.ALLOWED_ORIGINS` list. The LAN regex is not consulted — see
    `config.exact_origin_allowed` for why that costs no legitimate caller
    anything. Composes with require_auth rather than replacing it: the token /
    loopback decision is still that function's, and this only narrows which
    browser origins reach these three routes.

    An absent Origin is treated as absent the same way require_auth treats it
    (`if origin and ...`): page JS cannot set or blank the Origin header — it
    is a forbidden header — so "no Origin" is proof of a non-browser or
    proxied caller, not something a hostile page can arrange.
    """
    origin = request.headers.get("origin")
    if origin and not config.exact_origin_allowed(origin):
        # Names no value and no key: this fires before the body is read.
        raise HTTPException(status_code=403,
                            detail="origin not allowed for a setup endpoint")


# Applied to GET /yuri/doctor and GET/PUT /yuri/config. Named so a test can
# assert the three routes carry it, rather than trusting it stayed attached.
SETUP_ROUTE_GUARD = Depends(require_strict_origin)


def build_router(require_auth: Callable) -> APIRouter:
    r = APIRouter(prefix="/yuri", dependencies=[Depends(require_auth)])

    # --- context ------------------------------------------------------------
    @r.get("/context")
    async def context():
        c = container()
        health = await c.registry.health_all()
        missions = [m for m in c.missions.list() if m.status in ACTIVE][:20]
        projects = {p.id: p.name for p in c.projects.registered()}
        # Ordered as she would experience it (spec §5): the time, then who the
        # user is, then her day, then — last, and only if any — what is
        # running. The block used to lead with the work, which is a large part
        # of why work was all she talked about.
        return {"home": c.home.path,
                "now": datetime.datetime.now().astimezone().strftime("%A %d %B, %H:%M"),
                "last_spoke_at": last_spoke_at(),
                # The core tier (spec §4.1): pinned, then every preference
                # (exempt from the budget), then facts, then the projects with
                # live work, then the last three days. Bounded, and it SAYS
                # what it left out.
                #
                # This replaces `memory_user` — the tail of a markdown file,
                # which dropped the OLDEST facts mid-line and said nothing
                # about it.
                "memory_core": c.memories.core_block(_active_slugs()),
                # Today's journal STAYS, at a fifth of its old cap.
                #
                # An earlier version of this change removed it, on the grounds
                # that recall could reach it. That was wrong and a test caught
                # it: `recall` searches MEMORIES, and today deliberately has
                # no `day` summary (the day is not over), so today's activity
                # would have been invisible to her — a regression from what
                # she has now, dressed up as an improvement.
                #
                # 400 rather than 2000: on a real day the 2000 cap was already
                # truncating, and what she needs is the last few things that
                # happened, not a fifth of her prompt spent on a log.
                "journal_today": c.journal.read_today_personal(cap=JOURNAL_TODAY_MAX),
                "active_missions": [{"id": m.id, "title": m.title, "goal": m.goal, "status": m.status,
                                     "project": projects.get(m.project_id)} for m in missions],
                "agents": [{"id": p.id, "name": p.name, **health[p.id].to_dict()} for p in c.registry.all()],
                "narration_mode": narration_mode()}

    # --- narration ------------------------------------------------------------
    @r.get("/narration")
    async def get_narration():
        return {"mode": narration_mode(), "modes": list(MODES)}

    @r.put("/narration")
    async def put_narration(body: NarrationUpdate):
        try:
            return {"mode": set_narration_mode(body.mode)}
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    # --- projects -----------------------------------------------------------
    @r.get("/projects")
    async def list_projects():
        return container().projects.list()

    @r.post("/projects", status_code=201)
    async def create_project(body: ProjectCreate):
        try:
            return container().projects.register(body.path, body.name, body.default_agent).to_dict()
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.get("/projects/{project_id}")
    async def get_project(project_id: str):
        try:
            return container().projects.get(project_id).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @r.put("/projects/{project_id}/verify")
    async def set_project_verify(project_id: str, body: dict):
        """Set the commands verification runs for this project.

        Body: {"tests": "...", "typecheck": "..."} — either key may be omitted
        or empty to unset it. Without this a project cannot answer tests_pass
        at all, because verification refuses to guess a command.
        """
        try:
            return container().projects.set_verify(project_id, body).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    # --- agents -------------------------------------------------------------
    @r.get("/agents")
    async def list_agents():
        c = container()
        health = await c.registry.health_all()
        live = c.sessions.live_rows()
        return {"agents": [{"id": p.id, "name": p.name, **health[p.id].to_dict(),
                            "capabilities": p.capabilities().to_dict(),
                            "active_sessions": sum(1 for s in live if s.agent_id == p.id)}
                           for p in c.registry.all()]}

    @r.get("/agents/{agent_id}/health")
    async def agent_health(agent_id: str):
        try:
            p = container().registry.get(agent_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return (await p.health()).to_dict()

    # --- missions -----------------------------------------------------------
    @r.get("/missions")
    async def list_missions(status: str | None = None):
        return {"missions": [m.to_dict() for m in container().missions.list(status=status)]}

    @r.get("/missions/{mission_id}")
    async def get_mission(mission_id: str):
        try:
            return container().missions.detail(mission_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    async def _transition(mission_id: str, action: str, request: Request):
        c = container()
        try:
            fn = getattr(c.missions, action)
            return (await fn(mission_id, by=_by(request))).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except InvalidTransition as exc:
            raise HTTPException(409, str(exc)) from exc

    @r.post("/missions/{mission_id}/pause")
    async def pause(mission_id: str, request: Request):
        return await _transition(mission_id, "pause", request)

    @r.post("/missions/{mission_id}/resume")
    async def resume(mission_id: str, request: Request):
        return await _transition(mission_id, "resume", request)

    @r.post("/missions/{mission_id}/cancel")
    async def cancel(mission_id: str, request: Request):
        return await _transition(mission_id, "cancel", request)

    @r.delete("/missions/{mission_id}")
    async def delete_mission(mission_id: str, request: Request):
        """Permanently remove a mission. 409 while it still has live sessions —
        cancel it first, which stops its agents."""
        try:
            await container().missions.delete(mission_id, by=_by(request))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except MissionInUse as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"deleted": mission_id}

    # --- sessions -----------------------------------------------------------
    @r.get("/sessions")
    async def list_sessions():
        return {"sessions": container().sessions.list()}

    @r.get("/sessions/{session_id}")
    async def get_session(session_id: str):
        try:
            return container().sessions.get(session_id).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @r.post("/sessions/{session_id}/interrupt")
    async def interrupt(session_id: str):
        try:
            return await container().sessions.interrupt(session_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    # --- approvals ----------------------------------------------------------
    @r.get("/approvals")
    async def list_approvals(status: str | None = None):
        return {"approvals": [a.to_dict() for a in container().approvals.list(status=status)]}

    async def _decide(approval_id: str, decision: str, request: Request):
        # Forwarding lives in SessionService.answer_approval, which also
        # advances the session row and the mission — this route only maps the
        # errors (spec §5.8: routes validate and call a service).
        try:
            return container().sessions.answer_approval(approval_id, decision, by=_by(request))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(409, str(exc)) from exc

    @r.post("/approvals/{approval_id}/approve")
    async def approve(approval_id: str, request: Request):
        return await _decide(approval_id, "allowed", request)

    @r.post("/approvals/{approval_id}/deny")
    async def deny(approval_id: str, request: Request):
        return await _decide(approval_id, "denied", request)

    # --- the roster (spec §14.2) --------------------------------------------
    #
    # The RESOURCE is `specialists` even though the UI calls them agents:
    # /yuri/agents is already the provider list, and reusing that path would
    # break the Agents view and the registry it reads.
    @r.get("/specialists")
    async def list_specialists(include_archived: bool = False):
        return {"specialists": [s.to_dict()
                                for s in container().roster.list(include_archived)]}

    @r.post("/specialists", status_code=201)
    async def create_specialist(body: SpecialistBody):
        try:
            return container().roster.create(
                **{k: v for k, v in body.model_dump().items() if v is not None}).to_dict()
        except DuplicateSpecialist as exc:
            # A conflict, not a malformed request: the name or its short form
            # is taken, and the message names the holder.
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.get("/specialists/{specialist_id}")
    async def get_specialist(specialist_id: str):
        try:
            return container().roster.get(specialist_id).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc

    @r.put("/specialists/{specialist_id}")
    async def update_specialist(specialist_id: str, body: SpecialistBody):
        # exclude_unset, not "drop the Nones": clearing a field (a model back
        # to the provider default, say) is a legitimate edit, and treating
        # None as "not supplied" would make it impossible.
        try:
            return container().roster.update(
                specialist_id, **body.model_dump(exclude_unset=True)).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (SpecialistInUse, DuplicateSpecialist) as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.post("/specialists/{specialist_id}/reset")
    async def reset_specialist(specialist_id: str):
        """Put a built-in specialist back to what it shipped with, including
        un-retiring it. The row is kept: its id is on every task it ever ran."""
        try:
            return container().roster.reset(specialist_id).to_dict()
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (SpecialistInUse, DuplicateSpecialist) as exc:
            raise HTTPException(409, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.delete("/specialists/{specialist_id}")
    async def archive_specialist(specialist_id: str):
        """Archives; never deletes. A specialist's id is on every task it ever
        ran, so removing the row would orphan the history.

        A built-in can be retired too (the user asked for it) — POST
        …/reset brings it back. Still 409 while a live task holds it."""
        try:
            container().roster.archive(specialist_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except SpecialistInUse as exc:
            # 409, with the reason: a live task holds it, or it is built in.
            raise HTTPException(409, str(exc)) from exc
        return {"archived": specialist_id}

    @r.get("/roles")
    async def list_roles():
        """The roles a task may ask for, and which provider each prefers.

        The preference only ORDERS candidates — it never excludes one, because
        a user who created a reviewer on the other provider meant it.
        """
        c = container()
        by_role: dict[str, list[dict]] = {role: [] for role in ROLES}
        for s in c.roster.list():
            by_role.setdefault(s.role, []).append({"id": s.id, "name": s.name,
                                                   "provider_id": s.provider_id})
        return {"roles": [{"role": role, "prefers": ROLE_PREFERENCE.get(role),
                           "specialists": by_role.get(role, [])} for role in ROLES],
                "capabilities": list(TASK_CAPABILITIES)}

    @r.get("/doctor", dependencies=[SETUP_ROUTE_GUARD])
    async def read_doctor():
        """The same checks `yuri doctor` prints, as data — one implementation,
        so the CLI and the Setup screen cannot disagree. `ok` counts only the
        REQUIRED checks: a missing tmux costs the live terminal pane, not the
        app."""
        rows = await asyncio.to_thread(doctor.checks)
        return {"checks": [{"name": c.name, "ok": c.ok, "detail": c.detail,
                            "required": c.required} for c in rows],
                "ok": all(c.ok for c in rows if c.required)}

    @r.get("/config", dependencies=[SETUP_ROUTE_GUARD])
    async def read_config():
        """Managed settings: presence, a masked hint, provenance, and what a
        change takes effect on. NEVER a value."""
        return {"keys": config.managed_status(),
                "path": setup_store.target_dir().replace(
                    os.path.expanduser("~"), "~", 1)}

    @r.put("/config", dependencies=[SETUP_ROUTE_GUARD])
    async def write_config(body: ConfigUpdate):
        """Write managed settings, to the file AND to this process.

        Refuses any name not in MANAGED_KEYS: this endpoint writes a file the
        backend reads at startup, so an arbitrary name would let a caller set
        VC_AUTH_TOKEN or point ALLOWED_PROJECT_ROOTS anywhere."""
        known = {k.name: k for k in config.MANAGED_KEYS}
        unknown = sorted(set(body.values) - set(known))
        if unknown:
            raise HTTPException(
                status_code=400,
                detail=f"not settings Yuri manages: {', '.join(unknown)}")
        # A value with a newline anywhere but a single trailing run (the
        # ordinary paste artifact) is refused outright, naming only the KEY.
        # Letting it through would hand it to clean_value(), which either
        # forges a second assignment or -- for a value that only becomes
        # empty because of a LEADING newline -- silently deletes the key
        # while this endpoint reports success. Never the value: that would
        # put the secret it's protecting straight into the 400 body.
        bad = sorted(name for name, raw in body.values.items()
                     if (raw or "").strip()
                     and setup_store.has_forging_newline(raw))
        if bad:
            raise HTTPException(
                status_code=400,
                detail=f"value contains a newline: {', '.join(bad)}")
        path = await asyncio.to_thread(setup_store.write, dict(body.values))
        # Also update THIS process's environment. Both voice_keys_found() and
        # allowed_project_roots() read os.getenv live, so a file write alone
        # changes nothing until a restart -- every "takes effect straight
        # away" label would be false, and the Setup screen's save-then-
        # re-check could never see the key it just saved. Only after the write
        # succeeds, so the file and the environment cannot diverge on failure.
        for name, raw in body.values.items():
            # Same cleaning `setup_store.write` just applied to the file, so
            # the two can never disagree about what a raw value becomes.
            clean = setup_store.clean_value(raw)
            if clean:
                os.environ[name] = clean
            else:
                os.environ.pop(name, None)
            config.ENV_SOURCES[name] = "Setup"
        written = sorted(body.values)
        # De-duplicated, in the fixed order the UI explains them in.
        order = ("now", "next-session", "restart")
        effects = [e for e in order if any(known[n].effect == e for n in written)]
        return {"written": written, "effects": effects,
                "path": path.replace(os.path.expanduser("~"), "~", 1)}

    @r.get("/templates")
    async def list_templates():
        """Every plan shape, with enough detail to EDIT it.

        `instruction` and `requires` are included where the Phase 7 version
        omitted them: a template editor that cannot see the instruction is an
        editor that silently drops it on save.
        """
        c = container()
        custom = c.templates.custom_names()
        builtin = c.templates.builtin_names()
        return {"templates": [
            {"name": t.name, "description": t.description,
             "custom": t.name in custom,
             # Whether there is a default to go back to, which is what decides
             # if the panel offers Reset at all.
             "has_default": t.name in builtin,
             # The closed vocabularies a task's fields may draw from. Sent
             # rather than hardcoded in the editor: the form turns each one
             # into a set of choices, and a list that drifts from the
             # validator's is a control offering something the save rejects.
             "verify_names": sorted(VERIFY_NAMES),
             "roles": list(ROLES),
             "kinds": list(TASK_KINDS),
             "capabilities": list(TASK_CAPABILITIES),
             "max_tasks": MAX_TASKS_PER_WORKFLOW,
             "tasks": [{"id": task.id, "title": task.title, "role": task.role,
                        "instruction": task.instruction,
                        "depends_on": list(task.depends_on), "read_only": task.read_only,
                        "requires": list(task.requires), "kind": task.kind,
                        "verification": list(task.verification)}
                       for task in t.tasks]}
            for t in sorted(c.workflow.templates.values(), key=lambda t: t.name)]}

    def _reload_templates():
        """Push the merged set onto the engine, so a save is in effect for the
        NEXT mission rather than after a restart.

        Assigned explicitly rather than hidden in the store: the engine holds
        its templates as plain state, and one visible line beats a callback
        nobody can find. Same shape as `workflow.dispatch = dispatcher.dispatch`.
        """
        c = container()
        c.workflow.templates = c.templates.all()
        return c.workflow.templates

    @r.put("/templates/{name}")
    async def save_template(name: str, body: dict):
        """Create or replace a plan shape. Validated by the SAME check the
        loader runs at startup, so a template that saves is one that will
        still load."""
        c = container()
        try:
            c.templates.save(name, body)
        except TemplateError as exc:
            raise HTTPException(400, str(exc)) from exc
        merged = _reload_templates()
        t = merged[name]
        return {"name": t.name, "description": t.description, "custom": True,
                "tasks": len(t.tasks)}

    @r.delete("/templates/{name}")
    async def reset_template(name: str):
        """Delete the user's version. A name that is also built in comes back
        as the default; one that was only ever the user's is gone."""
        c = container()
        try:
            out = c.templates.remove(name)
        except TemplateError as exc:
            raise HTTPException(400, str(exc)) from exc
        _reload_templates()
        return out

    # --- workflows ----------------------------------------------------------
    @r.get("/missions/{mission_id}/workflow")
    async def get_mission_workflow(mission_id: str):
        c = container()
        try:
            c.missions.get(mission_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        workflows = c.store.workflows.for_mission(mission_id)
        if not workflows:
            # 200 with an explicit null, not a 404: "this mission has no
            # workflow" is a normal answer the timeline renders as an empty
            # state, and a 404 would make the UI show a load error instead.
            return {"workflow": None, "tasks": [], "deps": {}}
        w = workflows[0]
        tasks = c.store.tasks.for_workflow(w.id)
        deps = c.store.tasks.deps_for(w.id)
        return {"workflow": w.to_dict(),
                "tasks": [t.to_dict() for t in tasks],
                "deps": {tid: sorted(d) for tid, d in deps.items()}}

    @r.post("/missions/{mission_id}/workflow", status_code=201)
    async def create_mission_workflow(mission_id: str, body: WorkflowBody):
        c = container()
        try:
            m = c.missions.get(mission_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        if body.template and body.tasks:
            raise HTTPException(400, "give either a template or an explicit task list, "
                                     "not both — a graph that claims a template it did not "
                                     "come from makes the timeline lie")
        if not body.template and not body.tasks:
            raise HTTPException(400, "a workflow needs a template or a task list")
        try:
            w = await c.workflow.create(m, body.template or "", body.goal or m.goal or m.title,
                                        overrides=body.overrides, tasks=body.tasks)
        except (KeyError, ValueError) as exc:
            raise HTTPException(400, str(exc)) from exc
        # Born `draft`, deliberately: nothing runs until someone resumes it,
        # which is what lets a spoken plan be read back before it starts.
        return {"workflow": w.to_dict(),
                "tasks": [t.to_dict() for t in c.store.tasks.for_workflow(w.id)]}

    async def _workflow_action(workflow_id: str, action: str, request: Request):
        c = container()
        try:
            c.workflow.get(workflow_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        try:
            await getattr(c.workflow, action)(workflow_id, by=_by(request))
        except (InvalidWorkflowTransition, InvalidTransition) as exc:
            # BOTH: the workflow raises its own type, and pause/resume also
            # move the MISSION, which raises the mission's. Catching only one
            # turned an illegal transition into a 500 — caught by
            # test_an_illegal_workflow_transition_is_a_409.
            raise HTTPException(409, str(exc)) from exc
        return {"workflow": c.workflow.get(workflow_id).to_dict()}

    @r.post("/workflows/{workflow_id}/pause")
    async def pause_workflow(workflow_id: str, request: Request):
        return await _workflow_action(workflow_id, "pause", request)

    @r.post("/workflows/{workflow_id}/resume")
    async def resume_workflow(workflow_id: str, request: Request):
        return await _workflow_action(workflow_id, "resume", request)

    @r.post("/workflows/{workflow_id}/cancel")
    async def cancel_workflow(workflow_id: str, request: Request):
        return await _workflow_action(workflow_id, "cancel", request)

    # --- tasks --------------------------------------------------------------
    @r.post("/tasks/{task_id}/retry")
    async def retry_task(task_id: str, request: Request):
        return await _task_action(task_id, "retry", request)

    @r.post("/tasks/{task_id}/skip")
    async def skip_task(task_id: str, request: Request):
        return await _task_action(task_id, "skip", request)

    async def _task_action(task_id: str, action: str, request: Request):
        c = container()
        try:
            t = await getattr(c.workflow, action)(task_id, by=_by(request))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (InvalidWorkflowTransition, InvalidTransition,
                InvalidTaskTransition, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"task": t.to_dict()}

    @r.post("/tasks/{task_id}/assign")
    async def assign_task(task_id: str, body: AssignBody, request: Request):
        c = container()
        try:
            t = await c.workflow.assign(task_id, body.specialist_id, by=_by(request))
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except NoSpecialist as exc:
            raise HTTPException(400, str(exc)) from exc
        except (InvalidWorkflowTransition, InvalidTransition,
                InvalidTaskTransition, ValueError) as exc:
            raise HTTPException(409, str(exc)) from exc
        return {"task": t.to_dict()}

    @r.get("/missions/{mission_id}/artifacts")
    async def list_artifacts(mission_id: str):
        """What the agents produced. This is what a handoff is built from, so
        it is also the answer to "what does the next agent actually know?"."""
        c = container()
        try:
            c.missions.get(mission_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return {"artifacts": [a.to_dict() for a in c.store.artifacts.for_mission(mission_id)]}

    # --- memory (spec §6) ---------------------------------------------------
    def _active_slugs() -> list[str]:
        """The projects with live work, which is what decides whose project
        memories reach her prompt (spec §4.1 rule 4)."""
        c = container()
        projects = {p.id: p.slug for p in c.projects.registered()}
        return sorted({projects[m.project_id] for m in c.missions.list()
                       if m.status in ACTIVE and m.project_id in projects})

    @r.get("/memories")
    async def list_memories(include_superseded: bool = False):
        """Everything she currently remembers, plus WHICH ONES ARE NOT
        REACHING HER.

        That last part is the point of the endpoint. The old store truncated
        silently — it returned the tail of a file and said nothing — so the
        panel's whole job is to make "this is in her prompt, that is not"
        something you can see and fix by pinning.
        """
        c = container()
        # `include_superseded` was declared and then ignored, which made
        # retired memories unreachable from the panel — and therefore made a
        # wrong replacement permanent. Found while reverting one by hand.
        rows = (c.memories.all_rows(limit=400) if include_superseded
                else c.memories.current(limit=400))
        report = c.memories.budget_report(_active_slugs())
        in_prompt = set(report["in_prompt"])
        out = [{**m.to_dict(), "in_prompt": m.id in in_prompt,
                # The vector is 3KB of float and means nothing to a reader.
                "embedding": None, "embedded": m.embedding is not None}
               for m in rows]
        return {"memories": out, "budget": report}

    @r.post("/memories", status_code=201)
    async def create_memory(body: MemoryBody):
        c = container()
        try:
            m = Memory(body=body.body or "", kind=body.kind or "fact",
                       subject=body.subject or "user",
                       source=body.source or "stated", origin="ui")
        except InvalidMemory as exc:
            # 400 naming the value, not a 500. The Phase 7 lesson.
            raise HTTPException(400, str(exc)) from exc
        if body.pinned:
            m.pinned = True
        existing = c.memories.duplicate_of(m.body)
        if existing is not None:
            raise HTTPException(409, "you already remember that, word for word")
        return c.memories.add(m).to_dict() | {"embedding": None}

    @r.put("/memories/{memory_id}")
    async def edit_memory(memory_id: str, body: MemoryBody):
        c = container()
        try:
            m = c.memories.get(memory_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        fields = body.model_dump(exclude_unset=True)
        for key in ("body", "kind", "subject", "source", "pinned"):
            if key in fields and fields[key] is not None:
                setattr(m, key, fields[key])
        try:
            # Re-runs the domain's own validation, including the
            # subject-must-match-kind rule, rather than duplicating it here.
            m.__post_init__()
        except InvalidMemory as exc:
            raise HTTPException(400, str(exc)) from exc
        if "body" in fields:
            # The text changed, so the old vector describes the old text.
            # Cleared, and the worker re-embeds it — a stale vector would rank
            # this memory by something it no longer says.
            m.embedding = None
        return c.memories.edit(m).to_dict() | {"embedding": None}

    @r.delete("/memories/{memory_id}")
    async def delete_memory(memory_id: str):
        """A hard delete, and the only one. No voice tool reaches this: losing
        a memory on a mishearing is not recoverable."""
        c = container()
        try:
            c.memories.get(memory_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        c.memories.delete(memory_id)
        return {"deleted": memory_id}

    @r.post("/memories/{memory_id}/supersede")
    async def supersede_memory(memory_id: str, body: SupersedeBody):
        c = container()
        try:
            victim = c.memories.get(memory_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        if body.by:
            try:
                replacement = c.memories.get(body.by)
            except KeyError as exc:
                raise HTTPException(404, str(exc)) from exc
        elif (body.body or "").strip():
            try:
                replacement = c.memories.add(Memory(
                    body=body.body or "", kind=victim.kind, subject=victim.subject,
                    source="stated", origin="ui"))
            except InvalidMemory as exc:
                raise HTTPException(400, str(exc)) from exc
        else:
            raise HTTPException(400, "give either `by` (an existing memory's id) or `body` "
                                     "(the text of the one that replaces it)")
        if replacement.id == victim.id:
            raise HTTPException(400, "a memory cannot supersede itself")
        c.memories.supersede(victim, replacement)
        return {"superseded": victim.id, "by": replacement.id}

    @r.post("/memories/{memory_id}/restore")
    async def restore_memory(memory_id: str):
        """Bring a retired memory back.

        The way out of a wrong replacement, which the loose supersede matcher
        makes possible: "old rule" can resolve to "the current rule" on one
        shared word. Without this, retiring the wrong memory was permanent
        from the UI.
        """
        c = container()
        try:
            return c.memories.restore(memory_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except ValueError as exc:
            raise HTTPException(400, str(exc)) from exc

    @r.get("/memories/{memory_id}/history")
    async def memory_history(memory_id: str):
        """What this memory replaced. Superseded rows are kept, never deleted
        — "you used to want X" is occasionally the answer."""
        c = container()
        try:
            c.memories.get(memory_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return {"replaced": [m.to_dict() | {"embedding": None}
                             for m in c.memories.history(memory_id)]}

    @r.post("/memories/search")
    async def search_memories(body: MemorySearch):
        """The panel's search box, and the same path `recall` uses — so what
        the user sees here is what she would find."""
        c = container()
        slug = None
        if body.project:
            try:
                slug = c.projects.resolve_or_create(body.project).slug
            except ValueError as exc:
                raise HTTPException(400, str(exc)) from exc
        return await c.memories.recall(body.query, subject=slug, since=body.since)

    # --- MCP servers --------------------------------------------------------
    #
    # What these never return: an `env` or `header` VALUE. Those hold API keys.
    # The shape comes from ServerConfig.public(), which reports which keys are
    # SET, by name, and nothing more — the same rule config.py applies to
    # VC_AUTH_TOKEN. The redaction lives in that one method rather than in each
    # route, so a new route cannot forget it.
    def _candidate(body: McpServerBody) -> mcp_config.ServerConfig:
        """Validate a request body through the SAME validator the file uses.

        Deliberately not a second, parallel set of checks: one validator means
        a config the API accepted cannot be one the loader rejects at next
        startup, which would be a server that saves fine and then vanishes.
        """
        raw = {"transport": body.transport, "tier": body.tier, "command": body.command,
               "args": list(body.args), "env": dict(body.env), "enabled": body.enabled}
        if body.cwd:
            raw["cwd"] = body.cwd
        try:
            servers = mcp_config.parse({"servers": {body.name: raw}})
        except mcp_config.ConfigError as exc:
            raise HTTPException(400, str(exc)) from exc
        return servers[0]

    @r.get("/mcp")
    async def list_mcp():
        return container().mcp.public()

    @r.post("/mcp/test")
    async def test_mcp(body: McpServerBody):
        """Dry-run a candidate server. Persists NOTHING.

        Three verdicts, because the remedy differs: `ok`, `empty` (connected
        but offers no tools — a warning, not a pass), `failed` (with the
        reason and the stderr tail, because "failed to connect" on its own
        leaves the user nowhere to go).
        """
        return await probe(_candidate(body))

    @r.post("/mcp", status_code=201)
    async def save_mcp(body: McpServerBody):
        """Add a server. Re-tests it here and refuses to save a failing one.

        The test is re-run server-side rather than trusting a flag from the
        client: a disabled Save button is a label, not a lock, and the whole
        point of the flow is that an unreachable server never reaches config —
        where it becomes a startup error and a capability she quietly does not
        have.

        Add, not edit: a name that already exists is a 409. Replacing an entry
        wholesale would silently wipe env values the UI never received (they
        are redacted, so it cannot send them back), and "your API key vanished
        when you renamed the server" is exactly the kind of quiet damage this
        endpoint should not be able to do.
        """
        c = container()
        candidate = _candidate(body)
        existing = c.mcp.read_config()
        if any(s.name == candidate.name for s in existing):
            raise HTTPException(409, f"a server called {candidate.name!r} already exists; "
                                     "remove it first")
        if len(existing) + 1 > mcp_config.MAX_SERVERS:
            raise HTTPException(400, f"{len(existing)} servers are configured; "
                                     f"the limit is {mcp_config.MAX_SERVERS}")
        result = await probe(candidate)
        if result["verdict"] == FAILED_VERDICT:
            raise HTTPException(400, {"error": "the server did not start, so it was not saved",
                                      "reason": result["error"], "stderr": result["stderr"]})
        mcp_config.save(c.mcp.home_dir, existing + [candidate])
        state = await c.mcp.reconnect(candidate.name)
        return {"server": state.public(), "test": result}

    @r.delete("/mcp/{name}")
    async def delete_mcp(name: str):
        c = container()
        remaining = [s for s in c.mcp.read_config() if s.name != name]
        if len(remaining) == len(c.mcp.read_config()):
            raise HTTPException(404, f"no server called {name!r}")
        mcp_config.save(c.mcp.home_dir, remaining)
        # Stop it and unregister its tools now, not at next startup: a stale
        # declaration makes her offer something that will fail.
        await c.mcp.remove(name)
        return {"removed": name}

    @r.post("/mcp/{name}/reconnect")
    async def reconnect_mcp(name: str):
        try:
            state = await container().mcp.reconnect(name)
        except KeyError as exc:
            raise HTTPException(404, f"no server called {name!r}") from exc
        return {"server": state.public()}

    @r.put("/mcp/{name}/enabled")
    async def set_mcp_enabled(name: str, body: McpEnabled):
        """Turn a server off without losing its configuration (and its keys)."""
        c = container()
        servers = c.mcp.read_config()
        if not any(s.name == name for s in servers):
            raise HTTPException(404, f"no server called {name!r}")
        updated = [replace(s, enabled=body.enabled) if s.name == name else s for s in servers]
        mcp_config.save(c.mcp.home_dir, updated)
        state = await c.mcp.reconnect(name)
        return {"server": state.public()}

    # --- events -------------------------------------------------------------
    @r.get("/events")
    async def list_events(mission_id: str | None = None, session_id: str | None = None,
                          since: str | None = None, limit: int = 200):
        evs = container().store.events.list(mission_id=mission_id, session_id=session_id, since=since,
                                            limit=_clamp_limit(limit))
        return {"events": [e.to_dict() for e in evs]}

    @r.get("/events/stream")
    async def stream_events(mission_id: str | None = None, limit: int = 200):
        c = container()
        limit = _clamp_limit(limit)

        def _frame(e) -> str:
            # narration_mode() is called PER EVENT (not once, before the loop) so
            # a mode change made mid-stream (PUT /yuri/narration) takes effect on
            # the very next frame, without restarting the connection.
            mode = narration_mode()
            payload = {**e.to_dict(), "narration": c.narration.line_for(e, mode)}
            return f"data: {json.dumps(payload, default=str)}\n\n"

        async def gen():
            q = c.bus.subscribe()
            try:
                for e in c.store.events.list(mission_id=mission_id, limit=limit):
                    yield _frame(e)
                while True:
                    try:
                        e = await asyncio.wait_for(q.get(), timeout=15.0)
                        if mission_id and e.mission_id != mission_id:
                            continue
                        yield _frame(e)
                    except asyncio.TimeoutError:
                        yield ": ping\n\n"
            finally:
                c.bus.unsubscribe(q)

        return StreamingResponse(gen(), media_type="text/event-stream",
                                 headers={"Cache-Control": "no-cache", "Connection": "keep-alive",
                                          "X-Accel-Buffering": "no"})

    return r
