import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  serverExternalPackages: ["@cursor/sdk"],
  experimental: { serverActions: { bodySizeLimit: "5mb" } },
};

export default nextConfig;
