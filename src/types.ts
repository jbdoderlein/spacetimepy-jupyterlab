export interface Position {
  [key: string]: number;
  line: number;
  column: number;
}

export interface VariantRange {
  start: Position;
  end: Position;
}

export interface CodeVariant {
  id: string;
  label: string;
  code: string;
}

export interface VariantTarget {
  id: string;
  label: string;
  original: string;
  range: VariantRange;
  activeVariantId?: string;
  variants: CodeVariant[];
}

export interface CaptureResult {
  ok: boolean;
  message: string;
  target?: VariantTarget;
}

export interface SpaceTimeTraceArgument {
  name: string;
  value: unknown;
}

export interface WorkflowHistogramBin {
  label: string;
  count: number;
}

export interface WorkflowHistogram {
  kind: 'numeric' | 'categorical' | 'empty';
  bins: WorkflowHistogramBin[];
}

export interface WorkflowStageSummary {
  index: number;
  label: string;
  sampleSize: number;
  histograms: Record<string, WorkflowHistogram>;
}

export interface SpaceTimeTraceBranch {
  id: string;
  label: string;
  fromStepId: number | string | null;
  sourceStepId: number | string;
  combinationKey?: string;
  combinationLabel?: string;
  parentCombinationKey?: string;
}

export interface SpaceTimeTraceNode {
  id: number | string;
  function: string;
  branch?: SpaceTimeTraceBranch | null;
  stage?: WorkflowStageSummary | null;
  arguments: SpaceTimeTraceArgument[];
}

export interface VariantReexecutionRequest {
  source: string;
  targets: Array<{
    targetId: string;
    variantId: string;
    variantLabel: string;
    range: VariantRange;
  }>;
  combinationKey: string;
  combinationLabel: string;
  baselineCombinationKey: string;
  originalCombinationKey: string;
}

export interface VariantReexecutionResult {
  ok: boolean;
  error?: string;
  reused?: boolean;
  branchId?: string;
  branchFromStepId?: number | string | null;
  stepIds?: Array<number | string>;
}

export interface SpaceTimeTracePayload {
  loaded: boolean;
  error?: string;
  session?: {
    id: number | string;
    name?: string | null;
  };
  baselineCombinationKey?: string | null;
  baselineCombinationLabel?: string | null;
  features: string[];
  inputStage?: WorkflowStageSummary | null;
  nodes: SpaceTimeTraceNode[];
}

export interface VariantCombination {
  key: string;
  label: string;
}

export interface WorkflowTreeDatum {
  node: SpaceTimeTraceNode;
  children: WorkflowTreeDatum[];
  combinationKey?: string;
  edgeLabel?: string;
}

export interface WorkflowTreeSelection {
  activeCombinationKey: string;
  baselineCombinationKey: string;
  baselineCombinationLabel: string;
  variantLabelById: Map<string, string>;
}
