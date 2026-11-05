import type { EvidenceSeat, EvidenceStage } from "./schema.ts";
import type { NetworkPolicy } from "@vercel/sandbox";

export type EvidenceTaskDocument = {
  caseId: string;
  runId: string;
  model: string;
  seat: EvidenceSeat;
  stage: EvidenceStage;
  task: string;
  deadlineAt: string;
  maxSteps: number;
  baseHashes: Record<string, string>;
  readOnlyHashes: Record<string, string>;
  existingSeatPaths: string[];
};

export function evidenceSandboxLaunch(apiKey: string, projectKey?: string): {
  env: { AI_GATEWAY_API_KEY: "placeholder"; AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh" };
  networkPolicy: {
    allow: {
      "ai-gateway.vercel.sh": [{ transform: [{ headers: { Authorization: string } }] }];
      "*": [];
    };
  };
} {
  if (!apiKey.trim() || apiKey === "placeholder" || (projectKey && apiKey === projectKey)) {
    throw new Error("The evidence sandbox requires a dedicated AI Gateway key, not AI_GATEWAY_API_KEY.");
  }
  return {
    env: { AI_GATEWAY_API_KEY: "placeholder", AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh" },
    networkPolicy: {
      allow: {
        "ai-gateway.vercel.sh": [{ transform: [{ headers: { Authorization: `Bearer ${apiKey}` } }] }],
        "*": [],
      },
    },
  };
}

export function evidenceTaskDocument(input: EvidenceTaskDocument): EvidenceTaskDocument {
  return {
    caseId: input.caseId,
    runId: input.runId,
    model: input.model,
    seat: input.seat,
    stage: input.stage,
    task: input.task,
    deadlineAt: input.deadlineAt,
    maxSteps: input.maxSteps,
    baseHashes: input.baseHashes,
    readOnlyHashes: input.readOnlyHashes,
    existingSeatPaths: [...input.existingSeatPaths],
  };
}

export function trustedInstructionOrigin(raw = process.env.INSTRUCTION_TOOL_ORIGIN): string {
  if (!raw) throw new Error("INSTRUCTION_TOOL_ORIGIN must name the trusted HTTPS application origin");
  const url = new URL(raw);
  if (url.protocol !== "https:" || url.username || url.password || url.pathname !== "/" || url.search || url.hash || /^(?:localhost|127\.|\[::1\])/.test(url.hostname) || url.hostname.endsWith(".local")) throw new Error("Invalid trusted instruction origin");
  return url.origin;
}

// New-format sandboxes have no source/gateway bypass and receive no secrets.
// The SDK adds Sandbox OIDC only to these narrowly forwarded requests.
export function instructionSandboxLaunch(caseId: string, origin: string): {
  env: { AI_GATEWAY_API_KEY: "placeholder"; AI_GATEWAY_BASE_URL: string; COURT_TOOL_ORIGIN: string };
  networkPolicy: NetworkPolicy;
} {
  origin = trustedInstructionOrigin(origin);
  if (!/^[a-zA-Z0-9_-]+$/.test(caseId)) throw new Error("Invalid sandbox case ID");
  const forwardURL = `${origin}/api/sandbox`;
  const deny = { response: { statusCode: 403 } } as const;
  return {
    env: { AI_GATEWAY_API_KEY: "placeholder", AI_GATEWAY_BASE_URL: "https://ai-gateway.vercel.sh/v4/ai", COURT_TOOL_ORIGIN: origin },
    networkPolicy: { allow: {
      [new URL(origin).hostname]: [{ match: { path: { exact: `/api/cases/${caseId}/turn-tools` }, method: ["POST"] }, forwardURL }, deny],
      "ai-gateway.vercel.sh": [{ match: { path: { exact: "/v4/ai/language-model" }, method: ["POST"] }, forwardURL }, deny],
    } },
  };
}
