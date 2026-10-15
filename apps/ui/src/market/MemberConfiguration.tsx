import type { Snapshot } from '../../../../src/domain/types.js';
import type { PresetMemberConfiguration } from '../../../../src/domain/market.js';
import { Field, inputClass } from '../components.js';
import { BotTools } from '../BotTools.js';
import { AntigravityPermissionsGuide, NativeContextGuide } from '../NativeContextGuide.js';

export function MemberConfiguration({ data, value, change, includeName = false }: {
  data: Snapshot; value: PresetMemberConfiguration; change: (value: PresetMemberConfiguration) => void; includeName?: boolean;
}) {
  const connections = data.connections.filter(item => item.status === 'ready');
  const connection = connections.find(item => item.id === value.connectionId);
  const model = connection?.models.find(item => item.id === value.model);
  const update = (fields: Partial<PresetMemberConfiguration>) => change({ ...value, ...fields });
  return <div className="grid gap-4">
    {includeName && <Field label="成员名称"><input className={inputClass} value={value.name || ''} onChange={event => update({ name: event.target.value })} /></Field>}
    <div className="grid items-start gap-4 sm:grid-cols-2">
      <Field label="连接"><select required className={inputClass} value={value.connectionId} onChange={event => update({ connectionId: event.target.value, model: '', reasoning: undefined })}>
        <option value="">选择连接</option>{connections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></Field>
      <Field label="模型">{connection?.models.length ? <select required className={inputClass} value={value.model} onChange={event => update({ model: event.target.value, reasoning: undefined })}>
        <option value="">选择模型</option>{connection.models.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select> : <input required className={inputClass} value={value.model} placeholder="模型 ID" onChange={event => update({ model: event.target.value, reasoning: undefined })} />}</Field>
      {!!model?.reasoning?.length && <Field label="推理强度"><select className={inputClass} value={value.reasoning || ''} onChange={event => update({ reasoning: event.target.value || undefined })}>
        <option value="">默认</option>{model.reasoning.map(item => <option key={item} value={item}>{item}</option>)}
      </select></Field>}
    </div>
    {connection && (connection.provider === 'qoder' || connection.provider === 'antigravity') && <NativeContextGuide connection={connection} />}
    {connection?.provider === 'antigravity' && <AntigravityPermissionsGuide />}
    <BotTools data={data} toolNames={value.toolNames} approvalMode={value.approvalMode} toolConnectionIds={value.toolConnectionIds}
      qoderServices={value.qoderServices} onQoderServicesChange={connection?.provider === 'qoder' ? qoderServices => update({ qoderServices }) : undefined}
      onPermissionsChange={update} onConnectionsChange={toolConnectionIds => update({ toolConnectionIds })} />
    {includeName && <Field label="个人补充要求"><textarea rows={3} className={inputClass} value={value.personalInstructions || ''} onChange={event => update({ personalInstructions: event.target.value })} /></Field>}
  </div>;
}
