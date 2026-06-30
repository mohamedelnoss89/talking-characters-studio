import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  reactStrictMode: true,
  typescript: {
    ignoreBuildErrors: true,
  },
  allowedDevOrigins: [
    "*.space-z.ai",
    "preview-*.space-z.ai",
    "preview-chat-*.space-z.ai",
  ],
};

export default nextConfig;
