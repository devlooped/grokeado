import { Sandbox } from "@vercel/sandbox";
import { readFile } from "node:fs/promises";

const timeoutMs = 15 * 60_000;
const sandbox = await Sandbox.create({
  runtime: "node24",
  timeout: timeoutMs,
  networkPolicy: "allow-all",
  resources: { vcpus: 2 },
  tags: { purpose: "evidence-harness-snapshot" },
});
let snapshotted = false;

async function run(command: string, args: string[], sudo = false): Promise<void> {
  const result = await sandbox.runCommand({
    cmd: command,
    args,
    sudo,
    timeoutMs: 10 * 60_000,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  if (result.exitCode !== 0) {
    throw new Error([await result.stdout(), await result.stderr()].filter(Boolean).join("\n").slice(-5000));
  }
}

try {
  const [packageJson, harness] = await Promise.all([
    readFile("sandbox/harness/package.json", "utf8"),
    readFile("sandbox/harness/agent.ts", "utf8"),
  ]);
  await sandbox.mkDir("/opt/evidence-harness");
  await sandbox.writeFiles([
    { path: "/opt/evidence-harness/package.json", content: packageJson },
    { path: "/opt/evidence-harness/agent.ts", content: harness },
  ]);
  await run("apt-get", ["update"], true);
  await run("apt-get", ["install", "-y", "python3", "python3-pip", "tesseract-ocr", "tesseract-ocr-spa", "poppler-utils", "imagemagick"], true);
  await run("python3", ["-m", "pip", "install", "--break-system-packages", "pymupdf"]);
  await run("npm", ["install", "--prefix", "/opt/evidence-harness", "--omit=dev"], true);
  const snapshot = await sandbox.snapshot({ expiration: 30 * 24 * 60 * 60 * 1000 });
  snapshotted = true;
  console.log("Evidence snapshot: " + snapshot.snapshotId);
  console.log("Set EVIDENCE_SANDBOX_SNAPSHOT_ID to this value.");
} finally {
  if (!snapshotted) await sandbox.stop();
}
