import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const scriptDirectory = dirname(fileURLToPath(import.meta.url));
const frontendDirectory = resolve(scriptDirectory, "..");
const nextCli = resolve(frontendDirectory, "node_modules/next/dist/bin/next");
const forwardedArgs = process.argv.slice(2);
const hasExplicitPort = forwardedArgs.some(
  (arg, index) =>
    arg === "--port" ||
    (arg === "-p" && index < forwardedArgs.length - 1) ||
    arg.startsWith("--port=") ||
    arg.startsWith("-p="),
);
if (!hasExplicitPort) forwardedArgs.push("--port", "3000");

const child = spawn(process.execPath, [nextCli, "dev", ...forwardedArgs], {
  cwd: frontendDirectory,
  stdio: "inherit",
  env: {
    ...process.env,
    ...(!hasExplicitPort ? { PORT: "3000" } : {}),
  },
});

let shuttingDown = false;
function forwardSignal(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  if (child.exitCode === null && !child.killed) child.kill(signal);
}
process.on("SIGINT", () => forwardSignal("SIGINT"));
process.on("SIGTERM", () => forwardSignal("SIGTERM"));

child.once("error", (error) => {
  console.error("Không khởi động được Next.js:", error.message);
  process.exitCode = 1;
});
child.once("exit", (code, signal) => {
  process.exitCode = signal === "SIGINT" ? 130 : signal ? 1 : (code ?? 1);
});
