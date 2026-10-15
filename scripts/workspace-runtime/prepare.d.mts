export const runtimeTargets: string[];
export function prepareWorkspaceRuntime(options: { target: string; output: string; cache: string; crtDirectory?: string }): Promise<string>;
