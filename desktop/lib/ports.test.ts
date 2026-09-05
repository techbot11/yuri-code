import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_BACKEND_PORT, DEFAULT_FRONTEND_PORT, defaultPorts, portBusyDetail, portsFromEnv } from "./ports.ts";

test("the shipping defaults are the ports the app is configured around", () => {
  // Fixed on purpose: VC_ALLOWED_ORIGINS and the LAN-access feature both
  // assume these. The override exists for verification, not for shipping.
  assert.equal(DEFAULT_BACKEND_PORT, 8000);
  assert.equal(DEFAULT_FRONTEND_PORT, 3000);
  assert.deepEqual(defaultPorts(), { backend: 8000, frontend: 3000 });
});

test("no env vars set falls back to the shipping defaults", () => {
  assert.deepEqual(portsFromEnv({}), { backend: 8000, frontend: 3000 });
});

test("valid overrides are used verbatim", () => {
  assert.deepEqual(
    portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "8177", YURI_DESKTOP_FRONTEND_PORT: "3177" }),
    { backend: 8177, frontend: 3177 });
});

test("a non-numeric value falls back rather than producing NaN", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "not-a-port" }).backend, 8000);
});

test("zero falls back -- not a usable TCP port", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "0" }).backend, 8000);
});

test("a negative value falls back", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "-1" }).backend, 8000);
});

test("a value above 65535 falls back", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "65536" }).backend, 8000);
});

test("the boundary value 65535 is accepted", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "65535" }).backend, 65535);
});

test("a fractional value falls back", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "8177.5" }).backend, 8000);
});

// The three forms `Number()` accepts and bin/yuri's port_from_env() does
// not. Each of them, parsed by Number(), is how the shell came to bind a
// port the frontend build had not been stamped for -- so the frontend
// proxied to http://localhost:8000, the default the stamp fell back to,
// which on a developer's machine is often their own live backend.
test("a leading plus falls back -- Number('+8198') is 8198, bash rejects it", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "+8198" }).backend, 8000);
});

test("a trailing .0 falls back -- Number('8198.0') is an integer 8198", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "8198.0" }).backend, 8000);
});

test("hex falls back -- Number('0x2016') is 8214, a THIRD port", () => {
  // The worst of the three: it parses, it is in range, and it is neither the
  // number written nor the default.
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "0x2016" }).backend, 8000);
});

test("exponent notation falls back", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "8e3" }).backend, 8000);
});

test("surrounding whitespace is stripped, as port_from_env() strips it", () => {
  // Both sides must agree here too, in the OTHER direction: bash trims
  // before its digits check, so falling back on this would be the same
  // divergence with the sides swapped.
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: " 3199 " }).backend, 3199);
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "\t8198\n" }).backend, 8198);
});

test("an empty string falls back", () => {
  assert.equal(portsFromEnv({ YURI_DESKTOP_BACKEND_PORT: "" }).backend, 8000);
});

test("the two env vars are independent", () => {
  const p = portsFromEnv({ YURI_DESKTOP_FRONTEND_PORT: "3177" });
  assert.equal(p.backend, 8000);
  assert.equal(p.frontend, 3177);
});

test("the busy-port message names the port and what to do", () => {
  const msg = portBusyDetail(8000, "backend");
  assert.match(msg, /8000/);
  assert.match(msg, /backend/);
  assert.match(msg, /bin\/yuri up/, "the likely cause is the developer's own server");
});
