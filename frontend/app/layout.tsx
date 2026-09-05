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
  // SetupGate wraps only the routed {children}, inside VoiceProvider (it
  // calls yget, and the provider owns auth) but inside Stage too — Stage owns
  // the orb, TopBar, Home and Dock, none of which should vanish just because
  // something required is missing. Stage derives "engaged" from the pathname
  // itself, not from what's inside its panel, so gating the panel's content
  // doesn't disturb that. Rail and the dock stay reachable, and since the
  // gate never shuts on the /setup route, /setup stays reachable too.
  return (
    <html lang="en" suppressHydrationWarning className={`${display.variable} ${body.variable}`}>
      <body suppressHydrationWarning>
        <VoiceProvider>
          <div className="shell">
            <Rail />
            <Stage>
              <SetupGate>{children}</SetupGate>
            </Stage>
          </div>
        </VoiceProvider>
      </body>
    </html>
  );
}
