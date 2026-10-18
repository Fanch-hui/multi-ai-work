import { useState, type FormEvent } from "react";
import { Archive } from "lucide-react";
import type { Bot, Snapshot } from "../../../src/domain/types.js";
import type { Mutate } from "./store.js";
import { errorMessage } from "./api.js";
import { Button, Confirm, ErrorNote, Field, Modal, cn, inputClass } from "./components.js";
import { BotTools } from "./BotTools.js";
import { defaultToolNames } from "../../../src/domain/tool-permissions.js";
import { enabledQoderServices } from "../../../src/domain/qoder-services.js";
import { AntigravityPermissionsGuide, NativeContextGuide } from "./NativeContextGuide.js";
import { AvatarPicker } from "./AvatarPicker.js";
import { isChiefProvider } from "../../../src/domain/chief-provider.js";
import { DEFAULT_COMPACTION_THRESHOLD } from "../../../src/domain/context-settings.js";
import { ContextBudgetFields } from "./ContextBudgetFields.js";
import { skillsForMember } from "./skill-lists.js";
const colors = ["#047857", "#2563eb", "#d97706", "#dc2626", "#475569"];
export function BotEditor({
  bot,
  data,
  mutate,
  close,
  configureConnection,
}: {
  bot?: Bot;
  data: Snapshot;
  mutate: Mutate;
  close: () => void;
  configureConnection?: () => void;
}) {
  const [name, setName] = useState(bot?.name || "");
  const [role, setRole] = useState(bot?.role || "");
  const [personalInstructions, setPersonalInstructions] = useState(bot?.personalInstructions || "");
  const [detached, setDetached] = useState<Bot>();
  const preset = detached ? undefined : bot?.preset;
  const [instructions, setInstructions] = useState(bot?.instructions || "");
  const main = bot?.id === data.settings.mainBotId;
  const readyConnections = data.connections.filter((item) => item.status === "ready" && (!main || isChiefProvider(item.provider)));
  const [connectionId, setConnection] = useState(bot?.connectionId || "");
  const [model, setModel] = useState(bot?.model || "");
  const [reasoning, setReasoning] = useState(bot?.reasoning || "");
  const [contextWindow, setContextWindow] = useState(bot?.contextWindow?.toString() || "");
  const [compactionThreshold, setCompactionThreshold] = useState(String(bot?.compactionThreshold ?? DEFAULT_COMPACTION_THRESHOLD));
  const [avatar, setAvatar] = useState(bot?.avatar || (main ? "owl" : "cat"));
  const [color, setColor] = useState(bot?.color || colors[0]);
  const [memoryMode, setMemory] = useState<Bot["memoryMode"]>(bot?.memoryMode === "off" ? "off" : "propose");
  const [toolNames, setTools] = useState(bot?.toolNames || defaultToolNames(main));
  const [approvalMode, setApprovalMode] = useState<NonNullable<Bot["approvalMode"]>>(bot?.approvalMode || "ask");
  const [toolConnectionIds, setToolConnections] = useState(bot?.toolConnectionIds || []);
  const [qoderServices, setQoderServices] = useState(bot?.qoderServices);
  const [skillIds, setSkills] = useState(bot?.skillIds || []);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const connection = readyConnections.find((item) => item.id === connectionId);
  const native = connection?.provider === "antigravity" || connection?.provider === "qoder";
  const selectedModel = connection?.models.find((item) => item.id === model);
  const reasoningOptions = selectedModel?.reasoning || [];
  const selectedReasoning = reasoningOptions.includes(reasoning) ? reasoning : "";
  const availableSkills = skillsForMember(data.skills);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      await mutate(main ? "chief.configure" : "bots.save", {
        input: {
          ...(main ? { id: bot?.id, outputReserve: bot?.outputReserve } : detached || bot),
          name,
          ...(!main && { role, instructions: preset ? preset.baseInstructions : instructions, personalInstructions: preset ? personalInstructions : undefined }),
          connectionId,
          model,
          reasoning: selectedReasoning || undefined,
          contextWindow: !native && contextWindow ? Number(contextWindow) : undefined,
          compactionThreshold: !native ? Number(compactionThreshold) : undefined,
          avatar,
          color,
          memoryMode,
          toolNames,
          approvalMode,
          toolConnectionIds,
          ...(!main && { qoderServices: connection?.provider === "qoder" ? enabledQoderServices({ qoderServices, toolNames }) : qoderServices }),
          skillIds,
        },
      });
      close();
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  const toggle = (items: string[], value: string) =>
    items.includes(value) ? items.filter((item) => item !== value) : [...items, value];
  return (
    <Modal open onOpenChange={(open) => !open && close()} title={main ? "配置主智能体" : bot ? `编辑 ${bot.name}` : "新建智能体"} wide>
      <form className="grid gap-4" onSubmit={(event) => void save(event)}>
        <AvatarPicker value={avatar} onChange={setAvatar} mutate={mutate} />
        <div className={cn("grid gap-4", !main && "sm:grid-cols-2")}>
          <Field label="名称">
            <input
              className={inputClass}
              value={name}
              onChange={(event) => setName(event.target.value)}
              required
              placeholder="例如：Chief"
            />
          </Field>
          {!main && <Field label="职责">
            <input
              className={inputClass}
              value={role}
              onChange={(event) => setRole(event.target.value)}
              required
              placeholder="例如：协调与成果审核"
            />
          </Field>}
        </div>
        {!main && <Field label={preset ? "预设工作指令" : "工作指令"}>
          <textarea
            className={inputClass}
            rows={5}
            value={preset ? preset.baseInstructions : instructions}
            readOnly={!!preset}
            onChange={(event) => setInstructions(event.target.value)}
            placeholder="说明工作目标、交付标准和协作方式"
          />
        </Field>}
        {preset && <><Field label="个人补充要求" hint="更新预设时保留，适合补充你的工作习惯和交付偏好。"><textarea className={inputClass} rows={3} value={personalInstructions} onChange={event => setPersonalInstructions(event.target.value)} /></Field>
          <Confirm title="转为自定义成员？" description="保留当前指令和技能，之后可以自由编辑，并停止跟随预设更新。" actionLabel="转换" onConfirm={async () => {
            if (!bot) return;
            const next = await mutate<Bot>('market.detach', { botId: bot.id }); setDetached(next); setInstructions(next.instructions); setPersonalInstructions('');
          }}><Button type="button" variant="ghost" className="justify-self-start">转为自定义成员</Button></Confirm></>}
        <div className="grid items-start gap-4 sm:grid-cols-2">
          <Field label="连接">
            <select
              className={inputClass}
              value={connectionId}
              onChange={(event) => {
                setConnection(event.target.value);
                setModel("");
                setReasoning("");
              }}
              required
            >
              <option value="">选择连接</option>
              {readyConnections.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select>
          </Field>
          <Field label="模型">
            {connection?.models.length ? <select
              required
              className={inputClass}
              value={model}
              onChange={(event) => {
                setModel(event.target.value);
                setReasoning("");
              }}
            >
              <option value="">选择模型</option>
              {connection?.models.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                </option>
              ))}
            </select> : <input className={inputClass} required value={model} placeholder="输入服务支持的模型 ID"
              onChange={(event) => { setModel(event.target.value); setReasoning(""); }} />}
          </Field>
          {reasoningOptions.length > 0 && <Field label="推理强度">
            <select
              className={inputClass}
              title={selectedModel?.reasoningSource === "official-catalog" ? "选项来自 OpenAI 官方模型目录" : "选项来自连接返回的模型目录"}
              value={selectedReasoning}
              onChange={(event) => setReasoning(event.target.value)}
            >
              <option value="">默认</option>
              {reasoningOptions.map((value) => (
                <option key={value} value={value}>
                  {value}
                </option>
              ))}
            </select>
          </Field>}
          <Field label="记忆">
            <select
              className={inputClass}
              value={memoryMode}
              onChange={(event) => setMemory(event.target.value as Bot["memoryMode"])}
            >
              <option value="propose">自主管理</option>
              <option value="off">关闭</option>
            </select>
          </Field>
          {!native && <ContextBudgetFields provider={connection?.provider} model={selectedModel}
            contextWindow={contextWindow} onContextWindowChange={setContextWindow}
            compactionThreshold={compactionThreshold} onCompactionThresholdChange={setCompactionThreshold}
            outputReserve={bot?.outputReserve} />}
        </div>
        {native && connection && <NativeContextGuide connection={connection} />}
        {!readyConnections.length && <div className="flex items-center justify-between gap-3 rounded-lg bg-slate-50 p-3">
          <p className="text-sm text-slate-500">先连接并登录模型供应商。</p>
          {configureConnection && <Button type="button" onClick={() => { close(); configureConnection(); }}>添加连接</Button>}
        </div>}
        <fieldset>
          <legend className="mb-2 text-sm font-medium text-slate-700">成员颜色</legend>
          <div className="flex gap-2">
            {colors.map((value) => (
              <button
                key={value}
                type="button"
                className={`size-7 rounded-full border-2 ${value === color ? "border-slate-900" : "border-transparent"}`}
                style={{ backgroundColor: value }}
                aria-label={`颜色 ${value}`}
                aria-pressed={value === color}
                onClick={() => setColor(value)}
              />
            ))}
          </div>
        </fieldset>
        {connection?.provider === "antigravity" && <AntigravityPermissionsGuide />}
        <BotTools
          chief={main}
          data={data}
          toolNames={toolNames}
          approvalMode={approvalMode}
          toolConnectionIds={toolConnectionIds}
          onPermissionsChange={value => { setTools(value.toolNames); setApprovalMode(value.approvalMode); }}
          onConnectionsChange={setToolConnections}
          qoderServices={qoderServices}
          onQoderServicesChange={!main && connection?.provider === "qoder" ? setQoderServices : undefined}
        />
        <fieldset>
            <legend className="mb-2 text-sm font-medium text-slate-700">Skills</legend>
            <p className="mb-3 text-xs text-slate-500">内置 Word、Excel、PPT、PDF 技能默认可用。勾选此成员需要使用的已导入技能；市场配套技能随成员保留。</p>
            <div className="flex flex-wrap gap-4">
              {!availableSkills.length && <p className="text-xs text-slate-400">尚未导入技能，可在设置中导入。</p>}
              {availableSkills.map((item) => (
                <label key={item.id} className="flex items-center gap-2 text-sm text-slate-600">
                  <input
                    type="checkbox"
                    checked={skillIds.includes(item.id)}
                    onChange={() => setSkills(toggle(skillIds, item.id))}
                  />
                  {item.name}{item.missing ? '（资源缺失，请重新导入）' : ''}
                </label>
              ))}
            </div>
        </fieldset>
        <ErrorNote error={error} />
        <div className="mt-2 flex justify-between gap-3">
          {bot && !bot.archived && !main ? (
            <Confirm
              title={`归档 ${bot.name}？`}
              description="此成员将不再出现在新会话中，历史记录继续保留。"
              actionLabel="归档"
              onConfirm={async () => {
                await mutate("bots.archive", { id: bot.id });
                close();
              }}
            >
              <Button type="button" variant="ghost">
                <Archive size={16} />
                归档
              </Button>
            </Confirm>
          ) : (
            <span />
          )}
          <div className="flex gap-2">
            <Button type="button" onClick={close}>
              取消
            </Button>
            <Button variant="primary" disabled={busy || connection?.status !== "ready" || !model.trim() || (!!connection.models.length && !selectedModel)}>
              {busy ? "保存中…" : main ? "保存 Chief" : "保存智能体"}
            </Button>
          </div>
        </div>
      </form>
    </Modal>
  );
}
