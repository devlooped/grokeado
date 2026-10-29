import { Agent, tempFs, type ModelSelection, type SDKCustomTool, type SDKImage, type ToolName } from "@cursor/sdk";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { toSdkTools, type Toolset } from "./toolset.ts";

const TURN_TIMEOUT_MS = Number(process.env.COURT_TURN_TIMEOUT_MS ?? 270_000);

export interface SeatRun {
  name: string;
  model: ModelSelection;
  builtinTools: ToolName[];
  extraTools?: Record<string, SDKCustomTool>;
  prompt: string;
  tools: Toolset;
  images?: SDKImage[];
}

// A seat is a throwaway agent: it works on an in-memory file system and is disposed when the turn ends.
export async function runSeat(run: SeatRun): Promise<void> {
  const cwd = await mkdtemp(path.join(tmpdir(), "grokeado-"));
  try {
    const agent = await Agent.create({
      name: run.name,
      model: run.model,
      apiKey: process.env.CURSOR_API_KEY || undefined,
      tools: [...run.builtinTools, "mcp"],
      local: { cwd, fs: tempFs(), settingSources: [] },
    });
    try {
      const sent = await agent.send(
        { text: run.prompt, images: run.images },
        { local: { customTools: { ...run.extraTools, ...toSdkTools(run.tools) } } }
      );
      const timer = setTimeout(() => void sent.cancel().catch(() => undefined), TURN_TIMEOUT_MS);
      try {
        const result = await sent.wait();
        if (result.status === "error") throw new Error(run.name + " run " + sent.id + " failed");
      } finally {
        clearTimeout(timer);
      }
    } finally {
      await agent[Symbol.asyncDispose]();
    }
  } finally {
    await rm(cwd, { recursive: true, force: true }).catch(() => undefined);
  }
}
