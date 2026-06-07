const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.output\s*\}\}/g;
const INPUT_RE = /\{\{\s*input\s*\}\}/g;
const ANY_TEMPLATE_RE = /\{\{[^}]+\}\}/;

export function renderInstruction(instruction, userInput, upstreamOutputs, dependsOn) {
  const hasTemplate = ANY_TEMPLATE_RE.test(instruction);
  let result = instruction.replace(INPUT_RE, () => userInput);
  result = result.replace(TEMPLATE_RE, (_match, name) => {
    if (!(name in upstreamOutputs)) {
      throw new Error(`unknown template variable: {{${name}.output}}`);
    }
    return upstreamOutputs[name];
  });
  if (!hasTemplate && dependsOn.length > 0) {
    const parts = dependsOn
      .filter((d) => d in upstreamOutputs)
      .map((d) => `--- ${d}.output ---\n${upstreamOutputs[d]}`);
    if (parts.length) result = `${result}\n\n${parts.join('\n\n')}`;
  }
  return result;
}
