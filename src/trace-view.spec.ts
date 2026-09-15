// @vitest-environment jsdom
import { expect, it, vi } from 'vitest';
import type { SpaceTimeTracePayload } from './types';

vi.mock('@lumino/widgets', () => ({ Widget: class {
  node = document.createElement('div');
  title = { label: '', caption: '' };
  addClass(name: string) { this.node.classList.add(name); }
} }));
import { SpaceTimeWebView } from './trace-view';

it('selects output endpoints with the feature selector beside the title', () => {
  const select = vi.fn();
  const view = new SpaceTimeWebView(select);
  const stage = { index: 1, label: 'Filter', sampleSize: 3, histograms: {} };
  const trace: SpaceTimeTracePayload = {
    loaded: true, rootBranchId: '1', features: ['commitNb'],
    branches: [
      { id: '1', source: 'parent', parentId: null,
        operators: ['filter(A)', 'sample(B)'], stages: [stage, stage], stageStepIds: [1, 2], output: stage, alignment: null },
      { id: '2', source: 'child', parentId: '1',
        operators: ['filter(A)', 'other(C)'], stages: [stage, stage], stageStepIds: [1, 3], output: stage,
        alignment: { pairs: [[0, 0]], deleted: [1], inserted: [1] } },
      { id: '3', source: 'deletion', parentId: '2',
        operators: ['filter(A)'], stages: [stage], stageStepIds: [1], output: stage,
        alignment: { pairs: [[0, 0]], deleted: [1], inserted: [] } }
    ],
    nodes: [
      { id: 1, function: 'filter(A)', arguments: [], stage },
      { id: 2, function: 'sample(B)', arguments: [], stage },
      { id: 3, function: 'other(C)', arguments: [], stage,
        branch: { id: '2', label: 'Edit', fromStepId: 1, sourceStepId: 2 } }
    ]
  };
  view.renderTrace(trace, '2');
  expect(view.node.querySelector('table')).toBeNull();
  const header = view.node.querySelector('.spx-trace-header')!;
  expect(header.querySelector('.spx-trace-title')).not.toBeNull();
  expect(header.querySelector('select')?.value).toBe('commitNb');
  const endpoints = [...view.node.querySelectorAll<HTMLElement>('[role="button"]')];
  expect(endpoints).toHaveLength(3);
  expect(endpoints.every(node => node.textContent?.includes('Output'))).toBe(true);
  endpoints.find(node => node.textContent?.includes('Branch 3'))!.click();
  expect(select).toHaveBeenLastCalledWith('3');
  endpoints.find(node => node.textContent?.includes('Branch 1'))!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
  expect(select).toHaveBeenLastCalledWith('1');
  expect(view.node.querySelector('[aria-current="true"]')?.textContent).toContain('Branch 2');
});


it('aligns random-selection cards after a filter deletion and a later insertion', () => {
  const stage = { index: 1, label: 'Stage', sampleSize: 3, histograms: {} };
  const branch = (id: string, parentId: string | null, ids: number[], pairs: Array<[number, number]>): SpaceTimeTracePayload['branches'][number] => ({
    id, parentId, source: id, stageStepIds: ids, output: stage,
    operators: ids.map(value => `operator ${value}`), stages: ids.map(() => stage),
    alignment: parentId === null ? null : { pairs, inserted: [], deleted: [] }
  });
  const trace: SpaceTimeTracePayload = {
    loaded: true, rootBranchId: '1', features: [],
    branches: [
      branch('1', null, [1, 2, 3], []),
      branch('2', '1', [1, 4], [[0, 0], [2, 1]]),
      branch('3', '2', [1, 5, 6], [[0, 0], [1, 2]]),
      branch('4', '2', [1], [[0, 0]])
    ],
    nodes: [
      { id: 1, function: 'commit filter', arguments: [], stage },
      { id: 2, function: 'language filter', arguments: [], stage },
      { id: 3, function: 'original random', arguments: [], stage },
      { id: 4, function: 'edited random', arguments: [], stage,
        branch: { id: '2', label: 'Delete filter', fromStepId: 1, sourceStepId: 2 } },
      { id: 5, function: 'inserted operator', arguments: [], stage,
        branch: { id: '3', label: 'Insert operator', fromStepId: 1, sourceStepId: 4 } },
      { id: 6, function: 'later random', arguments: [], stage,
        branch: { id: '3', label: 'Insert operator', fromStepId: 1, sourceStepId: 4 } }
    ]
  };
  const view = new SpaceTimeWebView(vi.fn());
  view.renderTrace(trace, '3');
  const items = [...view.node.querySelectorAll<HTMLElement>('.spx-trace-tree-item')];
  const top = (label: string): number => parseFloat(items.find(item =>
    item.querySelector('.spx-trace-function')?.textContent === label)!.style.top);
  expect(top('original random')).toBe(top('edited random'));
  expect(top('original random')).toBe(top('later random'));
  expect(top('language filter')).toBeLessThan(top('original random'));
  expect(top('inserted operator')).toBeLessThan(top('later random'));
  expect(top('commit filter')).toBeLessThan(top('inserted operator'));
  const outputs = items.filter(item => item.querySelector('.spx-trace-function')?.textContent === 'Output');
  expect(new Set(outputs.map(item => item.style.top)).size).toBe(1);
  expect(parseFloat(outputs[0].style.top)).toBeGreaterThan(top('later random'));
});
