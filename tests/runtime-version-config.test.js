const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const projectRoot = path.resolve(__dirname, '..');

function readProjectFile(relativePath) {
  return fs.readFileSync(path.join(projectRoot, relativePath), 'utf8');
}

test('the project standardizes on Node.js 24', () => {
  const pkg = JSON.parse(readProjectFile('package.json'));
  const nodeVersion = readProjectFile('.node-version');
  const npmrc = readProjectFile('.npmrc');
  const playwrightWorkflow = readProjectFile('.github/workflows/playwright.yml');
  const releaseWorkflow = readProjectFile('.github/workflows/release.yml');
  const readme = readProjectFile('README.md');

  assert.equal(pkg.engines.node, '>=24 <25');
  assert.equal(nodeVersion.trim(), '24');
  assert.match(npmrc, /^engine-strict=true$/m);
  assert.doesNotMatch(playwrightWorkflow, /node-version:\s*(20|22)\b/);
  assert.doesNotMatch(releaseWorkflow, /node-version:\s*(20|22)\b/);
  assert.match(readme, /\*\*Node\.js\*\* 24\.x/);
});
