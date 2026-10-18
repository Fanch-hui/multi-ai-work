import { useId } from 'react';
import type { ModelInfo, ProviderKind } from '../../../src/domain/types.js';
import { isReasoningSupported, reasoningConfiguration } from '../../../src/domain/model-reasoning.js';
import { Field, inputClass } from './components.js';

export function ReasoningField({ provider, model, value, onChange, disabled = false }: {
  provider?: ProviderKind; model?: ModelInfo; value: string; onChange: (value: string) => void; disabled?: boolean;
}) {
  const listId = useId();
  const { options, fallback } = reasoningConfiguration(provider, model);
  if (!fallback && !options.length) return null;
  const selected = isReasoningSupported(provider, model, value) ? value : '';
  return <Field label="推理强度" hint={fallback ? '服务商未提供档位，使用通用备选或填写服务商支持的值。留空使用默认值。' : undefined}>
    {fallback ? <>
      <input className={inputClass} list={listId} value={selected} disabled={disabled} maxLength={80}
        placeholder="默认" onChange={event => onChange(event.target.value)} />
      <datalist id={listId}>{options.map(option => <option key={option} value={option} />)}</datalist>
    </> : <select className={inputClass} value={selected} disabled={disabled}
      title={model?.reasoningSource === 'official-catalog' ? '选项来自 OpenAI 官方模型目录' : '选项来自连接返回的模型目录'}
      onChange={event => onChange(event.target.value)}>
      <option value="">默认</option>{options.map(option => <option key={option} value={option}>{option}</option>)}
    </select>}
  </Field>;
}
