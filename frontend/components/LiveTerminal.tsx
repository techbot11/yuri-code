"use client";

import { useEffect, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { withAuthParam } from "@/lib/auth";
import { Icon } from "./ui/Icon";

// Streams the live interactive Claude TUI (CLI backend) by bridging the
// backend's PTY-over-WebSocket terminal endpoint into an xterm.js instance.
// The backend talks to a tmux pane; closing this just detaches (the session
// keeps running). Backend runs on :8000 (the Next app is on :3000).
export default function LiveTerminal({ handle }: { handle: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const wsRef = useRef<WebSocket | null>(null);

  // Raw keystrokes into the PTY. Scrolling does NOT use this -- see scroll().
  const send = (seq: string) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(seq);
  };

  // Scrolling goes through tmux's copy-mode, NOT through keystrokes. PgUp and
  // PgDn written into the PTY reach the application inside the pane, and
  // Claude Code reads them as prompt-history navigation -- so "scroll up"
  // walked the user's previous prompts instead of the output. "bottom" leaves
  // copy-mode, which is what makes the pane follow live output again.
  const scroll = (direction: "up" | "down" | "bottom") => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ __scroll: direction }));
    }
  };

  useEffect(() => {
    const el = ref.current;
    if (!el) return;

    const term = new Terminal({
      fontSize: 12,
      fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace',
      cursorBlink: true,
      theme: { background: "#0a0d14", foreground: "#e7ebf2" },
    });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(el);
    try {
      fit.fit();
    } catch {
      /* ignore */
    }

    // Match the page's scheme: an https page (dev:network) must use wss, or the
    // browser blocks it as mixed content. Plain http (localhost) uses ws.
    const host = window.location.hostname || "localhost";
    const proto = window.location.protocol === "https:" ? "wss" : "ws";
    // Append the shared-secret token (when configured) so the backend authorizes
    // this keystroke-injecting socket; no-op on localhost (loopback-trusted).
    const port = process.env.BACKEND_PORT || "8000";
    const ws = new WebSocket(
      withAuthParam(`${proto}://${host}:${port}/sessions/${handle}/terminal`),
    );
    ws.binaryType = "arraybuffer";
    wsRef.current = ws;

    const sendResize = () => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ __resize: { cols: term.cols, rows: term.rows } }));
      }
    };
    ws.onopen = () => {
      try {
        fit.fit();
      } catch {
        /* ignore */
      }
      sendResize();
    };
    ws.onmessage = (e) => {
      if (typeof e.data === "string") term.write(e.data);
      else term.write(new Uint8Array(e.data as ArrayBuffer));
    };
    ws.onclose = () => term.write("\r\n\x1b[2m[terminal disconnected]\x1b[0m\r\n");

    const dataSub = term.onData((d) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(d);
    });
    const ro = new ResizeObserver(() => {
      try {
        fit.fit();
        sendResize();
      } catch {
        /* ignore */
      }
    });
    ro.observe(el);

    // Touch-gesture scrolling: the TUI's alternate screen has no local
    // scrollback for xterm to pan, so a vertical swipe becomes a tmux
    // copy-mode scroll -- the same path the buttons and the wheel take.
    let lastY = 0;
    let accum = 0;
    const STEP = 20; // px of swipe per wheel notch
    // Same reasoning as the buttons: an SGR wheel event is delivered to the
    // application in the pane, which is free to treat it as anything. Ask
    // tmux to scroll its own scrollback instead.
    const wheel = (up: boolean) => {
      if (ws.readyState !== WebSocket.OPEN) return;
      ws.send(JSON.stringify({ __scroll: up ? "up" : "down" }));
    };
    const onTouchStart = (e: TouchEvent) => {
      lastY = e.touches[0].clientY;
      accum = 0;
    };
    const onTouchMove = (e: TouchEvent) => {
      const y = e.touches[0].clientY;
      accum += y - lastY;
      lastY = y;
      while (Math.abs(accum) >= STEP) {
        const up = accum > 0; // finger drags down -> reveal earlier -> wheel up
        wheel(up);
        accum += up ? -STEP : STEP;
      }
      e.preventDefault();
    };
    el.addEventListener("touchstart", onTouchStart, { passive: true });
    el.addEventListener("touchmove", onTouchMove, { passive: false });

    return () => {
      ro.disconnect();
      dataSub.dispose();
      el.removeEventListener("touchstart", onTouchStart);
      el.removeEventListener("touchmove", onTouchMove);
      ws.close();
      wsRef.current = null;
      term.dispose();
    };
  }, [handle]);

  return (
    <div className="liveterm-wrap">
      <div className="liveterm" ref={ref} />
      <div className="term-scrollbtns">
        <button onClick={() => scroll("up")} title="Scroll up" aria-label="Scroll up"><Icon name="scroll-up" size={15} /></button>
        <button onClick={() => scroll("down")} title="Scroll down" aria-label="Scroll down"><Icon name="scroll-down" size={15} /></button>
        <button onClick={() => scroll("bottom")} title="Back to live" aria-label="Back to live"><Icon name="scroll-bottom" size={15} /></button>
      </div>
    </div>
  );
}
