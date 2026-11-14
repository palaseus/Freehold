import type { NextConfig } from 'next';
import path from 'node:path';
const config: NextConfig = {
  output: 'standalone',
  outputFileTracingRoot: path.resolve(__dirname),
  poweredByHeader: false,
  // Use the TypeScript compiler API; the CLI path is unreliable in mounted
  // workspaces where the tsc subprocess can return empty captured output.
  experimental: { useTypeScriptCli: false },
  turbopack: { root: path.resolve(__dirname) },
  async headers() { return [{ source: '/:path*', headers: [
    { key: 'X-Content-Type-Options', value: 'nosniff' },
    { key: 'Referrer-Policy', value: 'same-origin' },
    { key: 'X-Frame-Options', value: 'DENY' },
    { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
  ] }]; },
};
export default config;
