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
};

export type GraphNode = {
  id: string; kind: 'entry' | 'exit' | 'operation' | 'condition' | 'return' | 'opaque';
  code: string; range: SourceRange;
};

export type MethodGraph = {
  methodId: string; nodes: GraphNode[];
  edges: { id: string; source: string; target: string; label: string }[];
  notices: string[];
};
