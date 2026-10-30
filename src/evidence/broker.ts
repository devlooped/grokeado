import type { EvidenceSeat, EvidenceStage } from "./schema.ts";

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
