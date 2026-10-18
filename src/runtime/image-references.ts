import type { ModelMessage } from '../domain/provider.js';

export function modelMessageContent(message: ModelMessage, content = message.content): string {
  if (!message.imageReferences?.length) return content;
  const references = message.imageReferences.map(image => `- read_artifact(${JSON.stringify({ artifactId: image.artifactId })})`);
  return [content, '历史图片引用，需要查看原图时使用以下工具：', ...references].filter(Boolean).join('\n');
}
