import type { SpaceTimeTracePayload, WorkflowTreeDatum } from './types';

export function buildWorkflowTree(trace: SpaceTimeTracePayload): WorkflowTreeDatum {
  const root: WorkflowTreeDatum = {
    node: { id: 'input', function: 'Input', stage: trace.inputStage, arguments: [] },
    children: []
  };
  const nodes = new Map<string, WorkflowTreeDatum>();
  const groups = new Map<string, WorkflowTreeDatum[]>();
  for (const node of trace.nodes) {
    const datum: WorkflowTreeDatum = { node, children: [] };
    nodes.set(String(node.id), datum);
    const id = node.branch?.id ?? trace.rootBranchId;
    const group = groups.get(id) ?? [];
    group.push(datum);
    groups.set(id, group);
  }
  for (const group of groups.values()) {
    const branch = group[0].node.branch;
    const parent = branch?.fromStepId != null
      ? nodes.get(String(branch.fromStepId))! : root;
    parent.children.push(group[0]);
    group[0].edgeLabel = branch?.label ?? 'Initial execution';
    for (let i = 1; i < group.length; i++) {
      group[i - 1].children.push(group[i]);
    }

  }
  for (const branch of trace.branches) {
    const parent = nodes.get(String(branch.stageStepIds[branch.stageStepIds.length - 1]))!;
    parent.children.push({
      node: { id: `output-${branch.id}`, function: 'Output', stage: branch.output, arguments: [] },
      branchId: branch.id,
      edgeLabel: `Branch ${branch.id}`,
      children: []
    });
  }
  return root;
}

/** Place corresponding stages on one row and preserve execution order. */
export function workflowRows(trace: SpaceTimeTracePayload, root: WorkflowTreeDatum): Map<WorkflowTreeDatum, number> {
  const data: WorkflowTreeDatum[] = [];
  const visit = (node: WorkflowTreeDatum): void => {
    data.push(node);
    node.children.forEach(visit);
  };
  visit(root);
  const byId = new Map(data.map(node => [String(node.node.id), node]));
  const representatives = new Map(data.map(node => [node, node]));
  const find = (node: WorkflowTreeDatum): WorkflowTreeDatum => {
    const parent = representatives.get(node)!;
    if (parent === node) { return node; }
    const representative = find(parent);
    representatives.set(node, representative);
    return representative;
  };
  const join = (a: WorkflowTreeDatum, b: WorkflowTreeDatum): void => {
    representatives.set(find(b), find(a));
  };
  const branches = new Map(trace.branches.map(branch => [branch.id, branch]));
  for (const branch of trace.branches) {
    if (branch.parentId === null) { continue; }
    const parent = branches.get(branch.parentId)!;
    for (const [oldIndex, newIndex] of branch.alignment!.pairs) {
      join(byId.get(String(parent.stageStepIds[oldIndex]))!, byId.get(String(branch.stageStepIds[newIndex]))!);
    }
  }
  // Output endpoints share a final row. They remain separate selectable nodes.
  const outputs = data.filter(node => node.branchId !== undefined);
  for (const output of outputs.slice(1)) { join(outputs[0], output); }

  const groups = new Set(data.map(find));
  const successors = new Map([...groups].map(group => [group, new Set<WorkflowTreeDatum>()]));
  const incoming = new Map([...groups].map(group => [group, 0]));
  const rows = new Map([...groups].map(group => [group, 0]));
  for (const node of data) {
    for (const child of node.children) {
      const from = find(node);
      const to = find(child);
      if (!successors.get(from)!.has(to)) {
        successors.get(from)!.add(to);
        incoming.set(to, incoming.get(to)! + 1);
      }
    }
  }
  const ready = [...groups].filter(group => incoming.get(group) === 0);
  for (let index = 0; index < ready.length; index++) {
    const group = ready[index];
    for (const next of successors.get(group)!) {
      rows.set(next, Math.max(rows.get(next)!, rows.get(group)! + 1));
      incoming.set(next, incoming.get(next)! - 1);
      if (incoming.get(next) === 0) { ready.push(next); }
    }
  }
  if (ready.length !== groups.size) {
    throw new Error('Stage correspondence conflicts with execution order.');
  }
  return new Map(data.map(node => [node, rows.get(find(node))!]));
}
