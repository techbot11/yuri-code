import test from "node:test";
import assert from "node:assert/strict";
import {
  canSave, editableBody, parseBody, templateActions, templateSubtitle,
  type TemplateSummary,
} from "./templates.ts";

const tpl = (over: Partial<TemplateSummary> = {}): TemplateSummary => ({
  name: "bug-fix", description: "Investigate, fix, test and review a bug.",
  custom: false, has_default: true, verify_names: ["tests_pass"], max_tasks: 40,
  tasks: [{ id: "look", role: "researcher", title: "Look", instruction: "Find {goal}." },
          { id: "do", role: "developer", title: "Do", instruction: "Fix {goal}.",
            depends_on: ["look"], verification: ["tests_pass"] }],
  ...over,
});

test("the editable body omits the name, because the path owns it", () => {
  // A body that renamed itself would write one file and override a different
  // template — very hard to see afterwards.
  const body = JSON.parse(editableBody(tpl()));
  assert.ok(!("name" in body));
  assert.equal(body.tasks.length, 2);
  assert.equal(body.description, "Investigate, fix, test and review a bug.");
});

test("the body round-trips through the editor unchanged", () => {
  const text = editableBody(tpl());
  assert.ok(canSave(text, "something else"));
  assert.ok(!canSave(text, text), "saving an unchanged body is not an edit");
});

test("bad JSON is reported with the parser's own message", () => {
  // "invalid JSON" tells you nothing; the parser names the position.
  const out = parseBody("{ nope");
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.error.length > 10);
});

test("a template must be an object with at least one step", () => {
  for (const bad of ["[]", "3", '"a string"', "{}", '{"tasks": []}']) {
    const out = parseBody(bad);
    assert.equal(out.ok, false, bad);
  }
});

test("a step missing an id, title or instruction is named by number", () => {
  const out = parseBody('{"tasks": [{"id": "a", "title": "A"}]}');
  assert.equal(out.ok, false);
  assert.ok(!out.ok && out.error.includes("Step 1"));
  assert.ok(!out.ok && out.error.includes("instruction"));
});

test("a valid body parses", () => {
  assert.ok(parseBody(editableBody(tpl())).ok);
});

test("Save stays available for a semantically bad body, because the server decides", () => {
  // Same posture as the MCP form: a disabled button is a label, the server is
  // the lock. Here the body parses but names a role the backend will refuse —
  // and the backend's message is what the user needs to see.
  const text = JSON.stringify({ tasks: [{ id: "a", role: "wizard", title: "A",
                                          instruction: "x" }] });
  assert.ok(canSave(text, "{}"));
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
