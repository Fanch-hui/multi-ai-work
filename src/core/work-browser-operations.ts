import { z } from 'zod';
import { createHash } from 'node:crypto';
import { basename, join, relative, isAbsolute } from 'node:path';
import { mkdir, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises';
import type {
  BrowserAction,
  BrowserDownload,
  BrowserSession,
  BrowserSnapshot,
  BrowserProfile,
} from '../domain/work-browser.js';
import type { ToolExecutionContext } from '../domain/tools.js';
import type { Artifact, Bot } from '../domain/types.js';
import { filePath, MAX_FILE_BYTES } from '../tools/file-policy.js';
import type { BrowserService } from './work-browser.js';
import { required } from './errors.js';

const identifier = z.string().min(1).max(200);
const actionSchema = z
  .object({
    tabId: identifier.optional(),
    revision: identifier,
    action: z.enum(['click', 'fill', 'press', 'select', 'scroll', 'back', 'upload']),
    ref: identifier.optional(),
    text: z.string().max(100000).optional(),
    key: z.string().max(100).optional(),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    deltaY: z.number().finite().min(-100000).max(100000).optional(),
    artifactId: identifier.optional(),
    path: z.string().max(8000).optional(),
  })
  .strict();

export class BrowserOperations {
  constructor(private service: BrowserService) {}

  async execute(
    name: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ): Promise<unknown> {
    if (name === 'browser_open') {
      if (!args.profileId)
        return {
          profiles: this.service.state.storage
            .all<BrowserProfile>('browser_profiles')
            .filter((p) => p.allowedBotIds.includes(context.botId))
            .map(({ id, name }) => ({ id, name })),
        };
      const profileId = identifier.parse(args.profileId);
      const session = await this.service.acquire(profileId, context);
      this.assertActive(session);
      if (args.url) {
        const url = z.url({ protocol: /^https?$/ }).parse(args.url);
        await this.approve('打开工作网页', { profileId, url }, context);
        await this.service.perform(
          session,
          () => {
            this.service.authorize(profileId, context);
            this.assertActive(session);
            context.markDispatched?.();
            return this.service.call('browser.open', {
              sessionId: session.id,
              profileId,
              url,
              downloadDirectory: this.service.downloadDirectory(session.id),
            });
          },
          context.signal,
        );
      }
      return {
        sessionId: session.id,
        tabs: await this.service.call('browser.tabs', { sessionId: session.id, operation: 'list' }),
      };
    }
    const session = required(
      this.service.state.storage.get<BrowserSession>(
        'browser_sessions',
        identifier.parse(args.sessionId),
      ),
      '浏览器会话不存在',
    );
    if (session.taskId !== context.task.id || session.botId !== context.botId)
      throw new Error('浏览器会话不属于当前任务');
    this.service.authorize(session.profileId, context);
    if (name === 'browser_handoff')
      return this.service.handoff(
        session,
        context,
        z.string().trim().min(1).max(2000).parse(args.reason),
      );
    this.assertActive(session);
    await this.service.perform(session, () => this.service.ensureHost(session), context.signal);
    if (name === 'browser_action') return this.action(session, args, context);
    if (name === 'browser_tabs') {
      const operation = z.enum(['list', 'select', 'close']).parse(args.operation ?? 'list');
      if (operation !== 'list')
        await this.approve(
          '切换或关闭工作标签',
          { sessionId: session.id, operation, tabId: args.tabId },
          context,
        );
      return this.service.perform(
        session,
        () => {
          this.service.authorize(session.profileId, context);
          this.assertActive(session);
          if (operation !== 'list') context.markDispatched?.();
          return this.service.call('browser.tabs', {
            sessionId: session.id,
            operation,
            tabId: args.tabId === undefined ? undefined : identifier.parse(args.tabId),
          });
        },
        context.signal,
      );
    }
    if (name !== 'browser_snapshot') throw new Error('不支持的浏览器工具');
    return this.service.perform(
      session,
      async () => {
        this.service.authorize(session.profileId, context);
        this.assertActive(session);
        const snapshot = (await this.service.call('browser.snapshot', {
          sessionId: session.id,
          tabId: args.tabId === undefined ? undefined : identifier.parse(args.tabId),
          screenshot: args.screenshot === true,
        })) as BrowserSnapshot;
        this.assertActive(session);
        const downloads = await this.collectDownloads(session, context);
        const { screenshot, ...data } = snapshot;
        const content: Record<string, unknown>[] = [
          { type: 'text', text: JSON.stringify({ ...data, downloads }) },
        ];
        if (screenshot) content.push({ type: 'image', mimeType: 'image/png', data: screenshot });
        return { content };
      },
      context.signal,
    );
  }

  private assertActive(session: BrowserSession) {
    const current = this.service.state.storage.get<BrowserSession>('browser_sessions', session.id);
    if (current?.status !== 'active')
      throw new Error('浏览器正在等待人工处理或已关闭，此操作尚未执行');
  }

  private async approve(
    summary: string,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    if (!(await context.requestApproval('browser_action', summary, args)))
      throw new Error('浏览器操作未获批准');
    context.assertAuthorized?.();
  }

  private async action(
    session: BrowserSession,
    args: Record<string, unknown>,
    context: ToolExecutionContext,
  ) {
    const { sessionId: _sessionId, ...input } = args;
    const action: BrowserAction = actionSchema.parse(input);
    await this.approve(
      `工作浏览器：${action.action}`,
      { sessionId: session.id, ...action },
      context,
    );
    let upload: string | undefined;
    try {
      if (action.action === 'upload') {
        upload = await this.prepareUpload(session, action, context);
        action.path = upload;
        delete action.artifactId;
      }
      return await this.service.perform(
        session,
        async () => {
          this.service.authorize(session.profileId, context);
          this.assertActive(session);
          context.markDispatched?.();
          const result = await this.service.call('browser.action', {
            sessionId: session.id,
            action,
          });
          context.signal.throwIfAborted();
          return { result, downloads: await this.collectDownloads(session, context) };
        },
        context.signal,
      );
    } finally {
      if (upload) await rm(upload, { force: true });
    }
  }

  private async prepareUpload(
    session: BrowserSession,
    action: BrowserAction,
    context: ToolExecutionContext,
  ) {
    if (!action.artifactId && !action.path) throw new Error('上传需要获准成果或工作区文件');
    const bot = this.service.state.storage.get<Bot>('bots', context.botId);
    const permission = action.artifactId ? 'read_artifact' : 'read_file';
    if (!bot?.toolNames.includes(permission)) throw new Error('上传需要资料读取权限');
    const artifact = action.artifactId
      ? required(context.findArtifact(action.artifactId), '上传资料未授权')
      : undefined;
    const source = artifact ? undefined : await filePath(action.path!, context);
    const bytes = artifact
      ? await this.service.state.artifactContents.read(artifact)
      : await readFile(source!);
    if (bytes.byteLength > MAX_FILE_BYTES) throw new Error('上传文件超过 25 MiB');
    const directory = join(this.service.downloadDirectory(session.id), 'uploads');
    await mkdir(directory, { recursive: true });
    const path = join(directory, `${context.runId}-${basename(artifact?.name ?? source!)}`);
    await writeFile(path, bytes, { mode: 0o600 });
    try {
      context.assertAuthorized?.();
      if (action.artifactId && !context.findArtifact(action.artifactId))
        throw new Error('上传资料授权已撤销');
      return path;
    } catch (error) {
      await rm(path, { force: true });
      throw error;
    }
  }

  private async collectDownloads(session: BrowserSession, context: ToolExecutionContext) {
    const downloads = (await this.service.call('browser.downloads', {
      sessionId: session.id,
    })) as BrowserDownload[];
    const artifacts = [];
    const key = `browser-downloads:${session.id}`;
    const collected = this.service.state.storage.metadata<Record<string, string>>(key) ?? {};
    for (const item of downloads) {
      context.signal.throwIfAborted();
      this.service.authorize(session.profileId, context);
      const pathKey = createHash('sha256').update(item.path).digest('hex');
      if (collected[pathKey]) {
        const artifact = this.service.state.storage.get<Artifact>('artifacts', collected[pathKey]);
        if (artifact && context.findArtifact(artifact.id))
          artifacts.push({ artifactId: artifact.id, name: artifact.name, size: artifact.size });
        continue;
      }
      const root = await realpath(this.service.downloadDirectory(session.id));
      const path = await realpath(item.path);
      const inside = relative(root, path);
      if (!inside || inside.startsWith('..') || isAbsolute(inside))
        throw new Error('下载文件不属于当前任务');
      const info = await stat(path);
      if (!info.isFile() || info.size > MAX_FILE_BYTES) {
        await rm(path, { force: true });
        throw new Error('下载资料必须为不超过 25 MiB 的普通文件');
      }
      const bytes = await readFile(path);
      const artifact = context.registerArtifact({
        name: basename(item.name),
        path,
        mimeType: item.mimeType || 'application/octet-stream',
        size: bytes.byteLength,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        conversationId: context.conversation.id,
        purpose: 'intermediate',
        source: 'browser-download',
      });
      artifacts.push({ artifactId: artifact.id, name: artifact.name, size: artifact.size });
      collected[pathKey] = artifact.id;
      this.service.state.storage.setMetadata(key, collected);
      await rm(path, { force: true });
    }
    return artifacts;
  }
}
