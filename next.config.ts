import type { NextConfig } from 'next';

const runtimeDataTracingExcludes = [
  './.data/**/*',
  './.agents-chat-storage.json',
  './.agents-chat-storage.json.*',
  './.agents-chat-operation.json',
  './.agents-chat-operation.json.*',
];

const nextConfig: NextConfig = {
  reactStrictMode: true,
  output: 'standalone',
  outputFileTracingExcludes: {
    '*': runtimeDataTracingExcludes,
  },
  serverExternalPackages: ['better-sqlite3', 'hyco-ws', 'pino', 'pino-roll', 'pino-pretty'],
  allowedDevOrigins: [
    'oldest-eating-spice-restoration.trycloudflare.com',
    'headphones-frequency-routers-liked.trycloudflare.com',
  ],
};

export default nextConfig;
