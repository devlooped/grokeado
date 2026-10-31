import { Sandbox } from "@vercel/sandbox";
import { randomUUID } from "node:crypto";
import { COUNSEL_MODELS } from "../court/models.ts";
import { evidenceSandboxLaunch, evidenceTaskDocument } from "./broker.ts";
import { parseEvidenceDocument, createEvidenceIndex } from "./okf.ts";
import { createMockEvidencePromotion } from "./mock.ts";
import type { EvidenceSeat, EvidenceStage } from "./schema.ts";
import { blobConfigured, readEvidenceTree, writeEvidenceTree } from "./blob.ts";
import { validateEvidenceTree, validatePromotedFiles } from "./validate.ts";
import { assembleWorkspace, citationAuthors, citationsFor, readOnlyHashesFor, workspaceIndex } from "./workspace.ts";

const WORKSPACE = "/workspace";
const EVIDENCE_GUIDE = `# Evidence format
All Markdown documents except index.md require YAML frontmatter. Common keys:
type, title, description, sources[], generated: { by, at }.
evidence adds pages[], extraction: { tool, confidence }, tokens.
fragment adds page and may add reprocess_of.
argument adds stage (exposicion|objecion|conclusion), supports[], refutes[].
Use page anchors #pN. Keep base/ and all other seats read-only.`;

export type EvidenceStepResult = {
  status: "ok" | "partial" | "timeout";
  index: string;
  citations: string[];
};

function presented(files: ReadonlyMap<string, Uint8Array | string>, seat: EvidenceSeat, stage: EvidenceStage): Pick<EvidenceStepResult, "index" | "citations"> {
  const visible = assembleWorkspace(files, seat, stage);
  return { index: workspaceIndex(visible), citations: citationsFor(visible, citationAuthors(seat, stage)) };
}

function indexFor(files: ReadonlyMap<string, Uint8Array | string>, seat: EvidenceSeat): string {
  const entries = [...files].flatMap(([path, content]) => {
    if (!path.startsWith(`evidence/${seat}/`) || !path.endsWith(".md") || path.endsWith("/index.md")) return [];
    const source = typeof content === "string" ? content : new TextDecoder().decode(content);
    return [{ path, document: parseEvidenceDocument(source) }];
  });
  return createEvidenceIndex(entries);
}

function hashesWithPrefix(hashes: Record<string, string>, prefix: string): Record<string, string> {
  return Object.fromEntries(Object.entries(hashes).filter(([path]) => path.startsWith(prefix)));
}

export async function runEvidenceStep(
  caseId: string,
  seat: EvidenceSeat,
  stage: EvidenceStage,
  task: string,
  simulated = false
): Promise<EvidenceStepResult> {
  "use step";
  const empty: EvidenceStepResult = { status: "partial", index: "", citations: [] };
  if (!blobConfigured()) return empty;

  const original = await readEvidenceTree(caseId);
  const initialErrors = validateEvidenceTree(original);
  if (initialErrors.length) throw new Error("Stored evidence bundle is invalid: " + initialErrors.join("; "));

  const current = presented(original, seat, stage);
  if (simulated) {
    const promoted = createMockEvidencePromotion(original, seat, stage);
    const errors = validatePromotedFiles(seat, original, promoted);
    if (errors.length) throw new Error("Mock evidence promotion is invalid: " + errors.join("; "));
    const merged = new Map(original);
    for (const [path, content] of promoted) merged.set(path, new TextEncoder().encode(content));
    const indexPath = `evidence/${seat}/index.md`;
    const seatIndex = new TextEncoder().encode(indexFor(merged, seat));
    await writeEvidenceTree(caseId, new Map([...merged].filter(([path]) => path.startsWith(`evidence/${seat}/`)).map(([path, value]) => [path, path === indexPath ? seatIndex : value])));
    merged.set(indexPath, seatIndex);
    return { status: "ok", ...presented(merged, seat, stage) };
  }
  const apiKey = process.env.EVIDENCE_AI_GATEWAY_API_KEY;
  const snapshotId = process.env.EVIDENCE_SANDBOX_SNAPSHOT_ID;
  if (!apiKey || !snapshotId) {
    console.warn("Evidence harness returned partial: configure EVIDENCE_AI_GATEWAY_API_KEY and EVIDENCE_SANDBOX_SNAPSHOT_ID.");
    return { status: "partial", ...current };
  }
  const launch = evidenceSandboxLaunch(apiKey, process.env.AI_GATEWAY_API_KEY);

  const deadlineAt = new Date(Date.now() + 180_000).toISOString();
  const runId = randomUUID();
  const workspace = assembleWorkspace(original, seat, stage);
  const readOnlyHashes = readOnlyHashesFor(workspace);
  const sandbox = await Sandbox.create({
    source: { type: "snapshot", snapshotId },
    timeout: 225_000,
    resources: { vcpus: 2 },
    networkPolicy: launch.networkPolicy,
    env: launch.env,
    tags: { case: caseId.slice(0, 32), seat, stage },
  });

  try {
    const files: Array<{ path: string; content: string | Uint8Array }> = [...workspace].map(([path, content]) => ({ path: `${WORKSPACE}/${path}`, content }));
    files.push(
      { path: `${WORKSPACE}/docs/evidence.md`, content: EVIDENCE_GUIDE },
      {
        path: `${WORKSPACE}/task.json`,
        content: JSON.stringify(evidenceTaskDocument({
          caseId,
          runId,
          model: COUNSEL_MODELS[seat].id,
          seat,
          stage,
          task,
          deadlineAt,
          maxSteps: 8,
          baseHashes: hashesWithPrefix(readOnlyHashes, "evidence/base/"),
          readOnlyHashes,
          existingSeatPaths: [...workspace.keys()].filter((path) => path.startsWith(`evidence/${seat}/`)),
        })),
      },
    );
    await sandbox.writeFiles(files);
    const commandSignal = AbortSignal.timeout(195_000);
    let command;
    try {
      command = await sandbox.runCommand({
        cmd: "node",
        args: ["--import", "/opt/evidence-harness/node_modules/tsx/dist/loader.mjs", "/opt/evidence-harness/agent.ts", `${WORKSPACE}/task.json`],
        cwd: WORKSPACE,
        timeoutMs: 195_000,
        signal: commandSignal,
      });
    } catch (error) {
      if (commandSignal.aborted) {
        console.warn("Evidence harness exceeded its deadline; proceeding with previously promoted files.");
        return { status: "timeout", ...current };
      }
      throw error;
    }
    if (command.exitCode !== 0) throw new Error((await command.stderr()).slice(-4000) || `Evidence harness exited with ${command.exitCode}.`);

    const resultFile = await sandbox.readFileToBuffer({ path: `${WORKSPACE}/evidence/${seat}/result.json` });
    if (!resultFile) throw new Error("The evidence harness did not return result.json.");
    const result = JSON.parse(resultFile.toString("utf8")) as {
      status: "ok" | "partial" | "timeout";
      promoted: string[];
      baseHashes: Record<string, string>;
      readOnlyHashes: Record<string, string>;
      error?: string;
    };
    const expectedBase = hashesWithPrefix(readOnlyHashes, "evidence/base/");
    for (const [path, digest] of Object.entries(expectedBase)) {
      if (result.baseHashes[path] !== digest) {
        console.warn(`Rejected evidence promotion because the sandbox changed read-only base evidence: ${path}`);
        return { status: "partial", ...current };
      }
    }
    for (const [path, digest] of Object.entries(readOnlyHashes)) {
      if (result.readOnlyHashes[path] !== digest) {
        console.warn(`Rejected evidence promotion because the sandbox changed read-only evidence: ${path}`);
        return { status: "partial", ...current };
      }
    }

    const promoted = new Map<string, Uint8Array>();
    for (const path of result.promoted) {
      if (!path.startsWith(`evidence/${seat}/`) || path.includes("..") || path.includes("\\")) {
        throw new Error(`Sandbox returned a path outside its namespace: ${path}`);
      }
      const content = await sandbox.readFileToBuffer({ path: `${WORKSPACE}/${path}` });
      if (!content) throw new Error(`Evidence harness did not return ${path}.`);
      promoted.set(path, new Uint8Array(content));
    }
    const transcript = await sandbox.readFileToBuffer({ path: `${WORKSPACE}/transcript.jsonl` });
    if (transcript) promoted.set(`evidence/${seat}/runs/${runId}/transcript.jsonl`, new Uint8Array(transcript));
    promoted.set(`evidence/${seat}/runs/${runId}/result.json`, new TextEncoder().encode(JSON.stringify(result)));

    const validationErrors = validatePromotedFiles(seat, original, promoted);
    if (validationErrors.length) {
      console.warn("Rejected invalid evidence promotion:", validationErrors.join("; "));
      return { status: "partial", ...current };
    }

    const merged = new Map(original);
    for (const [path, content] of promoted) merged.set(path, content);
    const indexPath = `evidence/${seat}/index.md`;
    const seatIndex = new TextEncoder().encode(indexFor(merged, seat));
    await writeEvidenceTree(caseId, new Map([...promoted, [indexPath, seatIndex]]));
    merged.set(indexPath, seatIndex);
    return { status: result.status, ...presented(merged, seat, stage) };
  } finally {
    await sandbox.stop({ signal: AbortSignal.timeout(10_000) });
  }
}
