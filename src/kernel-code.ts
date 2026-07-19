import {
  REEXECUTE_VARIANT_TEMPLATE,
  TRACE_QUERY_TEMPLATE,
  WORKFLOW_SUMMARY_SOURCE
} from './generated/kernel-sources';
import type { VariantReexecutionRequest } from './types';

export const TRACE_JSON_PREFIX = 'SPACETIMEPY_TRACE_JSON:';
export const REEXECUTE_JSON_PREFIX = 'SPACETIMEPY_REEXECUTE_JSON:';

const WORKFLOW_SUMMARY_PLACEHOLDER = '# __SPX_WORKFLOW_SUMMARY__';
const TRACE_PREFIX_PLACEHOLDER = '__SPX_TRACE_JSON_PREFIX__';
const REEXECUTE_PREFIX_PLACEHOLDER = '__SPX_REEXECUTE_JSON_PREFIX__';
const REQUEST_PLACEHOLDER = '__SPX_REQUEST_JSON__';

function replacePlaceholder(
  template: string,
  placeholder: string,
  value: string
): string {
  const firstMatch = template.indexOf(placeholder);
  if (
    firstMatch === -1 ||
    template.indexOf(placeholder, firstMatch + placeholder.length) !== -1
  ) {
    throw new Error(`Expected exactly one ${placeholder} placeholder.`);
  }
  return (
    template.slice(0, firstMatch) +
    value +
    template.slice(firstMatch + placeholder.length)
  );
}

function withWorkflowSummary(template: string): string {
  return replacePlaceholder(
    template,
    WORKFLOW_SUMMARY_PLACEHOLDER,
    WORKFLOW_SUMMARY_SOURCE
  );
}

export const TRACE_QUERY_CODE = replacePlaceholder(
  withWorkflowSummary(TRACE_QUERY_TEMPLATE),
  TRACE_PREFIX_PLACEHOLDER,
  TRACE_JSON_PREFIX
);

export function buildReexecutionCode(
  request: VariantReexecutionRequest
): string {
  const withSummary = withWorkflowSummary(REEXECUTE_VARIANT_TEMPLATE);
  const withRequest = replacePlaceholder(
    withSummary,
    REQUEST_PLACEHOLDER,
    JSON.stringify(JSON.stringify(request))
  );
  return replacePlaceholder(
    withRequest,
    REEXECUTE_PREFIX_PLACEHOLDER,
    REEXECUTE_JSON_PREFIX
  );
}

export function isolateKernelCode(code: string): string {
  return `exec(compile(${JSON.stringify(
    code
  )}, "<spacetimepy-jupyterlab>", "exec"), {"__builtins__": __import__("builtins").__dict__})`;
}
