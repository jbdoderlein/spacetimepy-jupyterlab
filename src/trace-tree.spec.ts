import { expect, it } from 'vitest';
import { buildWorkflowTree } from './trace-tree';
import type { SpaceTimeTracePayload } from './types';

it('attaches a child suffix to the shared parent prefix', () => {
  const trace: SpaceTimeTracePayload = {
    loaded: true, rootBranchId: '1', branches: [], features: [], nodes: [
      { id: 1, function: 'filter', arguments: [] },
      { id: 2, function: 'sample', arguments: [] },
      { id: 3, function: 'sample', arguments: [], branch: { id: '2', label: 'Edit', fromStepId: 1, sourceStepId: 2 } },
      { id: 4, function: 'sample', arguments: [], branch: { id: '3', label: 'Edit again', fromStepId: 1, sourceStepId: 3 } }
    ]
  };
  const root = buildWorkflowTree(trace);
  expect(root.children).toHaveLength(1);
  expect(root.children[0].children.map(child => child.branchId)).toEqual(['1', '2', '3']);
});
