"use client";

// The stage's top strip: wordmark, the voice pill, narration mode, clock.
// pointer-events are off on the strip itself and back on for the controls, so
// the transparent band between them never eats a click meant for the orb.
import { useEffect, useState } from "react";
import { useYuri } from "@/components/VoiceProvider";
import { failure } from "@/lib/voiceStatus";
import { micSettingsOpener, offersMicSettings } from "@/lib/mic.ts";
import { orbCaption } from "@/lib/voiceui.ts";
import { NARRATION_MODES } from "@/lib/narration.ts";

function Clock() {
  // Rendered empty on the server and filled on mount: a clock printed during
  // SSR is wrong by the time it reaches the browser, and it hydration-mismatches.
  const [now, setNow] = useState<string>("");
  useEffect(() => {
    const tick = () => setNow(new Date().toTimeString().slice(0, 8));
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);
  return <span className="clock" suppressHydrationWarning>{now}</span>;
}

export function TopBar() {
  const {
    connected, muted, vstate, connect, disconnect, toggleMute,
    narrationMode, setNarrationMode, narrationBusy, status,
  } = useYuri();

  const caption = orbCaption(connected, muted, vstate);
  const speaking = vstate === "speaking";
  const failed = failure(status);

  // Resolved after mount, never during render: window.yuriBoot does not exist
  // on the server, and a control rendered from it during SSR would
  // hydration-mismatch the way the clock above would. False in a browser tab,
  // which is why the button is not rendered there at all -- there is nothing
  // it could do (GUIDE.md: a control that cannot work is not rendered), and
  // the browser's own message says "address bar" instead.
  //
  // A BOOLEAN, and the opener is re-resolved in the click handler. It was
  // briefly held in state as a function, which is a React trap with two
  // symptoms at once: a state setter given a function treats it as an
  // updater and CALLS it, so every mount fired the opener and macOS opened
  // System Settings on every app start; and what got stored was the opener's
  // return value, undefined, so the button this exists to render never
  // appeared. Only the side effect was ever visible. Storing a plain flag
  // removes the trap rather than working around it with a thunk.
  const [canOpenMicSettings, setCanOpenMicSettings] = useState(false);
  useEffect(() => { setCanOpenMicSettings(micSettingsOpener() !== undefined); }, []);

  return (
    <div className="top">
      <span className="wordmark">YURI<sup>OS</sup></span>

      <div className="top-mid">
        <button
          className="vpill"
          data-voice={speaking ? "speaking" : muted ? "muted" : connected ? "live" : "idle"}
          onClick={() => (connected ? disconnect() : connect())}
          // The pill both connects and disconnects, so its name has to say
          // which — "Voice" alone leaves the user guessing what a click does.
          aria-label={connected ? "Disconnect voice" : "Connect voice"}
        >
          <span className="dot" aria-hidden="true" />
          <span>{connected ? caption : "Connect voice"}</span>
        </button>
        {/* A failed connect used to be invisible: the provider computed
            "Failed: ..." into state that no component rendered, so the user
            saw neither "connected" nor a reason. Shown beside the pill, which
            is where they just clicked. */}
        {!connected && failed && (
          <span className="vfail" role="status">{failed}</span>
        )}
        {/* A denied microphone is fixed in System Settings, not here -- and
            in the packaged app the shell can open that pane itself (Task 4's
            mic:settings channel, until now reachable only from the boot
            splash, which is hidden on a warm start). Shown only for the
            message that names that pane (lib/mic.ts's offersMicSettings), so
            it never appears beside a failure it cannot fix. */}
        {!connected && offersMicSettings(failed) && canOpenMicSettings && (
          <button className="vmute" onClick={() => micSettingsOpener()?.()}>
            Open Microphone settings
          </button>
        )}
        {connected && (
          <button
            className="vmute"
            onClick={toggleMute}
            aria-pressed={muted}
            aria-label={muted ? "Unmute microphone" : "Mute microphone"}
          >
            {muted ? "Unmute" : "Mute"}
          </button>
        )}
      </div>

      <div className="seg" role="group" aria-label="Narration mode">
        {NARRATION_MODES.map((m) => (
          <button
            key={m}
            aria-pressed={narrationMode === m}
            disabled={narrationBusy}
            onClick={() => setNarrationMode(m)}
          >
            {m}
          </button>
        ))}
      </div>
      <Clock />
    </div>
  );
}
