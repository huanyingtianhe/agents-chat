const assert = require('assert');
const fs = require('fs');
const path = require('path');

const scriptPath = path.resolve(__dirname, '..', 'scripts', 'deploy.ps1');
const script = fs.readFileSync(scriptPath, 'utf8');

function includesAll(...needles) {
  return needles.every((needle) => script.includes(needle));
}

assert(
  includesAll('$ExpectedWatchdogScript', 'Join-Path $PSScriptRoot \'service-watchdog.ps1\'', 'WorkingDirectory'),
  'deploy.ps1 should validate that the Scheduled Task action points to scripts/service-watchdog.ps1 with the expected working directory'
);

assert(
  includesAll('$watchdogLogLastWriteBefore', '$watchdogLogUpdated', 'LastWriteTimeUtc'),
  'deploy.ps1 should require a fresh watchdog log update instead of treating stale logs as proof that the task started'
);

assert(
  includesAll('Installing npm dependencies', 'npm install --no-audit --no-fund', "throw 'npm install failed'"),
  'deploy.ps1 should install npm dependencies before restarting the Scheduled Task'
);

assert(
  !script.includes('if ((Test-Path $WatchdogLog) -or ($task -and $task.State -eq \'Running\') -or ($taskInfo -and $taskInfo.LastRunTime -ne $lastRunBefore))'),
  'deploy.ps1 should not treat an existing stale watchdog log or LastRunTime change alone as a successful task start'
);

console.log('deploy.ps1 scheduled task validation checks passed');
