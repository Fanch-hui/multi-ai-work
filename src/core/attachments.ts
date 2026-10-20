import { createHash } from 'node:crypto';
import { mkdir, readFile, rm, stat } from 'node:fs/promises';
import { basename, extname, join } from 'node:path';
import type { Artifact, Conversation } from '../domain/types.js';
import { State, id, now } from './state.js';
import { required } from './errors.js';
import { attachmentSizeLimit, imageMimeTypes, normalizeImageBytes } from '../tools/images.js';
import { trackAttachmentDraft } from './artifact-drafts.js';

const mime: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.txt': 'text/plain',
  '.csv': 'text/plain',
  '.yaml': 'text/plain',
  '.yml': 'text/plain',
  '.pptx': 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
};

export async function importAttachment(
  state: State,
  conversationId: string,
  selectedPath: string,
): Promise<Artifact> {
  required(state.storage.get<Conversation>('conversations', conversationId), '对话不存在');
  const type = mime[extname(selectedPath).toLowerCase()];
  if (!type) throw new Error('请选择图片、PDF、DOCX、PPTX、XLSX 或文本资料');
  const file = await stat(selectedPath);
  if (!file.isFile() || file.size > attachmentSizeLimit)
    throw new Error('资料需为不超过 25 MiB 的普通文件');
  const bytes = await readFile(selectedPath);
  return storeAttachment(state, conversationId, basename(selectedPath), type, bytes);
}

export async function importAttachmentBytes(
  state: State,
  conversationId: string,
  name: string,
  mimeType: string,
  data: string,
): Promise<Artifact> {
  required(state.storage.get<Conversation>('conversations', conversationId), '对话不存在');
  const safeName = basename(name.replace(/\\/g, '/'));
  const type = mime[extname(safeName).toLowerCase()];
  if (!type || !safeName || ['.', '..'].includes(safeName) || safeName.includes('\0'))
    throw new Error('请选择支持的资料格式');
  if (
    imageMimeTypes.has(type) &&
    mimeType &&
    mimeType !== type &&
    mimeType !== 'application/octet-stream'
  )
    throw new Error('资料内容与文件类型不一致');
  if (data.length > Math.ceil(attachmentSizeLimit / 3) * 4)
    throw new Error('资料需为不超过 25 MiB 的普通文件');
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(data))
    throw new Error('资料编码无效');
  const bytes = Buffer.from(data, 'base64');
  if (bytes.toString('base64') !== data) throw new Error('资料编码无效');
  return storeAttachment(state, conversationId, safeName, type, bytes);
}

async function storeAttachment(
  state: State,
  conversationId: string,
  name: string,
  type: string,
  bytes: Buffer,
): Promise<Artifact> {
  if (bytes.length > attachmentSizeLimit) throw new Error('资料需为不超过 25 MiB 的普通文件');
  const artifactId = id();
  const directory = join(state.dataDirectory, 'artifacts', artifactId);
  await mkdir(directory, { recursive: true });
  const path = join(directory, name);
  const artifact: Artifact = {
    id: artifactId,
    name,
    path,
    mimeType: type,
    sha256: createHash('sha256').update(bytes).digest('hex'),
    size: bytes.length,
    conversationId,
    createdAt: now(),
    source: 'user-attachment',
  };
  try {
    if (imageMimeTypes.has(type))
      artifact.image = await normalizeImageBytes(bytes, directory, type, state.dataDirectory);
    Object.assign(artifact, state.artifactObjects.publish(artifactId, name, bytes));
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  state.storage.put('artifacts', artifact);
  trackAttachmentDraft(state, artifact);
  state.changed();
  return artifact;
}
