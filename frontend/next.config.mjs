/** @type {import('next').NextConfig} */
const nextConfig = {
  // The packaged desktop app has no `frontend/node_modules` (bundling it
  // would triple the .dmg -- 388 MB against a 132 MB build). Standalone
  // output makes `next build` emit `.next/standalone/`: a minimal
  // `server.js` plus only the dependencies actually reached, small enough to
  // ship. It does NOT copy `.next/static` or `public/` into that tree --
  // Next's own docs say to place those yourself -- so desktop/scripts and
  // electron-builder.yml do that after the build, and desktop/lib/paths.ts
  // runs `node server.js` from inside `standalone/` rather than
  // `next start`. This does not change `next dev` or `next start`: both
  // still run from the full build as before, standalone is an EXTRA output
  // alongside the normal one, not a replacement for it -- confirmed by
  // running `next start` after enabling this (see the desktop packaging
  // task's fixes report).
  output: "standalone",
  env: {
    BACKEND_URL: process.env.BACKEND_URL || "http://localhost:8000",
    // Port for the browser-direct connections (live-terminal WS, debug stream)
    // that bypass the same-origin proxy. Defaults to the standard backend port.
    BACKEND_PORT: process.env.BACKEND_PORT || "8000",
  },
  // Allow loading the dev server's /_next/* resources (JS chunks, HMR) when the
  // app is opened from another device on the LAN — otherwise Next 16 blocks them
  // as cross-origin and the client never hydrates (toggles/buttons do nothing).
  // Private-range wildcards cover any LAN IP; add a specific origin here only
  // if your network uses something outside these ranges.
  allowedDevOrigins: [
    "192.168.*.*",
    "10.*.*.*",
    "172.16.*.*",
  ],
};
export default nextConfig;
