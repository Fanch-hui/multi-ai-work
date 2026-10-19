export function createRuntimeIntegrity(
  root: string,
  manifest: Record<string, any>,
): Promise<Record<string, any>>;
export function assertRuntimeIntegrity(
  root: string,
  manifest: Record<string, any>,
  options?: { allowCodeSigning?: boolean },
): Promise<void>;
