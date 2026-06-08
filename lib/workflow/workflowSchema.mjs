const TEMPLATE_RE = /\{\{\s*([a-zA-Z0-9_-]+)\.output\s*\}\}/g;

function err(error) {
  return { ok: false, error };
}

export function validateWorkflowPlan(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return err({ code: 'not_object', message: 'Plan must be a JSON object' });
  }
  const p = raw;
  if (p.version !== 1) {
    return err({ code: 'wrong_type', field: 'version', message: 'version must be 1' });
  }
  if (!Array.isArray(p.nodes)) {
    return err({ code: 'wrong_type', field: 'nodes', message: 'nodes must be an array' });
  }
  if (p.nodes.length === 0) {
    return err({ code: 'empty_nodes', message: 'nodes must not be empty' });
  }

  const seen = new Set();
  const nodes = [];
  for (const n of p.nodes) {
    if (!n || typeof n !== 'object') {
      return err({ code: 'wrong_type', field: 'node', message: 'node must be an object' });
    }
    for (const f of ['id', 'agent', 'instruction']) {
      if (typeof n[f] !== 'string' || n[f].length === 0) {
        return err({ code: 'missing_field', field: f, message: `node.${f} required (non-empty string)` });
      }
    }
    if (!Array.isArray(n.dependsOn)) {
      return err({ code: 'wrong_type', field: 'dependsOn', message: 'dependsOn must be an array', nodeId: n.id });
    }
    if (n.dependsOn.some((d) => typeof d !== 'string')) {
      return err({ code: 'wrong_type', field: 'dependsOn', message: 'dependsOn entries must be strings', nodeId: n.id });
    }
    if (seen.has(n.id)) {
      return err({ code: 'duplicate_node_id', message: `duplicate node id "${n.id}"`, nodeId: n.id });
    }
    seen.add(n.id);
    nodes.push({ id: n.id, agent: n.agent, instruction: n.instruction, dependsOn: [...n.dependsOn] });
  }

  for (const n of nodes) {
    for (const d of n.dependsOn) {
      if (!seen.has(d)) {
        return err({ code: 'unknown_dependency', message: `node "${n.id}" depends on unknown "${d}"`, nodeId: n.id });
      }
    }
  }

  // Kahn topological sort for cycle detection.
  const indeg = new Map(nodes.map((n) => [n.id, n.dependsOn.length]));
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.dependsOn) adj.get(d).push(n.id);
  const queue = nodes.filter((n) => indeg.get(n.id) === 0).map((n) => n.id);
  const topo = [];
  while (queue.length) {
    const id = queue.shift();
    topo.push(id);
    for (const next of adj.get(id)) {
      indeg.set(next, indeg.get(next) - 1);
      if (indeg.get(next) === 0) queue.push(next);
    }
  }
  if (topo.length !== nodes.length) {
    return err({ code: 'cycle', message: 'workflow contains a cycle' });
  }

  // Compute transitive deps to validate template references.
  const transitive = new Map();
  for (const id of topo) {
    const node = nodes.find((n) => n.id === id);
    const set = new Set(node.dependsOn);
    for (const d of node.dependsOn) for (const t of transitive.get(d)) set.add(t);
    transitive.set(id, set);
  }
  for (const n of nodes) {
    TEMPLATE_RE.lastIndex = 0;
    let m;
    while ((m = TEMPLATE_RE.exec(n.instruction)) !== null) {
      const ref = m[1];
      if (!transitive.get(n.id).has(ref)) {
        return err({
          code: 'unknown_template_ref',
          message: `node "${n.id}" references {{${ref}.output}} but "${ref}" is not a (transitive) dependency`,
          nodeId: n.id,
        });
      }
    }
  }

  const plan = { version: 1, nodes };
  if (typeof p.name === 'string') plan.name = p.name;
  return { ok: true, plan };
}
