import { useId } from 'react';
import type { ModelInfo, ProviderKind } from '../../../src/domain/types.js';
import {
  isReasoningSupported,
  reasoningConfiguration,
} from '../../../src/domain/model-reasoning.js';
import { Field, inputClass } from './components.js';

export function ReasoningField({
  provider,
  model,
  value,
  onChange,
  disabled = false,
}: {
  provider?: ProviderKind;
  model?: ModelInfo;
  value: string;
  onChange: (value: string) => void;
  disabled?: boolean;
}) {
  const listId = useId();
  const { options, fallback } = reasoningConfiguration(provider, model);
  const supported = isReasoningSupported(provider, model, value);
  let hint: string | undefined;
  if (!supported) {
    hint = `当前保存值“${value}”不在此模型目录的支持档位中。请选择默认或有效档位后保存。`;
  } else if (fallback) {
    hint = '服务商未提供档位，使用通用备选或填写服务商支持的值。留空使用默认值。';
  }
  if (!fallback && !options.length && !value) return null;
  return (
    <Field label="推理强度" hint={hint}>
      {fallback ? (
        <>
          <input
            className={inputClass}
            list={listId}
            value={value}
            disabled={disabled}
            maxLength={80}
            placeholder="默认"
            onChange={(event) => onChange(event.target.value)}
          />
          <datalist id={listId}>
            {options.map((option) => (
              <option key={option} value={option} />
            ))}
          </datalist>
        </>
      ) : (
        <select
          className={inputClass}
          value={value}
          disabled={disabled}
          title={
            model?.reasoningSource === 'official-catalog'
              ? '选项来自 OpenAI 官方模型目录'
              : '选项来自连接返回的模型目录'
          }
          onChange={(event) => onChange(event.target.value)}
        >
          {!supported && (
            <option value={value} disabled>
              {value}（目录不支持）
            </option>
          )}
          <option value="">默认</option>
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      )}
    </Field>
  );
}
