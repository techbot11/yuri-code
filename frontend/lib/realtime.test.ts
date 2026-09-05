// The bug this pins: both voice transports used to announce "listening" when
// the MODEL finished generating, not when the SPEAKER finished playing —
// response.completed/response.done fire while output_audio_buffer audio is
// still queued and playing, so the tray/orb flipped to "listening" mid-
// sentence. Drive handleEvent (private, so cast to any) with synthetic
// Realtime events and assert the emitted state sequence never announces
// "listening" before output_audio_buffer.stopped — except when a turn never
// produced any audio at all (a tool-only turn), which must still reach
// "listening" or the state sticks on "thinking" forever.
import test from "node:test";
import assert from "node:assert/strict";
import { RealtimeSession } from "./realtime.ts";

function newSession() {
  const events: any[] = [];
  const session: any = new RealtimeSession({
    instructions: "test",
    onEvent: (e: any) => events.push(e),
  });
  const states = () => events.filter((e) => e.type === "state").map((e) => e.state);
  return { session, states };
}

test("response.completed does not announce listening while audio is still playing", async () => {
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  await session.handleEvent(JSON.stringify({ type: "response.completed" }));
  // Generation finished, but her voice is still queued/playing — no "listening" yet.
  assert.deepEqual(states(), ["thinking", "speaking"]);

  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.stopped" }));
  // Playback actually ended — NOW it's safe to say she's listening.
  assert.deepEqual(states(), ["thinking", "speaking", "listening"]);
});

test("response.done defers listening the same way response.completed does", async () => {
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  await session.handleEvent(
    JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }),
  );
  assert.deepEqual(states(), ["thinking", "speaking"]);

  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.stopped" }));
  assert.deepEqual(states(), ["thinking", "speaking", "listening"]);
});

test("a tool-only turn (no audio at all) still reaches listening", async () => {
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  // No output_audio_buffer.started ever fires for a turn with no audio output.
  await session.handleEvent(JSON.stringify({ type: "response.completed" }));
  assert.deepEqual(states(), ["thinking", "listening"]);
});

test("response.done with no audio reaches listening immediately too", async () => {
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(
    JSON.stringify({ type: "response.done", response: { status: "completed", output: [] } }),
  );
  assert.deepEqual(states(), ["thinking", "listening"]);
});

test("a barge-in's output_audio_buffer.cleared ends playback, same as .stopped", async () => {
  // The server sends .cleared, NOT .stopped, when playback is cut off by a
  // barge-in — this file's subject sibling gemini.ts settles its equivalent
  // flag in stopAllPlayback() for the same reason. Handling only .stopped
  // left audioPlaying true forever after an interruption.
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.cleared" }));
  assert.deepEqual(states(), ["thinking", "speaking", "listening"]);

  // And the flag really is settled: the NEXT response's completion must be
  // able to announce "listening" on its own. This is the assertion that
  // fails without the fix — the state sequence above could also be produced
  // by a .cleared that emitted "listening" without clearing the flag.
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "response.completed" }));
  assert.deepEqual(states(),
    ["thinking", "speaking", "listening", "thinking", "listening"]);
});

test("stop() settles audioPlaying, so a reused session is not born mute", async () => {
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  // No .stopped or .cleared will ever arrive: the connection is going away.
  session.stop();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "response.completed" }));
  assert.deepEqual(states(), ["thinking", "speaking", "thinking", "listening"]);
});

test("a second response's audio does not fire listening early from a stale flag", async () => {
  // Regression guard for audioPlaying leaking across responses: started/
  // stopped/completed for one full turn, then the same sequence again.
  const { session, states } = newSession();
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.stopped" }));
  await session.handleEvent(JSON.stringify({ type: "response.completed" }));
  await session.handleEvent(JSON.stringify({ type: "response.created" }));
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.started" }));
  await session.handleEvent(JSON.stringify({ type: "response.completed" }));
  // Second turn's audio is still playing — must not have announced listening yet.
  assert.deepEqual(states(), [
    "thinking", "speaking", "listening", "listening", "thinking", "speaking",
  ]);
  await session.handleEvent(JSON.stringify({ type: "output_audio_buffer.stopped" }));
  assert.deepEqual(states(), [
    "thinking", "speaking", "listening", "listening", "thinking", "speaking", "listening",
  ]);
});
