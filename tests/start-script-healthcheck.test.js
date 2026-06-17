const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'start.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

function includesAll(...needles) {
  return needles.every((needle) => script.includes(needle));
}

assert(
  includesAll('Health check failed', 'Invoke-WebRequest', '$healthCheckUrl = "http://localhost:$AppPort/api/auth/providers"'),
  'start.ps1 should continuously health-check the /api/auth/providers endpoint and fail when it is unhealthy'
);

assert(
  includesAll('Waiting for server to become ready', 'startupReady', 'did not become ready within 60 seconds'),
  'start.ps1 should verify the health check URL responds before entering the monitoring loop'
);

assert(
  includesAll('$server.HasExited', '$tunnel.HasExited'),
  'start.ps1 should monitor both the Next.js server process and the tunnel process'
);

assert(
  includesAll('$tunnelHealthCheckUrl', '$tunnelHealthFailures', '$DevTunnelUrl', 'Tunnel health check failed'),
  'start.ps1 should probe the public dev tunnel URL and fail when the tunnel is unreachable even if the process is still running'
);

assert(
  includesAll('-ge 200 -and $tunnelResponse.StatusCode -lt 400', '-ge 200 -and $statusCode -lt 400'),
  'start.ps1 should treat HTTP 4xx and 5xx tunnel health responses as failures'
);

assert(
  includesAll('$AppPort = 3000', 'next start --port $AppPort'),
  'start.ps1 should start Next.js on the same port it health-checks and exposes through the dev tunnel'
);

assert(
  /exit\s+1/i.test(script),
  'start.ps1 should exit non-zero when the supervised server/tunnel becomes unhealthy so service-watchdog.ps1 restarts it'
);

console.log('start.ps1 health supervision checks passed');
