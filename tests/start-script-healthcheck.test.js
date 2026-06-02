const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '..', 'start.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

function includesAll(...needles) {
  return needles.every((needle) => script.includes(needle));
}

assert(
  includesAll('Health check failed', 'Invoke-WebRequest', 'http://localhost:3000/api/auth/providers'),
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
  /exit\s+1/i.test(script),
  'start.ps1 should exit non-zero when the supervised server/tunnel becomes unhealthy so service-watchdog.ps1 restarts it'
);

console.log('start.ps1 health supervision checks passed');
