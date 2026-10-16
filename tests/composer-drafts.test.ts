import { describe, expect, it } from "vitest";
import type { Artifact } from "../src/domain/types.js";
import { ComposerDraftStore } from "../apps/ui/src/composer-drafts.js";
import { ATTACHMENT_LIMIT_MESSAGE } from "../src/domain/attachment-policy.js";

const attachment: Artifact = { id: "file", name: "brief.md", path: "/workspace/brief.md", mimeType: "text/markdown",
  sha256: "digest", size: 10, conversationId: "first", createdAt: "2026-10-14T12:00:00Z" };

describe("conversation composer drafts", () => {
  it("retains text, selected members and attachments independently when leaving and returning", () => {
    const store = new ComposerDraftStore();
    let updates = 0;
    const unsubscribe = store.subscribe("first", () => updates++);
    store.edit("first", { content: "未发送的要求", targets: ["member"], attachments: [attachment] });
    const saved = store.read("first");
    unsubscribe();
    store.edit("second", { content: "另一会话" });
    expect(store.read("first")).toBe(saved);
    expect(store.read("first")).toMatchObject({ content: "未发送的要求", targets: ["member"], attachments: [attachment] });
    expect(store.read("second")).toMatchObject({ content: "另一会话", targets: [], attachments: [] });
    expect(updates).toBe(1);
  });

  it("retains the failed submission and its request ID, then clears only the successfully sent conversation", () => {
    const store = new ComposerDraftStore();
    store.edit("first", { content: "第一条", targets: ["member"], attachments: [attachment] });
    const pending = store.beginSend("first")!;
    expect(store.beginSend("first")).toBeUndefined();
    store.edit("second", { content: "第二条" });
    store.finishSend("first", pending.requestId, "连接失败");
    expect(store.read("first")).toMatchObject({ content: "第一条", requestId: pending.requestId, sending: false, error: "连接失败" });
    const retry = store.beginSend("first")!;
    expect(retry.requestId).toBe(pending.requestId);
    store.finishSend("first", retry.requestId);
    expect(store.read("first")).toMatchObject({ content: "", targets: [], attachments: [], sending: false, error: "" });
    expect(store.read("first").requestId).not.toBe(pending.requestId);
    expect(store.read("second").content).toBe("第二条");
  });

  it("keeps pending uploads with the originating draft after switching conversations", () => {
    const store = new ComposerDraftStore();
    expect(store.beginAttachment("first")).toBe(true);
    expect(store.beginAttachment("first")).toBe(false);
    store.edit("second", { content: "另一个草稿" });
    store.appendAttachments("first", [attachment]);
    store.update("first", { attaching: false });
    expect(store.read("first")).toMatchObject({ attachments: [attachment], attaching: false });
    expect(store.read("second")).toMatchObject({ content: "另一个草稿", attachments: [], attaching: false });
    expect(store.beginSend("first")).toBeDefined();
  });

  it("keeps newer edits when an earlier submission completes", () => {
    const store = new ComposerDraftStore();
    store.edit("first", { content: "已提交" });
    const pending = store.beginSend("first")!;
    store.edit("first", { content: "新的草稿" });
    store.finishSend("first", pending.requestId);
    expect(store.read("first")).toMatchObject({ content: "新的草稿", sending: false });
  });

  it("rejects an oversized upload batch before changing the originating draft", () => {
    const store = new ComposerDraftStore();
    store.edit("first", { content: "保留要求", attachments: Array.from({ length: 8 }, (_, index) => ({ ...attachment, id: `file-${index}` })) });
    const saved = store.read("first");
    expect(store.beginAttachment("first", 3)).toBe(false);
    expect(store.read("first")).toMatchObject({ content: saved.content, attachments: saved.attachments,
      requestId: saved.requestId, attaching: false, error: ATTACHMENT_LIMIT_MESSAGE });
    expect(store.read("second")).toMatchObject({ attachments: [], error: "" });
  });

  it("allows ten attachments to be sent and resumes adding after removal", () => {
    const store = new ComposerDraftStore();
    const items = Array.from({ length: 10 }, (_, index) => ({ ...attachment, id: `file-${index}` }));
    expect(store.beginAttachment("first", 10)).toBe(true);
    store.appendAttachments("first", items);
    store.update("first", { attaching: false });
    expect(store.beginAttachment("first")).toBe(false);
    const sent = store.beginSend("first")!;
    expect(sent.attachments).toEqual(items);
    store.finishSend("first", sent.requestId, "稍后重试");
    store.edit("first", { attachments: items.slice(1) });
    expect(store.beginAttachment("first")).toBe(true);
    store.appendAttachments("first", [attachment]);
    store.update("first", { attaching: false });
    expect(store.read("first").attachments).toHaveLength(10);
    expect(store.read("first").error).toBe("");
  });

  it("preserves all existing attachments when an imported batch exceeds capacity", () => {
    const store = new ComposerDraftStore();
    store.appendAttachments("first", Array.from({ length: 9 }, (_, index) => ({ ...attachment, id: `file-${index}` })));
    const saved = store.read("first");
    expect(() => store.appendAttachments("first", [attachment, { ...attachment, id: "extra" }])).toThrow(ATTACHMENT_LIMIT_MESSAGE);
    expect(store.read("first")).toBe(saved);
  });
});
