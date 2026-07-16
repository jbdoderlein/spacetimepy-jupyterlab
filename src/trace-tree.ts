import { matchingPrefixLength, parseCombinationKey } from './combinations';
import type {
  SpaceTimeTraceNode,
  SpaceTimeTracePayload,
  WorkflowTreeDatum
} from './types';

export function buildWorkflowTree(
  trace: SpaceTimeTracePayload,
  baselineCombinationKey: string,
  baselineCombinationLabel: string,
  variantLabelById: Map<string, string>
): WorkflowTreeDatum {
  const inputNode: SpaceTimeTraceNode = {
    id: 'workflow-input',
    function: 'Workflow input',
    stage: trace.inputStage,
    arguments: []
  };
  const root: WorkflowTreeDatum = { node: inputNode, children: [] };
  const treeNodeByCallId = new Map<string, WorkflowTreeDatum>([
    [String(inputNode.id), root]
  ]);
  const baselineNodes = trace.nodes.filter(node => !node.branch);
  let baselineParent = root;
  baselineNodes.forEach((node, index) => {
    const datum: WorkflowTreeDatum = {
      node,
      children: [],
      edgeLabel: index === 0 ? baselineCombinationLabel : undefined
    };
    baselineParent.children.push(datum);
    baselineParent = datum;
    treeNodeByCallId.set(String(node.id), datum);
  });
  baselineParent.combinationKey = baselineCombinationKey;

  const branchesById = new Map<string, SpaceTimeTraceNode[]>();
  for (const node of trace.nodes.filter(candidate => candidate.branch)) {
    const branchId = node.branch!.id;
    const group = branchesById.get(branchId) ?? [];
    group.push(node);
    branchesById.set(branchId, group);
  }
  const branchesByCombination = new Map<string, SpaceTimeTraceNode[]>();
  for (const branchNodes of branchesById.values()) {
    const branch = branchNodes[0].branch!;
    branchesByCombination.set(branch.combinationKey ?? branch.id, branchNodes);
  }

  const branchData = Array.from(branchesByCombination.values()).map(
    branchNodes => {
      const data = branchNodes.map(
        (node): WorkflowTreeDatum => ({ node, children: [] })
      );
      data.forEach(datum => {
        treeNodeByCallId.set(String(datum.node.id), datum);
      });
      return { branchNodes, data };
    }
  );

  for (const { branchNodes, data } of branchData) {
    if (data.length === 0) {
      continue;
    }
    const branch = branchNodes[0].branch!;
    const sourceIndex = baselineNodes.findIndex(
      node => String(node.id) === String(branch.sourceCallId)
    );
    const fallbackParent =
      sourceIndex > 0
        ? treeNodeByCallId.get(String(baselineNodes[sourceIndex - 1].id))
        : root;
    const branchParent =
      branch.fromCallId !== null
        ? treeNodeByCallId.get(String(branch.fromCallId)) ?? fallbackParent
        : fallbackParent;
    data[0].edgeLabel = branch.label ?? branch.combinationLabel ?? 'Variant';
    (branchParent ?? root).children.push(data[0]);
    for (let index = 1; index < data.length; index++) {
      data[index - 1].children.push(data[index]);
    }
    data[data.length - 1].combinationKey = branch.combinationKey;
  }
  labelForks(root, variantLabelById);
  return root;
}

function labelForks(
  node: WorkflowTreeDatum,
  variantLabelById: Map<string, string>
): ReturnType<typeof parseCombinationKey> {
  const childCombinations = node.children.map(child =>
    labelForks(child, variantLabelById)
  );
  const available = childCombinations.filter(
    combination => combination !== null
  );
  if (
    node.children.length > 1 &&
    available.length === node.children.length
  ) {
    const forkIndex = available.slice(1).reduce(
      (prefixLength, combination) =>
        Math.min(
          prefixLength,
          matchingPrefixLength(available[0], combination)
        ),
      available[0].length
    );
    if (available.every(combination => forkIndex < combination.length)) {
      node.children.forEach((child, childIndex) => {
        const variantId = childCombinations[childIndex]?.[forkIndex]?.[1];
        if (variantId) {
          child.edgeLabel =
            variantLabelById.get(variantId) ?? child.edgeLabel ?? 'Variant';
        }
      });
    }
  }
  if (node.combinationKey) {
    return parseCombinationKey(node.combinationKey);
  }
  return childCombinations.find(combination => combination !== null) ?? null;
}
