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
}

export interface SpaceTimeTraceNode {
  id: number | string;
  function: string;
  branch?: SpaceTimeTraceBranch | null;
  stage?: WorkflowStageSummary | null;
  arguments: SpaceTimeTraceArgument[];
}

export interface SpaceTimeTracePayload {
  loaded: boolean;
  error?: string;
  session?: { id: number | string; name?: string | null };
  rootBranchId: string;
  branches: Array<{ id: string; source: string }>;
  features: string[];
  inputStage?: WorkflowStageSummary | null;
  nodes: SpaceTimeTraceNode[];
}

export interface WorkflowTreeDatum {
  node: SpaceTimeTraceNode;
  children: WorkflowTreeDatum[];
  branchId?: string;
  edgeLabel?: string;
}

export interface LiveRequest {
  action: 'attach' | 'edit';
  branchId: string;
  source: string;
}

export interface LiveResult {
  ok: boolean;
  branchId?: string;
  error?: string;
  invalid?: boolean;
  reused?: boolean;
}
