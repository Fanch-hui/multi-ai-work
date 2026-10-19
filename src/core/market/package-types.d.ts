declare module 'unzipper' {
  import type { Readable } from 'node:stream';
  interface Entry {
    path: string;
    type: 'File' | 'Directory';
    uncompressedSize: number;
    externalFileAttributes: number;
    flags: number;
    stream(): Readable;
  }
  export const Open: { file(path: string): Promise<{ files: Entry[] }> };
}
declare module 'js-yaml' {
  export const JSON_SCHEMA: unknown;
  export function load(content: string, options?: { schema?: unknown }): unknown;
}
