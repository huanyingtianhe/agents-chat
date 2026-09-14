const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'start.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

function includesAll(...needles) {
  return needles.every((needle) => script.includes(needle));
}

assert(
  includesAll('Health check failed', 'Invoke-WebRequest', '$healthCheckUrl = "http://localhost:$AppPort/api/health/storage"'),
  'start.ps1 should continuously health-check the storage-aware endpoint and fail when it is unhealthy'
);

assert(
  includesAll('Waiting for server to become ready', 'startupReady', '$startupDeadline'),
  'start.ps1 should verify the health check URL responds before entering the monitoring loop'
);

assert(
  includesAll('$server.HasExited', '$tunnel.HasExited'),
  'start.ps1 should monitor both the Next.js server process and the tunnel process'
);

assert(
  includesAll('$tunnelHealthCheckUrl', '$tunnelHealthFailures', 'DEV_TUNNEL_URL', 'Tunnel health check failed'),
  'start.ps1 should probe the public dev tunnel URL and fail when the tunnel is unreachable even if the process is still running'
);

assert(
  includesAll('-ge 200 -and $response.StatusCode -lt 400', '-MaximumRedirection 5'),
  'start.ps1 should treat HTTP 4xx and 5xx tunnel health responses as failures'
);

assert(
  includesAll('[string]$NodePath', 'runtime-preflight.mjs', 'check-only', 'start-server.mjs', '--port', '$AppPort'),
  'start.ps1 should validate and launch with the same explicit Node.js executable and port'
);

assert(
  !/npm\s+run\s+build/i.test(script) && !/Remove-Item\s+-Recurse\s+-Force\s+\.next/i.test(script),
  'start.ps1 should serve an existing production build instead of rebuilding on every watchdog retry'
);

assert(
  includesAll('.next', 'BUILD_ID', 'deploy.ps1'),
  'start.ps1 should direct operators to deploy.ps1 when the production build is absent'
);

assert(
  !script.includes('Get-NetTCPConnection'),
  'start.ps1 should never kill or otherwise mutate an arbitrary process merely because it owns the app port'
);

console.log('start.ps1 health supervision checks passed');
