const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'deploy.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

function includesAll(...needles) {
  return needles.every((needle) => script.includes(needle));
}

assert(
  includesAll('safe-restart.ps1', 'Deploy = $true', 'SkipGitPull', 'NoWait', 'WaitSeconds'),
  'deploy.ps1 should delegate the guarded deployment sequence to safe-restart.ps1'
);

assert(
  !/npm\s+install/i.test(script),
  'deploy.ps1 should not use npm install'
);

assert(
  !script.includes('Stop-Port3000Processes') && !script.includes('Get-NetTCPConnection'),
  'deploy.ps1 should not kill arbitrary port owners'
);

assert(
  !script.includes('npm ci') || script.indexOf('acquire-lease') < script.indexOf('npm ci'),
  'if deploy.ps1 performs work directly, it must acquire the lease before npm ci'
);

console.log('deploy.ps1 scheduled task validation checks passed');
