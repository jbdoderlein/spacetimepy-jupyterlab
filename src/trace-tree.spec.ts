import { describe, expect, it } from 'vitest';

import { buildWorkflowTree } from './trace-tree';
import type {
  SpaceTimeTraceBranch,
  SpaceTimeTraceNode,
  SpaceTimeTracePayload,
  WorkflowTreeDatum
} from './types';

const keys = {
  a1b1: '[["A","A1"],["B","B1"]]',
  a2b1: '[["A","A2"],["B","B1"]]',
  a1b2: '[["A","A1"],["B","B2"]]',
  a2b2: '[["A","A2"],["B","B2"]]'
};

function branch(
  id: string,
  label: string,
  fromStepId: number | null,
  sourceStepId: number,
  combinationKey: string
): SpaceTimeTraceBranch {
  return { id, label, fromStepId, sourceStepId, combinationKey };
}

function node(id: number, branchData?: SpaceTimeTraceBranch): SpaceTimeTraceNode {
  return {
    id,
    function: 'filter_operator',
    branch: branchData,
    arguments: []
  };
}

function find(root: WorkflowTreeDatum, id: number): WorkflowTreeDatum {
  if (root.node.id === id) {
    return root;
  }
  for (const child of root.children) {
    const match = findOptional(child, id);
    if (match) {
      return match;
    }
  }
  throw new Error(`Node ${id} not found`);
}

function findOptional(
  root: WorkflowTreeDatum,
  id: number
): WorkflowTreeDatum | null {
  if (root.node.id === id) {
    return root;
  }
  for (const child of root.children) {
    const match = findOptional(child, id);
    if (match) {
      return match;
    }
  }
  return null;
}

describe('workflow tree', () => {
  it('labels both existing and replayed sides of every fork', () => {
    const trace: SpaceTimeTracePayload = {
      loaded: true,
      features: [],
      nodes: [
        node(1),
        node(2),
        node(3, branch('a2b1', 'Larger', null, 1, keys.a2b1)),
        node(4, branch('a2b1', 'Larger', null, 2, keys.a2b1)),
        node(5, branch('a1b2', 'Plus page', 1, 2, keys.a1b2)),
        node(6, branch('a2b2', 'Plus page', 3, 2, keys.a2b2))
      ]
    };
    const labels = new Map([
      ['A1', 'Original'],
      ['A2', 'Larger'],
      ['B1', 'Original'],
      ['B2', 'Plus page']
    ]);
    const tree = buildWorkflowTree(trace, keys.a1b1, 'Original', labels);

    expect(tree.children.map(child => child.edgeLabel)).toEqual([
      'Original',
      'Larger'
    ]);
    expect(find(tree, 1).children.map(child => child.edgeLabel)).toEqual([
      'Original',
      'Plus page'
    ]);
    expect(find(tree, 3).children.map(child => child.edgeLabel)).toEqual([
      'Original',
      'Plus page'
    ]);
  });

  it('uses a non-original combination as the unbranched baseline', () => {
    const trace: SpaceTimeTracePayload = {
      loaded: true,
      features: [],
      nodes: [node(1), node(2)]
    };
    const tree = buildWorkflowTree(
      trace,
      keys.a2b2,
      'Larger + Plus page',
      new Map()
    );
    expect(tree.children[0].edgeLabel).toBe('Larger + Plus page');
    expect(find(tree, 2).combinationKey).toBe(keys.a2b2);
  });
});
