import { spawn } from "child_process";
import { readFileSync } from "fs";
import { resolve } from "path";

// Load .env
const root = resolve(import.meta.dirname, "..");
try {
  const env = readFileSync(resolve(root, ".env"), "utf-8");
  for (const line of env.split("\n")) {
    const match = line.match(/^\s*([^#=]+?)\s*=\s*(.*)\s*$/);
    if (match) process.env[match[1]] = match[2];
  }
} catch {}

const port = process.env.AGENTLET_SERVER_PORT || "8080";
const token = process.env.AGENTLET_BRIDGE_TOKEN || "token_dev_123";

const children = [];

function run(name, cmd, args) {
  const child = spawn(cmd, args, { stdio: "inherit", cwd: root });
  children.push(child);
  child.on("exit", (code) => console.log(`[${name}] exited with code ${code}`));
}

run("server", "node", [
  "packages/server/dist/standalone.js",
  "--port", port,
  "--allow-insecure",
  "--token", token,
]);

// Give the server a moment to start
setTimeout(() => {
  run("daemon", "node", [
    "packages/local/dist/index.js",
    "--server", `ws://localhost:${port}/api/bridge`,
    "--allow-insecure",
    "--token", token,
  ]);
}, 2000);

process.on("SIGINT", () => {
  children.forEach((c) => c.kill());
  process.exit();
});
