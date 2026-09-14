import {
  LIVE_WORKFLOW_TEMPLATE, LIVE_SOURCE, TRACE_QUERY_TEMPLATE, WORKFLOW_SUMMARY_SOURCE
} from './generated/kernel-sources';
import type { LiveRequest } from './types';

export const TRACE_JSON_PREFIX = 'SPACETIMEPY_TRACE_JSON:';
export const REEXECUTE_JSON_PREFIX = 'SPACETIMEPY_REEXECUTE_JSON:';

export function buildLiveCode(request: LiveRequest): string {
  return LIVE_WORKFLOW_TEMPLATE
    .replace('# __SPX_WORKFLOW_SUMMARY__', () => WORKFLOW_SUMMARY_SOURCE)
    .replace('# __SPX_LIVE_SOURCE__', () => LIVE_SOURCE)
    .replace('__SPX_REQUEST_JSON__', () => JSON.stringify(JSON.stringify(request)))
    .replace('__SPX_REEXECUTE_JSON_PREFIX__', REEXECUTE_JSON_PREFIX);
}

export function buildTraceCode(sessionId: string): string {
  return TRACE_QUERY_TEMPLATE
    .replace('__SPX_REQUEST_JSON__', () => JSON.stringify(JSON.stringify({ sessionId })))
    .replace('__SPX_TRACE_JSON_PREFIX__', TRACE_JSON_PREFIX);
}

export function isolateKernelCode(code: string): string {
  return `exec(compile(${JSON.stringify(code)}, "<spacetimepy-jupyterlab>", "exec"), {"__builtins__": __import__("builtins").__dict__})`;
}
