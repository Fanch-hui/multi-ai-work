import { useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { FileText, FileImage, FileSpreadsheet, FileCode, ExternalLink, Eye, LoaderCircle, CircleUserRound } from "lucide-react";
import type { Artifact, Bot, Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, ErrorNote, Modal, timeLabel } from "./components.js";
import { artifactProducer, type ArtifactGroup } from "./artifact-groups.js";
import Avatar from "./Avatar.js";
import { cn } from "./classNames.js";
import { ArtifactImagePreview, isImageAttachment } from "./ImageAttachment.js";
import { DocumentPreview, isDocumentPreview } from './DocumentPreview.js';
import { ArtifactRequirement } from './RequirementDetails.js';
import DeleteArtifactButton from './DeleteArtifactButton.js';

export function ArtifactGroups({ groups, data, mutate }: {
  groups: ArtifactGroup[]; data: Pick<Snapshot, 'tasks' | 'bots'>; mutate: Mutate;
}) {
  const tasks = new Map(data.tasks.map(task => [task.id, task]));
  const bots = new Map(data.bots.map(bot => [bot.id, bot]));
  return <div className="space-y-6">
    {groups.map(group => <section key={group.id} aria-labelledby={`artifact-group-${group.id}`}>
      <div className="mb-2 flex items-center justify-between gap-4">
        <div className="min-w-0">
          <h2 id={`artifact-group-${group.id}`} className="truncate text-balance text-sm font-semibold text-slate-800" title={group.title}>
            {group.title}
          </h2>
        </div>
        <span className="shrink-0 text-xs text-slate-500 tabular-nums">{group.artifacts.length} 个成果</span>
      </div>
      <ul className="@container list-none divide-y divide-slate-100 overflow-hidden rounded-xl border border-slate-200 bg-white">
        {group.artifacts.map(artifact => <li key={artifact.id}><ArtifactItem artifact={artifact}
          producer={artifactProducer(artifact, tasks, bots)} showProducer layout="row" allowDelete mutate={mutate} /></li>)}
      </ul>
    </section>)}
  </div>;
}

export function Markdown({ children }: { children: string }) {
  return (
    <div className="markdown text-pretty">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children: text, href }) => (
            <a href={href} target="_blank" rel="noreferrer">
              {text}
            </a>
          ),
        }}
      >
        {children}
      </ReactMarkdown>
    </div>
  );
}
export function ArtifactItem({ artifact, mutate, dense, producer, showProducer, layout = 'card', allowDelete }: {
  artifact: Artifact; mutate: Mutate; dense?: boolean; producer?: Bot; showProducer?: boolean; layout?: 'card' | 'row';
  allowDelete?: boolean;
}) {
  const row = layout === 'row';
  const [preview, setPreview] = useState(false);
  const [content, setContent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function read() {
    setPreview(true);
    setError("");
    if (isImageAttachment(artifact) || isDocumentPreview(artifact.name)) return;
    setBusy(true);
    setError("");
    try {
      const result = await mutate<unknown>("artifacts.read", {
        id: artifact.id,
      });
      setContent(
        typeof result === "string"
          ? result
          : (result as { content?: string; text?: string })?.content ||
              (result as { text?: string })?.text ||
              "该文件暂无文字预览，请打开原文件。",
      );
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function open() {
    setError("");
    try {
      const result = await mutate<{ path?: string }>("artifacts.open", { id: artifact.id });
      if (!(window as Window & { aiTeam?: unknown }).aiTeam) setNotice(result?.path || artifact.path);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  return (
    <>
      <div className={cn(row ? "px-3 py-2" : "rounded-2xl border border-slate-200 bg-white", !row && (dense ? "p-3" : "p-5"))}>
        <ArtifactEntry artifact={artifact} row={row} dense={dense} producer={producer} showProducer={showProducer}
          onRead={() => void read()} onOpen={() => void open()}
          deleteAction={allowDelete && <DeleteArtifactButton artifact={artifact} mutate={mutate} onDeleted={() => setPreview(false)} />} />
        <ErrorNote error={!preview ? error : ""} />
        {notice && (
          <p role="status" className="mt-3 break-all rounded-lg bg-slate-50 p-3 text-xs text-slate-600">
            文件路径：{notice}
          </p>
        )}
      </div>
      <Modal open={preview} onOpenChange={setPreview} title={artifact.name} wide>
        <ArtifactRequirement artifact={artifact} className="mb-3" />
        <ErrorNote error={error} />
        {isImageAttachment(artifact) && preview ? <ArtifactImagePreview artifact={artifact} />
          : isDocumentPreview(artifact.name) && preview ? <DocumentPreview artifactId={artifact.id} /> : busy ? (
          <div className="flex items-center gap-2 py-12 text-sm text-slate-500">
            <LoaderCircle size={18} />
            读取预览…
          </div>
        ) : (
          <div className="max-h-96 overflow-auto text-sm leading-7">
            <Markdown>{content}</Markdown>
          </div>
        )}
        <div className="mt-5 flex justify-end gap-2">
          {allowDelete && <DeleteArtifactButton artifact={artifact} mutate={mutate} onDeleted={() => setPreview(false)} labeled />}
          <Button onClick={() => void open()}>
            <ExternalLink size={15} />
            打开原文件
          </Button>
        </div>
      </Modal>
    </>
  );
}
function ArtifactEntry({ artifact, row, dense, producer, showProducer, onRead, onOpen, deleteAction }: {
  artifact: Artifact; row: boolean; dense?: boolean; producer?: Bot; showProducer?: boolean;
  onRead: () => void; onOpen: () => void;
  deleteAction?: ReactNode;
}) {
  const FileIcon = artifact.mimeType.startsWith("image/") ? FileImage
    : /\.(csv|xlsx?|ods)$/i.test(artifact.name) ? FileSpreadsheet
      : /\.(html?|json|tsx?|jsx?|py|css|sh)$/i.test(artifact.name) ? FileCode : FileText;
  return <>
    <div className={cn(row ? "grid min-h-9 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-3 gap-y-1 @xl:grid-cols-[minmax(0,1fr)_7rem_10rem_auto]" : "flex items-center gap-3")}>
      <div className="flex min-w-0 flex-1 items-center gap-2.5">
        <div className={cn("flex shrink-0 items-center justify-center bg-blue-50 text-blue-600", row ? "size-7 rounded-md" : "size-11 rounded-xl")}>
          <FileIcon size={row ? 16 : 21} />
        </div>
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium text-slate-800" title={artifact.name}>{artifact.name}</p>
          <ArtifactRequirement artifact={artifact} />
          {!row && <p className="mt-1 text-xs text-slate-400">
            <span className="tabular-nums">{formatSize(artifact.size)}</span>
            {artifact.source === "user-attachment" && " · 用户资料"}
            {!dense && ` · ${timeLabel(artifact.createdAt)}`}
          </p>}
        </div>
      </div>
      {row && showProducer && <ArtifactProducer producer={producer} className="order-3 @xl:order-none" />}
      {row && <p className="order-4 truncate text-right text-xs text-slate-400 tabular-nums @xl:order-none @xl:text-left">
        {formatSize(artifact.size)} · {timeLabel(artifact.createdAt)}
      </p>}
      <div className={cn("flex shrink-0 items-center", row ? "order-2 @xl:order-none" : "gap-3")}>
        <Button variant="ghost" aria-label={`预览${artifact.name}`} className="size-8 min-h-8 p-0" onClick={onRead}>
          <Eye size={15} />
        </Button>
        <Button variant="ghost" aria-label={`打开${artifact.name}`} className="size-8 min-h-8 p-0" onClick={onOpen}>
          <ExternalLink size={15} />
        </Button>
        {deleteAction}
      </div>
    </div>
    {!row && showProducer && <ArtifactProducer producer={producer} className="mt-4" />}
  </>;
}
function ArtifactProducer({ producer, className }: { producer?: Bot; className?: string }) {
  return <div className={cn("flex min-w-0 items-center gap-1.5 text-xs text-slate-500", className)}>
    {producer ? <Avatar bot={producer} className="size-5 rounded-md" />
      : <CircleUserRound size={20} className="shrink-0 text-slate-400" />}
    <span className="truncate" title={producer?.name ?? '未知智能体'}>{producer?.name ?? '未知智能体'}</span>
  </div>;
}
function formatSize(value: number) {
  return value >= 1024 * 1024
    ? `${(value / 1024 / 1024).toFixed(1)} MB`
    : value >= 1024
      ? `${(value / 1024).toFixed(1)} KB`
      : `${value} B`;
}
