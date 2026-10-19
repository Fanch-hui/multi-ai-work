import type { Connection, ModelInfo } from '../../../src/domain/types.js';
import {
  DEFAULT_COMPACTION_THRESHOLD,
  defaultContextWindow,
  managedContextBudget,
} from '../../../src/domain/context-settings.js';
import { Field, cn, inputClass } from './components.js';

export function ContextBudgetFields({
  provider,
  model,
  contextWindow,
  onContextWindowChange,
  compactionThreshold,
  onCompactionThresholdChange,
  outputReserve,
}: {
  provider?: Connection['provider'];
  model?: ModelInfo;
  contextWindow: string;
  onContextWindowChange: (value: string) => void;
  compactionThreshold: string;
  onCompactionThresholdChange: (value: string) => void;
  outputReserve?: number;
}) {
  const defaultWindow = defaultContextWindow(provider, model);
  const window = contextWindow ? Number(contextWindow) : defaultWindow;
  const threshold = Number(compactionThreshold) || DEFAULT_COMPACTION_THRESHOLD;
  const budget = managedContextBudget(window, threshold, outputReserve);
  const effective = budget.effectiveCompactionThreshold;
  const adjusted = effective !== undefined && effective < threshold;
  const hint =
    `上下文达到窗口的 ${threshold}% 时整理历史，预留 ${100 - threshold}% 空间。` +
    (adjusted ? `当前回复预留使实际触发点为 ${Number(effective.toFixed(2))}%。` : '');
  return (
    <>
      <Field
        label="上下文窗口（tokens）"
        hint={
          defaultWindow
            ? `默认 ${defaultWindow.toLocaleString()} tokens；清空恢复默认，不能超过模型支持的范围。`
            : '填写模型支持的窗口大小；清空使用模型目录。'
        }
      >
        <input
          type="number"
          min={1024}
          step={1}
          className={cn(inputClass, 'tabular-nums')}
          value={contextWindow || defaultWindow?.toString() || ''}
          onChange={(event) => onContextWindowChange(event.target.value)}
          placeholder="模型窗口未知"
        />
      </Field>
      <Field label="压缩阈值" hint={hint}>
        <div className="relative">
          <input
            type="number"
            required
            min={10}
            max={95}
            step={1}
            className={cn(inputClass, 'pr-10 tabular-nums')}
            value={compactionThreshold}
            onChange={(event) => onCompactionThresholdChange(event.target.value)}
          />
          <span className="pointer-events-none absolute right-3 top-2.5 text-sm text-slate-400">
            %
          </span>
        </div>
      </Field>
    </>
  );
}
