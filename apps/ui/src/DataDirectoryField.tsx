import { useId, useState } from "react";
import { FolderOpen } from "lucide-react";
import { choosePath, dataDirectoryBridge, errorMessage } from "./api.js";
import { Button, ErrorNote, inputClass } from "./controls.js";
import { cn } from "./classNames.js";
import { Confirm } from "./dialogs.js";

export function DataDirectoryField({ path, disabled }: { path: string; disabled?: boolean }) {
  const id = useId();
  const [draft, setDraft] = useState(path);
  const [error, setError] = useState("");
  const [phase, setPhase] = useState<"" | "choosing" | "migrating" | "restarting">("");
  const bridge = dataDirectoryBridge();
  const target = draft.trim();
  const locked = disabled || !!phase;
  async function browse() {
    setPhase("choosing");
    setError("");
    try {
      const selected = await choosePath("directory");
      if (selected) setDraft(selected);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setPhase("");
    }
  }
  async function change() {
    if (!bridge) return;
    setPhase("migrating");
    setError("");
    try {
      await bridge.change(target);
      setPhase("restarting");
    } catch (cause) {
      setPhase("");
      throw cause;
    }
  }
  return (
    <div className="grid gap-1.5" aria-busy={phase === "migrating" || phase === "restarting"}>
      <label htmlFor={id} className="text-sm font-medium text-slate-700">数据目录</label>
      <div className="flex flex-wrap gap-2">
        <input
          id={id}
          className={cn(inputClass, "min-w-0 flex-1")}
          value={bridge ? draft : path}
          readOnly={!bridge}
          disabled={locked}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          placeholder="文件夹完整路径"
          onChange={(event) => { setDraft(event.target.value); setError(""); }}
        />
        {bridge && <>
          <Button type="button" disabled={locked} aria-label="选择数据目录" onClick={() => void browse()}>
            <FolderOpen size={16} aria-hidden="true" />
          </Button>
          <Confirm
            title="更改数据目录？"
            description={`将聊天、记忆、文件和模型连接复制到 ${target}，完成后重启应用。旧位置的数据副本会保留。`}
            actionLabel={phase === "migrating" ? "正在迁移…" : "迁移并重启"}
            actionVariant="primary"
            onConfirm={change}
          >
            <Button type="button" disabled={locked || !target || target === path}>更改位置</Button>
          </Confirm>
        </>}
      </div>
      <p id={`${id}-hint`} className="text-xs leading-5 text-slate-500">
        {bridge ? "可输入完整路径或选择文件夹。请使用新建或空文件夹，并先结束或停止所有任务。" : "请在桌面应用中更改数据目录"}
      </p>
      {bridge && target !== path && <p className="break-all text-xs leading-5 text-slate-500">当前使用：{path}</p>}
      {error && <div id={`${id}-error`}><ErrorNote error={error} /></div>}
      <p role="status" className="text-sm text-blue-700">
        {phase === "migrating" ? "正在复制数据，请稍候…" : phase === "restarting" ? "数据已复制，正在重启…" : ""}
      </p>
    </div>
  );
}
