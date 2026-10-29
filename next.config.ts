import type { NextConfig } from "next";
import { withWorkflow } from "workflow/next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@cursor/sdk"],
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default withWorkflow(nextConfig);
