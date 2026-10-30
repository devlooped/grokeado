import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

console.log("SIMULACIÓN LOCAL: AI Gateway y búsquedas ficticias; sin llamadas a proveedores.");
const child = spawn(process.execPath, [fileURLToPath(import.meta.resolve("next/dist/bin/next")), "dev", ...process.argv.slice(2)], {
  stdio: "inherit",
  env: { ...process.env, COURT_AI_MODE: "mock" },
});
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => child.kill(signal));
child.on("error", (error) => { console.error(error.message); process.exitCode = 1; });
child.on("exit", (code) => { process.exitCode = code ?? 1; });
