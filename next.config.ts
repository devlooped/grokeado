import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["impit", "linkedom", "defuddle", "turndown", "@browserbasehq/sdk", "playwright-core"],
  // Playwright loads this at runtime, but Next's file tracing misses it.
  outputFileTracingIncludes: { "/*": ["node_modules/playwright-core/browsers.json"] },
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default withWorkflow(nextConfig);
