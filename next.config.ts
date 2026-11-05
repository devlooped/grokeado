import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  allowedDevOrigins: ["**.ts.net"],
  serverExternalPackages: ["impit", "linkedom", "defuddle", "turndown", "@browserbasehq/sdk", "playwright-core"],
  // Runtime-loaded browser metadata and the harness uploaded to new sandboxes.
  outputFileTracingIncludes: { "/*": ["node_modules/playwright-core/browsers.json", "sandbox/harness/instruction-agent.ts", "sandbox/harness/compute.ts"] },
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default withWorkflow(nextConfig);
