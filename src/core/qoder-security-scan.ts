import { createHash } from 'node:crypto';
import { mkdir, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Connection } from '../domain/types.js';
import type { SecurityScanInput, ToolExecutionContext } from '../domain/tools.js';
import { enabledQoderServices } from '../domain/qoder-services.js';
import type { Bot } from '../domain/types.js';
import { filePath, readFileBytes } from '../tools/file-policy.js';
import { findFiles } from '../tools/file-search.js';
import { qoderAuthDirectory, qoderEnvironment } from '../providers/native/qoder-runtime.js';
import { commandFor } from '../providers/native/runtime.js';
import type { ProcessService } from './processes.js';
import { type State, id } from './state.js';
import { qoderPublicResult } from './qoder-native-results.js';

async function scanFiles(paths: string[], context: ToolExecutionContext) {
  const files = new Set<string>();
  for (const path of paths) {
    const target = await filePath(path, context);
    if ((await stat(target)).isFile()) files.add(target);
    else {
      const found = await findFiles({ path, pattern: '**/*', offset: 0, limit: 2001 }, context) as { items: { path: string }[]; total: number };
      if (found.total > 2000) throw new Error('扫描文件过多，请缩小代码目录范围');
      for (const item of found.items) files.add(await filePath(item.path, context));
    }
  }
  if (!files.size) throw new Error('指定范围没有可扫描的代码文件');
  if ([...files].reduce((length, path) => length + path.length + 3, 0) > 24000) throw new Error('扫描路径过多，请缩小代码目录范围');
  return [...files];
}

export async function scanQoderSecurity(input: SecurityScanInput, context: ToolExecutionContext, state: State,
  processes: ProcessService) {
  const bot = state.storage.get<Bot>('bots', context.botId);
  const connection = bot && state.storage.get<Connection>('connections', bot.connectionId);
  if (!bot || bot.archived || connection?.provider !== 'qoder' || !enabledQoderServices(bot).includes('SecurityScan'))
    throw new Error('当前成员未授权 Qoder 代码安全扫描');
  if (connection.authMode !== 'local') throw new Error('Qoder 安全扫描需要复用本机官方 CLI 登录');
  if (!connection.executable || !connection.profilePath) throw new Error('请先检测本机 Qoder CLI');
  const files = await scanFiles(input.paths, context);
  if (!await context.requestApproval('scan_code_security', `Qoder 扫描 ${files.length} 个代码文件，提交至官方扫描服务并可能消耗积分`,
    { paths: input.paths })) throw new Error('代码安全扫描未获批准');
  context.signal.throwIfAborted();
  const latest = state.storage.get<Bot>('bots', bot.id);
  if (!latest || latest.archived || latest.connectionId !== connection.id || !enabledQoderServices(latest).includes('SecurityScan'))
    throw new Error('代码安全扫描授权已改变');
  const directory = join(state.dataDirectory, 'qoder-scans', id());
  await mkdir(directory, { recursive: true, mode: 0o700 });
  try { return await runScan(files, input, context, processes, connection, directory); }
  finally { await rm(directory, { recursive: true, force: true }); }
}

async function runScan(files: string[], input: SecurityScanInput, context: ToolExecutionContext,
  processes: ProcessService, connection: Connection, directory: string) {
  const report = join(directory, 'report.json');
  const timeoutMs = input.timeoutMs ?? 600000;
  const environment = qoderEnvironment(connection.profilePath!);
  environment.QODERCN_CONFIG_DIR = await qoderAuthDirectory(connection.profilePath!);
  const invocation = commandFor(connection.executable!, ['--cwd', context.workspace.path, 'security', 'scan', ...files,
    '--report', `json=${report}`, '--fail-on', 'none', '--wait-timeout', String(Math.max(1, Math.floor(timeoutMs / 1000)))]);
  const result = await processes.runService({ ...invocation, workdir: '.', timeoutMs }, context, environment) as { status: string; code?: number };
  if (result.status !== 'completed' || result.code !== 0) throw new Error('Qoder 安全扫描未完成，请检查官方 CLI 登录、扫描额度或运行环境');
  const parsed = JSON.parse((await readFileBytes(report)).toString('utf8'));
  const content = JSON.stringify(qoderPublicResult(parsed, Infinity), null, 2);
  await writeFile(report, content, { mode: 0o600 });
  const artifact = context.registerArtifact({ name: '代码安全扫描报告.json', path: report, mimeType: 'application/json',
    sha256: createHash('sha256').update(content).digest('hex'), size: Buffer.byteLength(content),
    conversationId: context.conversation.id, source: 'qoder-security-scan', purpose: 'deliverable' });
  return { artifactId: artifact.id, service: 'Qoder', status: 'completed', scannedFiles: files.length,
    report: content.slice(0, 24000), truncated: content.length > 24000,
    instruction: '这是实际扫描报告；根据报告解释发现，不把扫描完成等同于没有漏洞。' };
}
