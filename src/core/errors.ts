export function publicError(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') return '运行已取消';
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/Bearer\s+\S+/gi, 'Bearer [已隐藏]')
    .replace(/\b(?:sk-|eyJ)[A-Za-z0-9_.-]{16,}/g, '[已隐藏]')
    .replace(/([?&](?:token|key|code|state)=)[^&\s]+/gi, '$1[已隐藏]')
    .slice(0, 1000);
}
export function required<T>(value: T | undefined, message: string): T {
  if (value === undefined) throw new Error(message);
  return value;
}
