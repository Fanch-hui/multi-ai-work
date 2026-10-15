export function assertInstalledDependencies(project: string): Promise<void>;
export function assertPackagedDependencies(archive: string, target?: { platform?: string; arch?: string }): number;
