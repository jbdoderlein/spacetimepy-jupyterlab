import { expect, it } from 'vitest';
import { buildWorkflowTree } from './trace-tree';
import type { SpaceTimeTracePayload } from './types';

it('attaches a child suffix to the shared parent prefix', () => {
  const trace: SpaceTimeTracePayload = {
    loaded: true, rootBranchId: '1', branches: [
      branch('1', [1, 2]), branch('2', [1, 3]), branch('3', [1, 4])
    ], features: [], nodes: [
      { id: 1, function: 'filter', arguments: [] },
      { id: 2, function: 'sample', arguments: [] },
      { id: 3, function: 'sample', arguments: [], branch: { id: '2', label: 'Edit', fromStepId: 1, sourceStepId: 2 } },
      { id: 4, function: 'sample', arguments: [], branch: { id: '3', label: 'Edit again', fromStepId: 1, sourceStepId: 3 } }
    ]
  };
  const root = buildWorkflowTree(trace);
  expect(root.children).toHaveLength(1);
  expect(root.children[0].children.map(child => child.children[0].branchId)).toEqual(['1', '2', '3']);
});

function branch(id: string, stageStepIds: number[]): SpaceTimeTracePayload['branches'][number] {
  return {
    id, source: id, parentId: id === '1' ? null : '1', operators: [], stages: [],
    stageStepIds, output: { index: stageStepIds.length, label: 'Output', sampleSize: 1, histograms: {} },
    alignment: null
  };
}

it('keeps all output endpoints when a branch appends or deletes its final operator', () => {
  const trace: SpaceTimeTracePayload = {
    loaded: true, rootBranchId: '1', features: [],
    branches: [branch('1', [1, 2]), branch('2', [1]), branch('3', [1, 2, 3]), branch('4', [1])],
    nodes: [
      { id: 1, function: 'filter', arguments: [] },
      { id: 2, function: 'sample', arguments: [] },
      { id: 3, function: 'filter', arguments: [], branch: { id: '3', label: 'Append', fromStepId: 2, sourceStepId: 10 } }
    ]
  };
  const root = buildWorkflowTree(trace);
  const first = root.children[0];
  expect(first.children.filter(node => node.branchId).map(node => node.branchId)).toEqual(['2', '4']);
  const last = first.children[0];
  expect(last.children.find(node => node.branchId === '1')?.node.function).toBe('Output');
  expect(last.children[0].children[0].branchId).toBe('3');
});
