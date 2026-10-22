export function verifySourceValidation(options: {
  repository: string;
  sha: string;
  request: (endpoint: string) => Promise<unknown>;
}): Promise<{ runId: number; attempt: number; url: string }>;
