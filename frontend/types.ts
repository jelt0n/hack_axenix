export type SourceRange = {
  startLine: number; startColumn: number; endLine: number; endColumn: number;
};

export type JavaMethod = {
  id: string; name: string; signature: string; owner: string;
  kind: 'method' | 'constructor'; hasBody: boolean; range: SourceRange;
};

export type Project = {
  id: string; filename: string; revision: number; originalSource: string;
  generatedSource: string; packageName: string; methods: JavaMethod[];
  graphRevision: number; modelSource: string; originalMethods: JavaMethod[];
  originalPackageName: string; diagnostics: Diagnostic[];
};

export type Diagnostic = { message: string; line: number; column: number };

export type GraphNode = {
  id: string; kind: 'entry' | 'exit' | 'operation' | 'condition' | 'return' | 'opaque' | 'jump' | 'control' | 'dispatch';
  code: string; range: SourceRange;
  editable?: boolean; containerId?: string; index?: number;
};

export type GraphContainer = { id: string; kind: string; label: string; size: number };
export type GraphAction =
  | { action: 'replace'; nodeId: string; code: string }
  | { action: 'insert'; containerId: string; index: number; code: string }
  | { action: 'delete'; nodeId: string }
  | { action: 'move'; nodeId: string; containerId: string; index: number };
export type GraphEdit = GraphAction & { methodId: string };

export type MethodGraph = {
  methodId: string; nodes: GraphNode[];
  sourceRevision: number; projectRevision: number; stale: boolean;
  edges: { id: string; source: string; target: string; label: string; backEdge?: boolean }[];
  notices: string[];
  containers?: GraphContainer[];
};

export type Scenario = { name: string; stdin: string };
export type ProgramResult = {
  status: string; stdout: string; stderr: string; exitCode: number | null; durationMs: number;
  exception: { type: string; message: string | null } | null; stackTrace: string;
};
export type CheckJob = {
  id: string; projectId: string; sourceRevision: number; createdAt: number;
  status: 'queued' | 'running' | 'completed' | 'failed'; phase: string;
  queuePosition: number | null; mainClass: string; scenarios: Scenario[];
  result: {
    verdict: 'matched' | 'different' | 'inconclusive';
    cases: { name: string; stdin: string; original: ProgramResult | null;
      working: ProgramResult | null; matches: boolean }[];
    error?: { kind: string; message: string };
  } | null;
};

export type AnalysisFinding = {
  rule: string; message: string; recommendation: string; methodId: string;
  nodeId: string; range: SourceRange;
};
export type AnalysisReport = {
  projectId: string; sourceRevision: number; findings: AnalysisFinding[];
  thresholds: { longMethodLines: number; deepNesting: number };
  methods: { methodId: string; signature: string; range: SourceRange;
    complexity: { label: string; explanation: string; assumptions: string[] } }[];
};
