import type { Bot, Snapshot } from '../../../src/domain/types.js';
import { Field, inputClass } from './components.js';
import { skillsForMember } from './skill-lists.js';

const colors = ['#047857', '#2563eb', '#d97706', '#dc2626', '#475569'];

export function MemoryModeField({ value, change }: { value: Bot['memoryMode']; change: (value: Bot['memoryMode']) => void }) {
  return <Field label="记忆"><select className={inputClass} value={value === 'off' ? 'off' : 'propose'}
    onChange={event => change(event.target.value as Bot['memoryMode'])}>
    <option value="propose">自主管理</option><option value="off">关闭</option>
  </select></Field>;
}

export function MemberColorField({ value, change }: { value: string; change: (value: string) => void }) {
  return <fieldset><legend className="mb-2 text-sm font-medium text-slate-700">成员颜色</legend>
    <div className="flex gap-2">{colors.map(color => <button key={color} type="button"
      className={`size-7 rounded-full border-2 ${value === color ? 'border-slate-900' : 'border-transparent'}`}
      style={{ backgroundColor: color }} aria-label={`颜色 ${color}`} aria-pressed={value === color} onClick={() => change(color)} />)}</div>
  </fieldset>;
}

export function MemberSkillsField({ data, value, change }: { data: Snapshot; value: string[]; change: (value: string[]) => void }) {
  const skills = skillsForMember(data.skills);
  return <fieldset><legend className="mb-2 text-sm font-medium text-slate-700">Skills</legend>
    <p className="mb-3 text-xs text-slate-500">内置 Word、Excel、PPT、PDF 技能默认可用。勾选此成员需要使用的已导入技能；市场配套技能随成员保留。</p>
    <div className="flex flex-wrap gap-4">
      {!skills.length && <p className="text-xs text-slate-400">尚未导入技能，可在设置中导入。</p>}
      {skills.map(skill => <label key={skill.id} className="flex items-center gap-2 text-sm text-slate-600">
        <input type="checkbox" checked={value.includes(skill.id)} onChange={() => change(value.includes(skill.id)
          ? value.filter(id => id !== skill.id) : [...value, skill.id])} />
        {skill.name}{skill.missing ? '（资源缺失，请重新导入）' : ''}
      </label>)}
    </div>
  </fieldset>;
}
