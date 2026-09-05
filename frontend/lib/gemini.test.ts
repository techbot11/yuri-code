// Same bug as realtime.test.ts, worse here: sc.turnComplete means Gemini has
// sent every chunk of the turn, but playPcm only SCHEDULES chunks against
// playCursor — seconds of queued PCM can still be ahead of turnComplete, so
// announcing "listening" there flips state mid-sentence. Drive onMessage
// (private, so cast to any) with synthetic serverContent frames and assert
// the emitted state sequence defers "listening" until the queued audio
// actually finishes (liveSources drains via node.onended), while still
// covering: a turn with no audio, and a barge-in that throws the queue away.
//
// onMessage's audio path only runs if `outCtx`/`playDest` are set (playPcm
// no-ops otherwise), so we inject a minimal fake Web Audio graph instead of
// exercising the real (browser-only) AudioContext. Each fake buffer-source
// node's `.start()`/`.connect()` are no-ops and its `onended` callback is
// captured so the test can invoke it to simulate "this chunk finished
// playing" — exactly the moment the real browser would fire it.
import test from "node:test";
import assert from "node:assert/strict";
import { GeminiSession } from "./gemini.ts";

function newSession() {
  const events: any[] = [];
  const session: any = new GeminiSession({
    instructions: "test",
    onEvent: (e: any) => events.push(e),
  });
  const nodes: any[] = [];
  session.outCtx = {
    currentTime: 0,
    createBuffer: () => ({ copyToChannel: () => {}, duration: 0 }),
    createBufferSource: () => {
      const node: any = { connect: () => {}, start: () => {}, onended: null };
      nodes.push(node);
      return node;
    },
    destination: {},
  };
  session.playDest = {};
  const states = () => events.filter((e) => e.type === "state").map((e) => e.state);
  // A silent, valid one-frame PCM payload (4 zero bytes, so it decodes to a
  // whole number of Int16 samples) — its content is irrelevant since
  // copyToChannel is stubbed; only that it's valid base64 of even byte length.
  const speak = (msg: any) => session.onMessage(JSON.stringify(msg));
  const audioChunk = () => ({
    serverContent: { modelTurn: { parts: [{ inlineData: { data: "AAAAAA==" } }] } },
  });
  const turnComplete = () => ({ serverContent: { turnComplete: true } });
  return { session, states, nodes, speak, audioChunk, turnComplete };
}

test("turnComplete with no audio queued announces listening immediately", async () => {
  const { states, speak, turnComplete } = newSession();
  await speak(turnComplete());
  assert.deepEqual(states(), ["listening"]);
});

test("turnComplete defers listening while a chunk is still playing", async () => {
  const { states, nodes, speak, audioChunk, turnComplete } = newSession();
  await speak(audioChunk());
  assert.deepEqual(states(), ["speaking"]);

  await speak(turnComplete());
  // All chunks were SENT, but the one node we created hasn't ended yet —
  // must not announce listening.
  assert.deepEqual(states(), ["speaking"]);
  assert.equal(nodes.length, 1);

  // Now the chunk actually finishes playing (the real end-of-playback signal).
  nodes[0].onended();
  assert.deepEqual(states(), ["speaking", "listening"]);
});

test("listening waits for the LAST of several queued chunks", async () => {
  const { states, nodes, speak, audioChunk, turnComplete } = newSession();
  await speak(audioChunk());
  await speak(audioChunk());
  await speak(turnComplete());
  assert.equal(nodes.length, 2);
  assert.deepEqual(states(), ["speaking", "speaking"]);

  nodes[0].onended(); // first chunk drains — one still playing
  assert.deepEqual(states(), ["speaking", "speaking"]);

  nodes[1].onended(); // last chunk drains — now it's safe to announce
  assert.deepEqual(states(), ["speaking", "speaking", "listening"]);
});

test("a barge-in (stopAllPlayback) settles the state instead of leaving it stuck speaking", async () => {
  const { session, states, nodes, speak, audioChunk, turnComplete } = newSession();
  await speak(audioChunk());
  await speak(turnComplete()); // turn closed, but the chunk is still "playing"
  assert.deepEqual(states(), ["speaking"]);

  // The user interrupts. sc.interrupted calls stopAllPlayback() directly.
  session.stopAllPlayback();
  assert.deepEqual(states(), ["speaking", "listening"]);

  // The forcibly-stopped node's onended still fires later (browsers fire it
  // even after a manual .stop()) — it must not double-announce or throw.
  nodes[0].onended();
  assert.deepEqual(states(), ["speaking", "listening"]);
});

test("sc.interrupted itself drives the same settle path end-to-end", async () => {
  const { states, speak, audioChunk } = newSession();
  await speak(audioChunk());
  assert.deepEqual(states(), ["speaking"]);
  await speak({ serverContent: { interrupted: true } });
  assert.deepEqual(states(), ["speaking", "listening"]);
});
