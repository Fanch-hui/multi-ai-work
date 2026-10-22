import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import type { ModelInfo } from '../src/domain/types.js';
import { ReasoningField } from '../apps/ui/src/ReasoningField.js';

function render(model?: ModelInfo, value = '', provider: 'custom' | 'chatgpt' = 'custom') {
  return renderToStaticMarkup(
    createElement(ReasoningField, { provider, model, value, onChange: () => {} }),
  );
}

describe('reasoning configuration field', () => {
  it('offers clearly labeled generic choices for a custom service without declared levels', () => {
    for (const model of [undefined, { id: 'vendor-model', name: 'Vendor model' }]) {
      const html = render(model);
      expect(html).toContain('服务商未提供档位，使用通用备选或填写服务商支持的值');
      expect(html).toContain('<input');
      expect(html).toContain('<datalist');
      expect(html).toContain('value=""');
      for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
        expect(html).toContain(`value="${level}"`);
    }
  });

  it('retains a provider-specific value in the free input without requiring a generic match', () => {
    expect(render({ id: 'vendor-model', name: 'Vendor model' }, 'vendor-intensive')).toContain(
      'value="vendor-intensive"',
    );
  });

  it('uses only the real declared levels, including an explicit empty list', () => {
    const html = render(
      { id: 'gpt-5', name: 'Service model', reasoning: ['vendor-intensive'] },
      'vendor-intensive',
    );
    expect(html).toContain('<select');
    expect(html).toContain('vendor-intensive');
    expect(html).not.toContain('<datalist');
    expect(html).not.toContain('value="max"');
    expect(render({ id: 'gpt-5', name: 'Service model', reasoning: [] })).toBe('');
    expect(render(undefined, '', 'chatgpt')).toBe('');
  });

  it('keeps an unsupported saved level visible and offers an explicit default choice', () => {
    const html = render(
      { id: 'gpt-5', name: 'Service model', reasoning: ['high'] },
      'max',
      'chatgpt',
    );

    expect(html).toContain('当前保存值“max”不在此模型目录的支持档位中');
    expect(html).toContain('max（目录不支持）');
    expect(html).toContain('disabled');
    expect(html).toContain('<option value="">默认</option>');
  });

  it('shows the field for an unsupported saved level even when the catalog has no options', () => {
    const html = render({ id: 'gpt-5', name: 'Service model', reasoning: [] }, 'medium', 'chatgpt');

    expect(html).toContain('medium（目录不支持）');
    expect(html).toContain('<option value="">默认</option>');
  });
});
