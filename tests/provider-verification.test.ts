import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { detectNativeSetup } from '../src/providers/native/setup.js';
import { verificationTools } from '../src/verification/tool-channel.js';
import { main } from '../src/verification/providers.js';

const folders: string[] = [];
afterEach(async () => { vi.restoreAllMocks(); await Promise.all(folders.splice(0).map(path => rm(path, { recursive: true, force: true }))); });
const directory = async () => { const path = await mkdtemp(join(tmpdir(), 'ai-team-setup-test-')); folders.push(path); return path; };

describe('runtime preparation and verification boundaries', () => {
  it('uses an explicit JavaScript entry without executing it and keeps the native login profile', async () => {
    const folder = await directory(), executable = join(folder, 'fixture.mjs');
    await writeFile(executable, 'throw new Error("must never execute")');
    const setup = await detectNativeSetup({ provider: 'qoder', executable, profilePath: join(folder, "App's profile"), appRuntimeDirectory: folder });
    expect(setup.executable).toContain('fixture.mjs'); expect(setup.source).toBe('explicit');
    expect(setup.compatibility).toBe('unverified'); expect(setup.loginCommand).not.toContain('HOME=');
    expect(setup.loginCommand).toContain(`'${setup.executable}' login`);
    expect(setup.installCommand).toContain('npm install --prefix'); expect(setup.installCommand).not.toContain(' -g');
  });

  it('finds Qoder in the App install directory after a missing bundled runtime', async () => {
    const folder = await directory();
    const app = join(folder, 'qoder', 'node_modules', '@qodercn-ai', 'qodercn-agent-sdk', 'dist', '_bundled');
    await mkdir(app, { recursive: true }); await writeFile(join(app, 'qoderclicn'), '', { mode: 0o700 });
    const setup = await detectNativeSetup({ provider: 'qoder', path: '', appRuntimeDirectory: folder,
      profilePath: join(folder, 'profile'), bundledQoderPath: join(folder, 'missing'), platform: 'darwin', commonBinDirectories: [] });
    expect(setup.source).toBe('app'); expect(setup.loginCommand).toMatch(/ login$/);
    await expect(detectNativeSetup({ provider: 'qoder', appRuntimeDirectory: folder, profilePath: folder, executable: 'relative' })).rejects.toThrow('绝对路径');
  });

  it('maps an Electron bundled executable to the unpacked file', async () => {
    const folder = await directory();
    const physical = join(folder, 'app.asar.unpacked', 'dist', '_bundled'); await mkdir(physical, { recursive: true });
    await writeFile(join(physical, 'qoderclicn'), '', { mode: 0o700 });
    const setup = await detectNativeSetup({ provider: 'qoder', path: '', appRuntimeDirectory: folder, profilePath: join(folder, 'profile'),
      bundledQoderPath: join(folder, 'app.asar', 'dist', '_bundled', 'qoderclicn'), platform: 'darwin', commonBinDirectories: [] });
    expect(setup.executable).toContain('app.asar.unpacked');
  });

  it('runs the real read_file implementation and rejects any other path or capability', async () => {
    const folder = await directory(); await writeFile(join(folder, 'verification.txt'), 'readonly-marker');
    await writeFile(join(folder, 'private.txt'), 'not-authorized');
    const channel = verificationTools(folder, new AbortController().signal);
    const result = await channel.execute('read_file', { path: 'verification.txt' }, 'call-1');
    expect(JSON.stringify(result)).toContain('readonly-marker');
    expect(await readFile(join(folder, 'calls.jsonl'), 'utf8')).toContain('call-1');
    await expect(channel.execute('read_file', { path: 'private.txt' }, 'call-2')).rejects.toThrow('仅授权');
    await expect(channel.execute('run_command', { command: 'true' }, 'call-3')).rejects.toThrow('仅授权');
    await channel.close();
  });

  it('does not contact a service without an explicit probe or run flag', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('must not contact service'));
    vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await main(['--provider', 'custom'])).toBe(0);
    expect(await main(['--help'])).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('starts the verification MCP worker from a separate workspace and completes a real read call', async () => {
    const folder = await directory(); await writeFile(join(folder, 'verification.txt'), 'mcp-read-marker');
    const transport = new StdioClientTransport({ command: process.execPath,
      args: ['--import', pathToFileURL(createRequire(import.meta.url).resolve('tsx/esm')).href,
        fileURLToPath(new URL('../src/verification/mcp-worker.ts', import.meta.url))],
      cwd: folder, env: { AI_TEAM_VERIFY_WORKSPACE: folder } });
    const client = new Client({ name: 'verification-test', version: '1' });
    try {
      await client.connect(transport);
      expect((await client.listTools()).tools.map(tool => tool.name)).toEqual(['read_file']);
      const result = await client.callTool({ name: 'read_file', arguments: { path: 'verification.txt' } });
      expect(JSON.stringify(result)).toContain('mcp-read-marker');
      expect(await readFile(join(folder, 'calls.jsonl'), 'utf8')).toContain('callId');
    } finally { await client.close(); }
  });
});
