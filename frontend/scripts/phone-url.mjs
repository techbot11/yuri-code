// Prints ready-to-open URLs (with the auth token) when network mode starts, so
// you can open the app on your phone without hand-assembling the #vc_token URL.
// Reads VC_AUTH_TOKEN from the config file and detects your LAN IP.
// Best-effort: never fails the dev server (any error just prints a hint).
import { readFileSync } from "node:fs";
import { networkInterfaces, homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
// Candidate config locations, in the SAME precedence order backend/config.py
// and run-network.sh use: the out-of-tree config dir (Homebrew, via
// YAPCODE_CONFIG_DIR), then $YURI_HOME/config/.env -- the file `yapcode up`'s
// wizard writes and the Setup screen saves to -- then the in-tree
// backend/.env. The middle one used to be missing here, so on a fresh clone
// this printed "no token" while run-network.sh had one.
const yuriHome = (process.env.YURI_HOME || join(homedir(), "Yuri")).replace(
  /^~(?=$|\/)/,
  homedir(),
);
const envPaths = [
  process.env.YAPCODE_CONFIG_DIR && join(process.env.YAPCODE_CONFIG_DIR, ".env"),
  join(yuriHome, "config", ".env"),
  join(here, "..", "..", "backend", ".env"),
].filter(Boolean);
// Named for the hint below: the file the wizard actually WRITES (same rule as
// bin/yapcode's CONF_DIR and setup_store.target_dir()).
const writablePath = process.env.YAPCODE_CONFIG_DIR
  ? join(process.env.YAPCODE_CONFIG_DIR, ".env")
  : join(yuriHome, "config", ".env");

function lanIP() {
  const addrs = [];
  for (const iface of Object.values(networkInterfaces())) {
    for (const i of iface || []) {
      if (i.family === "IPv4" && !i.internal) addrs.push(i.address);
    }
  }
  return (
    addrs.find((a) => a.startsWith("192.168.")) ||
    addrs.find((a) => a.startsWith("10.")) ||
    addrs.find((a) => /^172\.(1[6-9]|2\d|3[01])\./.test(a)) ||
    addrs[0] ||
    "<your-LAN-IP>"
  );
}

function token() {
  if (process.env.VC_AUTH_TOKEN) return process.env.VC_AUTH_TOKEN.trim();
  for (const p of envPaths) {
    try {
      const m = readFileSync(p, "utf8").match(/^\s*VC_AUTH_TOKEN\s*=\s*(.+?)\s*$/m);
      let t = m ? m[1].trim() : "";
      if ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'"))) {
        t = t.slice(1, -1);
      }
      if (t) return t;
    } catch {
      /* try next candidate */
    }
  }
  return "";
}

const ip = lanIP();
const t = token();
const frag = t ? `/#vc_token=${t}` : "";
const tokenNote = t
  ? ""
  : `\n  ⚠ No VC_AUTH_TOKEN in ${writablePath} — network mode needs one (\`yapcode up\` generates it).`;
const bar = "─".repeat(64);

process.stdout.write(
  `\n${bar}\n` +
    ` yapcode — network mode\n\n` +
    ` 📱 On your phone (same Wi-Fi):\n    https://${ip}:3000${frag}\n\n` +
    ` 💻 On this computer:\n    https://localhost:3000${frag}\n\n` +
    ` ℹ️  First time on each device: open https://${ip}:8000 and accept the cert.${tokenNote}\n` +
    `${bar}\n\n`,
);
