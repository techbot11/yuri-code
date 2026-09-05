import "@xterm/xterm/css/xterm.css";
import "./globals.css";
import type { Metadata } from "next";
import { Anton, Archivo } from "next/font/google";
import { VoiceProvider } from "@/components/VoiceProvider";
import { Rail } from "@/components/shell/Rail";
import { Stage } from "@/components/shell/Stage";
import { SetupGate } from "@/components/SetupGate";

const display = Anton({ weight: "400", subsets: ["latin"], variable: "--font-display" });
const body = Archivo({ subsets: ["latin"], variable: "--font-body" });

export const metadata: Metadata = {
  title: "Yuri OS",
  description: "A voice-first companion that runs your coding agents",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  // suppressHydrationWarning: browser extensions inject attributes onto
  // <html>/<body> (e.g. __gcrremoteframetoken) that aren't in the server HTML,
  // which otherwise triggers a dev hydration-mismatch overlay. This only
  // suppresses attribute diffs on these two elements, not their children.
  //
  // VoiceProvider, the rail and the whole stage live HERE, above the routed
  // {children} — not inside a page. A layout persists across route changes; a
  // route does not. So navigating between rail items re-renders only the
  // panel's contents, and the voice connection, both SSE subscriptions, the
  // orb's eased position and the dock's transcript all survive. Get this
  // backwards and Yuri drops mid-sentence, and jumps back to centre, on every
  // click.
  //
  // SetupGate wraps the WHOLE STAGE, not just the routed {children} — inside
  // VoiceProvider (it calls yget, and the provider owns auth), outside Stage.
  //
  // It used to sit inside Stage, around {children} alone, and that made it
  // invisible on the one route where it matters. Stage renders {children}
  // inside `.vpanel`, whose data-open comes from `pathname !== "/"` — so on
  // "/" (the landing route, where a first run begins) the panel is
  // opacity: 0, pointer-events: none and aria-hidden on desktop, and
  // display: none on mobile. The gate substituted a Setup screen into an
  // invisible, non-interactive box: the user saw the orb and the dock and was
  // never told anything was wrong. Spec §6.2 requires the doctor screen
  // INSTEAD of the main UI, which is what standing in for the stage does.
  //
  // Out here it also takes the dock with it: the talk affordance and the
  // composer live inside Stage, so while the gate is shut there is no control
  // on screen that cannot work (docs/yuri/design/GUIDE.md §6). Rail stays
  // outside the gate and therefore reachable, and since the gate never shuts
  // on /setup, that route stays reachable too.
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${body.variable}`}>
      <body suppressHydrationWarning>
        <VoiceProvider>
          <div className="shell">
            <Rail />
            <SetupGate>
              <Stage>{children}</Stage>
            </SetupGate>
          </div>
        </VoiceProvider>
      </body>
    </html>
  );
}
