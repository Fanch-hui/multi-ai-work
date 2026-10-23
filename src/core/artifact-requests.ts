import { z } from 'zod';
import type { Artifact, Conversation, Task } from '../domain/types.js';
import { MAX_MESSAGE_ATTACHMENTS, requireAttachmentCapacity } from '../domain/attachment-policy.js';
import { resolveArtifactImage } from '../tools/images.js';
import type { State } from './state.js';
import type { ArtifactPreviews } from './artifact-preview.js';
import { importAttachment, importAttachmentBytes } from './attachments.js';
import { accessibleArtifacts } from './tool-access.js';
import { deleteArtifact } from './artifact-delete.js';
import { publicError, required } from './errors.js';
import type { ArtifactStorage } from './artifact-storage.js';

export type HostRequest = (
  method:
    | 'chooseDirectory'
    | 'chooseFile'
    | 'chooseAvatar'
    | 'openPath'
    | import('../domain/work-browser.js').BrowserHostMethod
    | 'system.notify'
    | 'system.openExternal'
    | 'resident.get'
    | 'resident.set'
    | import('../domain/computer.js').ComputerHostMethod
    | import('../domain/browser-teaching.js').BrowserTeachingHostMethod,
  params?: Record<string, unknown>,
) => Promise<unknown>;

export class ArtifactRequests {
  constructor(
    private state: State,
    private previews: ArtifactPreviews,
    private files: ArtifactStorage,
    private host?: HostRequest,
  ) {}

  async request(method: string, params: Record<string, unknown>): Promise<unknown> {
    const s = this.state.storage;
    const objectId = () => z.string().parse(params.id);
    switch (method) {
      case 'artifacts.storage':
        return this.files.usage();
      case 'artifacts.configureStorage':
        return this.files.configure(
          z
            .object({
              cacheMiB: z.number().int().min(64).max(4096),
              cacheIdleDays: z.number().int().min(1).max(30),
            })
            .parse(params.input),
        );
      case 'artifacts.cleanStorage':
        z.literal(true).parse(params.clearCache);
        return this.files.clean();
      case 'artifacts.retainDrafts':
        return this.files.drafts.retain(
          z
            .array(
              z.object({ conversationId: z.string(), artifactIds: z.array(z.string()).max(20) }),
            )
            .max(1000)
            .parse(params.drafts),
        );
      case 'conversations.attach': {
        const conversationId = z.string().parse(params.conversationId);
        const attachmentCount = z
          .number()
          .int()
          .min(0)
          .max(MAX_MESSAGE_ATTACHMENTS)
          .default(0)
          .parse(params.attachmentCount);
        required(s.get('conversations', conversationId), '对话不存在');
        requireAttachmentCapacity(attachmentCount, 1);
        if (!this.host) throw new Error('添加资料需要桌面文件选择器');
        const selection = (await this.host('chooseFile', { multiple: true })) as {
          path?: string;
          paths?: string[];
        };
        const paths = selection.paths ?? (selection.path ? [selection.path] : []);
        if (!paths.length) return { cancelled: true };
        requireAttachmentCapacity(attachmentCount, paths.length);
        const artifacts: Artifact[] = [],
          errors: string[] = [];
        for (const path of paths) {
          try {
            artifacts.push(await importAttachment(this.state, conversationId, path));
          } catch (error) {
            errors.push(publicError(error));
          }
        }
        return { artifacts, artifact: artifacts[0], errors };
      }
      case 'conversations.attachBytes': {
        const input = z
          .object({
            conversationId: z.string(),
            name: z.string().min(1).max(255),
            mimeType: z.string().max(120),
            data: z.string().max(36 * 1024 * 1024),
          })
          .parse(params);
        return {
          artifact: await importAttachmentBytes(
            this.state,
            input.conversationId,
            input.name,
            input.mimeType,
            input.data,
          ),
        };
      }
      case 'artifacts.read': {
        const artifact = required(s.get<Artifact>('artifacts', objectId()), '成果不存在');
        if (!['text/plain', 'text/markdown', 'application/json'].includes(artifact.mimeType))
          return { path: artifact.path, binary: true };
        const content = (await this.state.artifactContents.read(artifact)).toString('utf8');
        return { content: content.slice(0, 100000), path: artifact.path };
      }
      case 'artifacts.open': {
        const artifact = required(s.get<Artifact>('artifacts', objectId()), '成果不存在');
        const path = await this.state.artifactContents.materialize(artifact, true);
        return this.host ? this.host('openPath', { path }) : { path };
      }
      case 'artifacts.delete':
        return deleteArtifact(this.state, objectId(), this.previews);
      case 'artifacts.previewDocument':
        return this.previews.describe(objectId());
      case 'artifacts.previewPage':
        return this.previews.page(objectId(), z.number().int().positive().parse(params.page));
      case 'artifacts.preview': {
        const artifact = required(s.get<Artifact>('artifacts', objectId()), '成果不存在');
        if (params.conversationId) {
          const room = required(
            s.get<Conversation>('conversations', z.string().parse(params.conversationId)),
            '对话不存在',
          );
          const visible = [
            ...accessibleArtifacts(this.state, room, room.chiefId ?? room.memberIds[0]),
            ...s
              .byField<Task>('tasks', 'conversationId', room.id)
              .flatMap((task) => accessibleArtifacts(this.state, room, task.botId, task)),
          ];
          if (!visible.some((item) => item.id === artifact.id))
            throw new Error('图片不在当前会话授权范围');
        }
        return this.state.artifactContents.withPinned(artifact, async () => {
          const current = required(s.get<Artifact>('artifacts', artifact.id), '成果不存在');
          const image = await resolveArtifactImage(current, this.state.dataDirectory);
          s.put('artifacts', current);
          return image;
        });
      }
      default:
        throw new Error('不支持的应用操作');
    }
  }
}
