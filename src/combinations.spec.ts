import { describe, expect, it } from 'vitest';

import {
  combinationForTargets,
  matchingPrefixLength,
  parseCombinationKey
} from './combinations';
import type { VariantTarget } from './types';

const targets: VariantTarget[] = [
  {
    id: 'A',
    label: 'A',
    original: 'A1',
    range: { start: { line: 0, column: 0 }, end: { line: 0, column: 2 } },
    activeVariantId: 'A2',
    variants: [
      { id: 'A1', label: 'Original', code: 'A1' },
      { id: 'A2', label: 'Larger', code: 'A2' }
    ]
  },
  {
    id: 'B',
    label: 'B',
    original: 'B1',
    range: { start: { line: 1, column: 0 }, end: { line: 1, column: 2 } },
    activeVariantId: 'B2',
    variants: [
      { id: 'B1', label: 'Original', code: 'B1' },
      { id: 'B2', label: 'Plus page', code: 'B2' }
    ]
  }
];

describe('variant combinations', () => {
  it('builds active and original combinations', () => {
    expect(combinationForTargets(targets)).toEqual({
      key: '[["A","A2"],["B","B2"]]',
      label: 'Larger + Plus page'
    });
    expect(combinationForTargets(targets, true)).toEqual({
      key: '[["A","A1"],["B","B1"]]',
      label: 'Original'
    });
  });

  it('selects the longest reusable workflow prefix', () => {
    const desired = parseCombinationKey('[["A","A2"],["B","B2"]]')!;
    const original = parseCombinationKey('[["A","A1"],["B","B1"]]')!;
    const a2b1 = parseCombinationKey('[["A","A2"],["B","B1"]]')!;
    const a1b2 = parseCombinationKey('[["A","A1"],["B","B2"]]')!;
    expect(matchingPrefixLength(desired, original)).toBe(0);
    expect(matchingPrefixLength(desired, a2b1)).toBe(1);
    expect(matchingPrefixLength(desired, a1b2)).toBe(0);
  });

  it('rejects malformed keys', () => {
    expect(parseCombinationKey('{"A":"A2"}')).toBeNull();
    expect(parseCombinationKey('not-json')).toBeNull();
  });
});
