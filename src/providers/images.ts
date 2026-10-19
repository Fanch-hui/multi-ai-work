import type { ModelImage, ModelMessage, RunContext } from '../domain/provider.js';

export function assertImageInput(context: RunContext, images: ModelImage[]): void {
  if (
    images.length &&
    context.connection.models?.find((model) => model.id === context.bot.model)?.imageInput ===
      'unsupported'
  ) {
    throw new Error('当前模型不支持图片输入，请选择支持图片的模型；附件已保留');
  }
}

export async function resolveMessageImages(
  context: RunContext,
  messages: ModelMessage[],
): Promise<Map<string, string>> {
  const images = new Map(
    messages.flatMap((message) => message.images ?? []).map((image) => [image.artifactId, image]),
  );
  assertImageInput(context, [...images.values()]);
  if (images.size && !context.resolveImage) throw new Error('图片附件读取服务不可用');
  const resolved = new Map<string, string>();
  for (const image of images.values()) {
    context.signal.throwIfAborted();
    const value = await context.resolveImage!(image);
    resolved.set(image.artifactId, `data:${value.mimeType};base64,${value.data}`);
  }
  return resolved;
}

export function imageUrl(image: ModelImage, resolved: Map<string, string>): string {
  const url = resolved.get(image.artifactId);
  if (!url) throw new Error('图片附件尚未解析');
  return url;
}

export { toolResultMessage } from '../runtime/tool-result-message.js';

export function antigravityImagePrompt(prompt: string, images: ModelImage[]): string {
  if (!images.length) return prompt;
  return `${prompt}\n\n本轮图片附件：${images.map((image) => image.artifactId).join('、')}。请逐一调用 read_artifact（artifactId）读取图片内容后处理，不要仅根据文件名判断。`;
}

export async function qoderImageContent(
  context: RunContext,
): Promise<{ type: string; [key: string]: unknown }[]> {
  const images = context.images ?? [];
  assertImageInput(context, images);
  if (images.length && !context.resolveImage) throw new Error('图片附件读取服务不可用');
  const content: { type: string; [key: string]: unknown }[] = [
    { type: 'text', text: context.prompt },
  ];
  for (const image of images) {
    context.signal.throwIfAborted();
    const value = await context.resolveImage!(image);
    content.push({
      type: 'image',
      source: { type: 'base64', media_type: value.mimeType, data: value.data },
    });
  }
  return content;
}
