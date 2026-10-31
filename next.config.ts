import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["impit", "linkedom", "defuddle", "turndown", "@browserbasehq/sdk", "playwright-core"],
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default withWorkflow(nextConfig);
