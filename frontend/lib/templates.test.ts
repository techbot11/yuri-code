import test from "node:test";
import assert from "node:assert/strict";
import {
  blankTask, canSaveForm, formError, moveTask, removeTask, renameTask, sameForm,
  templateActions, templateSubtitle, toBody, toForm,
  type TemplateSummary,
} from "./templates.ts";

const tpl = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  name: "bug-fix", description: "Investigate, fix, test and review a bug.",
  custom: false, has_default: true, verify_names: ["tests_pass", "review_approved"],
  roles: ["researcher", "developer", "tester", "reviewer", "verifier", "documenter"],
  kinds: ["agent_task", "approval", "verification", "human_input"],
  capabilities: ["coding", "code_review", "research"], max_tasks: 40,
  tasks: [{ id: "look", role: "researcher", title: "Look", instruction: "Find {goal}." },
          { id: "do", role: "developer", title: "Do", instruction: "Fix {goal}.",
            depends_on: ["look"], verification: ["tests_pass"] }],
  ...over,
});

test("only a customised template with a default offers Reset", () => {
  assert.deepEqual(templateActions(tpl({ custom: true, has_default: true })),
                   { reset: true, remove: false });
  // One the user invented has nothing to go back to — it is removed, not reset.
  assert.deepEqual(templateActions(tpl({ custom: true, has_default: false })),
                   { reset: false, remove: true });
  // An untouched builtin offers neither.
  assert.deepEqual(templateActions(tpl()), { reset: false, remove: false });
});

test("the subtitle says how many steps, how many checked, and whose it is", () => {
  assert.equal(templateSubtitle(tpl()), "2 steps, 1 checked");
  assert.equal(templateSubtitle(tpl({ custom: true })), "2 steps, 1 checked · yours");
  assert.equal(templateSubtitle(tpl({ tasks: [{ id: "a", title: "A", instruction: "x" }] })),
               "1 step");
});

// --- the form model -------------------------------------------------------

test("toForm fills in every absent optional field", () => {
  // Step 1 has no depends_on/verification/requires/kind at all; every control
  // still needs something concrete to bind to.
  const f = toForm(tpl());
  assert.deepEqual(f.tasks[0].depends_on, []);
  assert.deepEqual(f.tasks[0].verification, []);
  assert.deepEqual(f.tasks[0].requires, []);
  assert.equal(f.tasks[0].kind, "agent_task");
  assert.equal(f.tasks[0].read_only, false);
  assert.equal(f.tasks[0].role, "researcher");
});

test("a template survives the form unchanged", () => {
  // The round trip is what makes "open it and press Save" a no-op rather than
  // a silent rewrite of fields the form does not show. `name` is absent
  // because the path owns it: a body that renamed itself would write one file
  // and override a different template.
  assert.deepEqual(toBody(toForm(tpl())), {
    description: "Investigate, fix, test and review a bug.",
    tasks: [
      { id: "look", title: "Look", instruction: "Find {goal}.", role: "researcher" },
      { id: "do", title: "Do", instruction: "Fix {goal}.", role: "developer",
        depends_on: ["look"], verification: ["tests_pass"] },
    ],
  });
});

test("Save stays available for what only the server can judge", () => {
  // Same posture as the MCP form: a disabled button is a label, the server is
  // the lock. A cycle is the case — the form deliberately does not detect it,
  // because a second implementation of "what is a cycle" is one that can
  // drift from the loader's and let a bad template through.
  const f = toForm(tpl());
  f.tasks[0].depends_on = ["do"];   // look <-> do
  f.tasks[1].depends_on = ["look"];
  assert.equal(formError(f), "", "a cycle is not a cheap check");
  assert.ok(canSaveForm(f, toForm(tpl())), "the save must reach the server to be refused");
});

test("the body omits the name and every empty field", () => {
  const body = toBody(toForm(tpl())) as { tasks: Record<string, unknown>[] };
  assert.ok(!("name" in body));
  // Step 1 had no optional fields; it should not gain empty ones.
  assert.deepEqual(Object.keys(body.tasks[0]).sort(),
                   ["id", "instruction", "role", "title"]);
  assert.equal("kind" in body.tasks[0], false, "the default kind is not written out");
});

test("saving an unchanged form is not an edit", () => {
  const f = toForm(tpl());
  assert.ok(sameForm(f, toForm(tpl())));
  assert.ok(!canSaveForm(f, toForm(tpl())));
  assert.ok(canSaveForm({ ...f, description: "Different." }, toForm(tpl())));
});

test("formError names the step and the field", () => {
  const f = toForm(tpl());
  assert.equal(formError(f), "");
  assert.match(formError({ ...f, description: "  " }), /needs a description/);
  assert.match(formError({ ...f, tasks: [] }), /at least one step/);

  const noTitle = toForm(tpl());
  noTitle.tasks[1].title = "";
  assert.match(formError(noTitle), /Step 2 needs a title/);

  const badId = toForm(tpl());
  badId.tasks[0].id = "has spaces";
  assert.match(formError(badId), /Step 1's id/);
});

test("an agent step with no role is caught before the server sees it", () => {
  const f = toForm(tpl());
  f.tasks[0].role = "";
  assert.match(formError(f), /Step 1 is an agent step, so it needs a role/);
  // A non-agent step is allowed to have none.
  f.tasks[0].kind = "human_input";
  assert.equal(formError(f), "");
});

test("a self-dependency and a dangling one are both caught", () => {
  const self = toForm(tpl());
  self.tasks[1].depends_on = ["do"];
  assert.match(formError(self), /Step 2 depends on itself/);

  const dangling = toForm(tpl());
  dangling.tasks[1].depends_on = ["nope"];
  assert.match(formError(dangling), /"nope", which is not a step here/);
});

test("removing a step takes the dependencies on it with it", () => {
  // Left behind, they make a template the server refuses to load — reported
  // as a dangling depends_on rather than as the deletion that caused it.
  const f = removeTask(toForm(tpl()), 0);
  assert.equal(f.tasks.length, 1);
  assert.deepEqual(f.tasks[0].depends_on, []);
  assert.equal(formError(f), "");
});

test("renaming a step carries its dependents across", () => {
  const f = renameTask(toForm(tpl()), 0, "investigate");
  assert.equal(f.tasks[0].id, "investigate");
  assert.deepEqual(f.tasks[1].depends_on, ["investigate"]);
  assert.equal(formError(f), "");
});

test("moving a step changes order and nothing else", () => {
  const f = moveTask(toForm(tpl()), 1, 0);
  assert.deepEqual(f.tasks.map((t) => t.id), ["do", "look"]);
  // Order is legibility only, so the dependency is untouched and still valid.
  assert.deepEqual(f.tasks[0].depends_on, ["look"]);
  assert.equal(formError(f), "");
});

test("moving past either end is a no-op, not a lost step", () => {
  const f = toForm(tpl());
  assert.equal(moveTask(f, 0, -1), f);
  assert.equal(moveTask(f, 1, 2), f);
  assert.equal(moveTask(f, 0, 0), f);
});

test("a new step gets an id that is free", () => {
  const f = toForm(tpl());
  assert.equal(blankTask(f).id, "step");
  const taken = { ...f, tasks: [...f.tasks, { ...blankTask(f) }] };
  assert.equal(blankTask(taken).id, "step_2");
});

test("a new step is not saveable until it is filled in", () => {
  const f = toForm(tpl());
  const withNew = { ...f, tasks: [...f.tasks, blankTask(f)] };
  assert.match(formError(withNew), /Step 3 needs a title/);
});
