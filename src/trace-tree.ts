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
  for (const [id, group] of groups) {
    const branch = group[0].node.branch;
    const parent = branch?.fromStepId != null
      ? nodes.get(String(branch.fromStepId))! : root;
    parent.children.push(group[0]);
    group[0].edgeLabel = branch?.label ?? 'Initial execution';
    for (let i = 1; i < group.length; i++) {
      group[i - 1].children.push(group[i]);
    }
    group[group.length - 1].branchId = id;
  }
  return root;
}
