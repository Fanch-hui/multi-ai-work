export type ArtifactContentSource =
  | {
      kind: 'tool-operation';
      operationId: string;
      field: 'result' | 'modelResult';
      encoding: 'value' | 'model-text';
    }
  | { kind: 'stored-text'; key: string };
