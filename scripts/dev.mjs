// npm run dev: rebuilds the web pages on change and restarts the server on change.
import { spawn } from "node:child_process";
const run = (cmd, args) => spawn(cmd, args, { stdio: "inherit", shell: process.platform === "win32" });
const procs = [
  run("npx", ["vite", "build", "--watch", "--mode", "development"]),
  run("npx", ["tsx", "watch", "--clear-screen=false", "src/server/main.ts"]),
];
const stop = () => { for (const p of procs) p.kill(); process.exit(0); };
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
