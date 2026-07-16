import { describe, expect, it } from 'vitest';

import {
  buildReexecutionCode,
  REEXECUTE_JSON_PREFIX,
  TRACE_JSON_PREFIX,
  TRACE_QUERY_CODE
} from './kernel-code';
import type { VariantReexecutionRequest } from './types';

const request: VariantReexecutionRequest = {
  source: 'workflow.filter_operator(1)',
  targets: [
    {
      targetId: 'A',
      variantId: 'A2',
      variantLabel: 'Larger',
      range: {
        start: { line: 0, column: 25 },
        end: { line: 0, column: 26 }
      }
    }
  ],
  combinationKey: '[["A","A2"]]',
  combinationLabel: 'Larger',
  baselineCombinationKey: '[["A","A1"]]',
  originalCombinationKey: '[["A","A1"]]'
};

describe('kernel code templates', () => {
  it('assembles the trace query without unresolved placeholders', () => {
    expect(TRACE_QUERY_CODE).toContain('def _spx_summarize_workflow(value):');
    expect(TRACE_QUERY_CODE).toContain(`print("${TRACE_JSON_PREFIX}"`);
    expect(TRACE_QUERY_CODE).not.toContain('__SPX_');
  });

  it('embeds the replay request and output prefix', () => {
    const code = buildReexecutionCode(request);
    const encodedRequest = JSON.stringify(JSON.stringify(request));

    expect(code).toContain(`request = json.loads(${encodedRequest})`);
    expect(code).toContain(`print("${REEXECUTE_JSON_PREFIX}"`);
    expect(code).not.toContain('__SPX_');
  });
});
