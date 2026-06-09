import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  reactStrictMode: true,
  serverExternalPackages: ['better-sqlite3', 'hyco-ws', 'pino', 'pino-roll', 'pino-pretty'],
  allowedDevOrigins: [
    'oldest-eating-spice-restoration.trycloudflare.com',
    'headphones-frequency-routers-liked.trycloudflare.com',
  ],
};

export default nextConfig;
