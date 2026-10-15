import { useEffect, useRef, useState } from "react";
import type { ClipboardEvent, DragEvent } from "react";
import type { Artifact } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { composerDrafts, useComposerDraft } from "./composer-drafts.js";

type AttachResult = Artifact | Artifact[] | { artifact?: Artifact; artifacts?: Artifact[] } | null;
function importedArtifacts(result: AttachResult): Artifact[] {
  if (!result) return [];
  if (Array.isArray(result)) return result;
  if ("id" in result) return [result];
  return result.artifacts ?? (result.artifact ? [result.artifact] : []);
}
function encodeFile(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}

export function useAttachments(conversationId: string, mutate: Mutate) {
  const { draft: { attachments, attaching }, setAttachments } = useComposerDraft(conversationId);
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  useEffect(() => { setDragging(false); dragDepth.current = 0; }, [conversationId]);
  async function importItems(work: (append: (result: AttachResult) => void) => Promise<AttachResult>) {
    if (!composerDrafts.beginAttachment(conversationId)) return;
    function append(result: AttachResult) {
      composerDrafts.appendAttachments(conversationId, importedArtifacts(result));
    }
    try {
      append(await work(append));
    } catch (cause) { composerDrafts.update(conversationId, { error: errorMessage(cause) }); }
    finally { composerDrafts.update(conversationId, { attaching: false }); }
  }
  function attach() {
    return importItems(() => mutate<AttachResult>("conversations.attach", { conversationId }));
  }
  function upload(files: File[]) {
    return importItems(async append => {
      for (const file of files) {
        if (file.size > 25 * 1024 * 1024) throw new Error(`${file.name} 超过 25 MB，请选择较小的文件。`);
        const result = await mutate<AttachResult>("conversations.attachBytes", {
          conversationId, name: file.name || "图片.png", mimeType: file.type, data: await encodeFile(file),
        });
        append(result);
      }
      return null;
    });
  }
  function onPaste(event: ClipboardEvent) {
    const images = Array.from(event.clipboardData.files).filter(file => file.type.startsWith("image/"));
    if (!images.length) return;
    event.preventDefault(); void upload(images);
  }
  function onDrop(event: DragEvent) {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault(); setDragging(false); dragDepth.current = 0;
    void upload(Array.from(event.dataTransfer.files));
  }
  const dragHandlers = {
    onDragEnter: (event: DragEvent) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); dragDepth.current++; setDragging(true); } },
    onDragLeave: () => { dragDepth.current = Math.max(0, dragDepth.current - 1); if (!dragDepth.current) setDragging(false); },
    onDragOver: (event: DragEvent) => { if (event.dataTransfer.types.includes("Files")) { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; } },
    onDrop,
  };
  return { attachments, setAttachments, attaching, dragging, attach, onPaste, dragHandlers };
}
