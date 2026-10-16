import { useState, type FormEvent } from "react";
import { Database, Download, Upload, FolderOpen, Check } from "lucide-react";
import type { Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { choosePath, errorMessage, snapshot } from "./api.js";
import { generalSettings, restoreGeneralSettings } from "./general-settings.js";
import { Button, Confirm, ErrorNote, Field, inputClass, cn } from "./components.js";
import { AppUpdateSettings } from "./AppUpdate.js";
import { DataDirectoryField } from "./DataDirectoryField.js";
export function General({ data, mutate }: { data: Snapshot; mutate: Mutate }) {
  const [settings, setSettings] = useState(() => generalSettings(data.settings));
  const [error, setError] = useState("");
  const [busy, setBusy] = useState("");
  const [notice, setNotice] = useState("");
  const [restorePath, setRestorePath] = useState("");
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy("settings");
    setError("");
    setNotice("");
    try {
      await mutate("settings.save", { input: settings });
      setNotice("运行设置已保存");
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function backup() {
    setBusy("backup");
    setError("");
    setNotice("");
    try {
      const result = await mutate<{ path: string }>("backup.create");
      setNotice(`备份已保存：${result.path}`);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy("");
    }
  }
  async function browse() {
    try {
      const path = await choosePath("directory");
      if (path) setRestorePath(path);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }
  const fields: { key: "maxActiveRuns" | "maxChildren" | "maxCoordinationRounds"; label: string; hint: string; min: number; max?: number }[] = [
    { key: "maxActiveRuns", label: "同时工作智能体上限", hint: "其余任务会排队，空出位置后继续。", min: 1, max: 15 },
    { key: "maxChildren", label: "每任务最多分派成员任务", hint: "一个任务最多能拆成多少项成员任务。", min: 1, max: 30 },
    { key: "maxCoordinationRounds", label: "主管自动跟进次数上限", hint: "0 表示不限。成员任务完成后，主管自动继续处理的次数；不限制群聊发言。", min: 0 },
  ];
  return (
    <div className="grid gap-8">
      <section>
        <h2 className="mb-5 text-balance text-base font-semibold">工作与协作</h2>
        <form
          className="grid gap-5 rounded-xl border border-slate-200 bg-white p-5"
          onSubmit={(event) => void save(event)}
        >
          <div className="grid gap-4 sm:grid-cols-2">
            {fields.map((field) => (
              <Field key={field.key} label={field.label} hint={field.hint}>
                <input
                  type="number"
                  min={field.min}
                  max={field.max}
                  step={1}
                  required
                  className={inputClass}
                  value={Number(settings[field.key])}
                  onChange={(event) =>
                    setSettings({
                      ...settings,
                      [field.key]: Number(event.target.value),
                    })
                  }
                />
              </Field>
            ))}
          </div>
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.autoAnswerMemberQuestions}
              className="mt-1"
              onChange={(event) => setSettings({ ...settings, autoAnswerMemberQuestions: event.target.checked })}
            />
            <span>成员提问超过 2 分钟由主管代答
              <span className="mt-1 block text-xs leading-5 text-slate-500">仅适用于主管委派的任务群。</span>
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={settings.trayEnabled}
              onChange={(event) => setSettings({ ...settings, trayEnabled: event.target.checked })}
            />
            关闭窗口后继续在后台工作
          </label>
          <div className="flex justify-end">
            <Button variant="primary" disabled={!!busy}>
              {busy === "settings" ? "保存中…" : "保存设置"}
            </Button>
          </div>
        </form>
      </section>
      <section>
        <div className="mb-5 flex items-center gap-2">
          <Database size={18} className="text-slate-500" />
          <h2 className="text-balance text-base font-semibold">数据与备份</h2>
        </div>
        <div className="grid gap-4 rounded-xl border border-slate-200 bg-white p-5">
          <DataDirectoryField key={data.dataDirectory} path={data.dataDirectory} disabled={!!busy} />
          <div className="flex flex-wrap gap-3">
            <Button disabled={!!busy} onClick={() => void backup()}>
              <Download size={16} />
              {busy === "backup" ? "备份中…" : "创建备份"}
            </Button>
          </div>
          <div className="border-t border-slate-100 pt-4">
            <Field label="恢复备份">
              <div className="flex flex-wrap gap-2">
                <input
                  className={cn(inputClass, "min-w-0 flex-1")}
                  value={restorePath}
                  onChange={(event) => setRestorePath(event.target.value)}
                  placeholder="备份目录路径"
                />
                <Button aria-label="选择备份目录" onClick={() => void browse()}>
                  <FolderOpen size={16} />
                </Button>
                <Confirm
                  title="恢复此备份？"
                  description="当前工作台数据将被替换。请先创建当前数据的备份，并停止正在运行的任务。"
                  actionLabel="恢复备份"
                  onConfirm={async () => {
                    setBusy("restore");
                    setNotice("");
                    setError("");
                    try {
                      setSettings(await restoreGeneralSettings(restorePath, mutate, snapshot));
                      setNotice("备份已恢复");
                    } finally {
                      setBusy("");
                    }
                  }}
                >
                  <Button disabled={!restorePath || !!busy}>
                    <Upload size={16} />
                    恢复
                  </Button>
                </Confirm>
              </div>
            </Field>
          </div>
        </div>
      </section>
      <ErrorNote error={error} />
      {notice && (
        <p
          role="status"
          className="flex items-start gap-2 rounded-lg bg-blue-50 p-3 text-pretty text-sm text-blue-800"
        >
          <Check size={16} className="mt-0.5 shrink-0" />
          {notice}
        </p>
      )}
      <AppUpdateSettings />
    </div>
  );
}
