import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";
import { configureWorkflowStepTimeout } from "./src/lib/workflow-step-timeout.ts";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["**.ts.net"],
  serverExternalPackages: ["impit", "linkedom", "defuddle", "turndown", "@browserbasehq/sdk", "playwright-core"],
  // Runtime-loaded browser metadata and the harness uploaded to new sandboxes.
  outputFileTracingIncludes: { "/*": ["node_modules/playwright-core/browsers.json", "sandbox/harness/instruction-agent.ts", "sandbox/harness/compute.ts"] },
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

const workflowConfig = withWorkflow(nextConfig);
export default async function config(phase: string, context: { defaultConfig: NextConfig }): Promise<NextConfig> {
  const config = await workflowConfig(phase, context);
  if (phase === "phase-production-build") {
    await configureWorkflowStepTimeout("src/app/.well-known/workflow/v1/config.json", process.env.STEP_TIMEOUT);
  }
  return config;
}
