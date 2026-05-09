import type { NextConfig } from "next";
import path from "path";

const nextConfig: NextConfig = {
  // libsql is a native module — must run server-side, never bundled.
  serverExternalPackages: ["libsql"],

  // Allow Next to pull source from outside this package (../src/**).
  outputFileTracingRoot: path.join(__dirname, ".."),

  webpack: (config) => {
    // The CLI source uses NodeNext-style ".js" suffixes that resolve to ".ts" files.
    // Tell webpack to do the same so imports from ../src work.
    config.resolve.extensionAlias = {
      ".js": [".ts", ".tsx", ".js"],
      ".mjs": [".mts", ".mjs"],
    };
    return config;
  },
};

export default nextConfig;
