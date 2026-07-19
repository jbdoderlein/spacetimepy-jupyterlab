import { describe, expect, it } from 'vitest';

import {
  buildFinishWorkflowRecordingCode,
  buildReexecutionCode,
  isolateKernelCode,
  REEXECUTE_JSON_PREFIX,
  TRACE_JSON_PREFIX,
  TRACE_QUERY_CODE
} from './kernel-code';
import type { VariantReexecutionRequest } from './types';

const request: VariantReexecutionRequest = {
  source: [
    'w = workflow.filter_operator(1).output(writer)',
    'w.execute_workflow()'
  ].join('\\n'),
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
    expect(code).toContain('terminal_execution_call = next(');
    expect(code).toContain('space.replay.run(');
    expect(code).toContain('execution_result = execution_function(');
    expect(code).toContain('from spacetimepy import get_active_spacetime');
    expect(code).not.toContain('spacetimepy.core');
    expect(code).not.toContain('__SPX_');
  });

  it('isolates extension helpers from the notebook user namespace', () => {
    const code = isolateKernelCode('temporary_value = 1');

    expect(code).toContain('exec(compile(');
    expect(code).toContain('<spacetimepy-jupyterlab>');
    expect(code).toContain('__import__("builtins").__dict__');
    expect(code).toContain('temporary_value = 1');
  });

  it('builds the workflow recording safety-net call', () => {
    const completed = buildFinishWorkflowRecordingCode('completed');
    const failed = buildFinishWorkflowRecordingCode('failed');

    expect(completed).toContain('finish_active_workflow_recording("completed")');
    expect(failed).toContain('finish_active_workflow_recording("failed")');
    expect(completed).not.toContain('__SPX_');
    expect(failed).not.toContain('__SPX_');
  });
});
