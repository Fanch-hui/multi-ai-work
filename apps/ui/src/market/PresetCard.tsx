import { UserPlus, ChevronRight } from 'lucide-react';
import type { AgentPreset, PresetInstallation } from '../../../../src/domain/market.js';
import { Avatar, Button, cn } from '../components.js';

export function PresetCard({ preset, installation, memberCount, selected, toggle, details, hire, hiring }: {
  preset: AgentPreset; installation?: PresetInstallation; memberCount: number; selected: boolean;
  toggle: () => void; details: () => void; hire: () => void; hiring: boolean;
}) {
  const ready = installation?.status === 'installed';
  const downloading = installation?.status === 'downloading';
  const label = memberCount ? `${memberCount} 位成员` : ready ? '资源已准备' : downloading ? `下载中 ${installation.progress}%` : installation?.status === 'failed' ? '下载失败' : '待雇佣';
  return <article className={cn('flex min-w-0 flex-col rounded-2xl border bg-white p-5', selected ? 'border-blue-300' : 'border-slate-200')}>
    <div className="flex items-start gap-3">
      <Avatar name={preset.name} color="#2563eb" />
      <button onClick={details} className="min-w-0 flex-1 text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        <h3 className="truncate text-sm font-semibold text-slate-900">{preset.name}</h3>
        <p className="mt-1 truncate text-xs text-slate-400">{installation?.source === 'local' ? '本地导入 · ' : ''}{preset.role}</p>
      </button>
      <input type="checkbox" aria-label={`选择 ${preset.name}`} checked={selected} onChange={toggle} className="mt-1" />
    </div>
    <p className="mt-4 line-clamp-2 min-h-10 text-pretty text-sm leading-5 text-slate-500">{preset.description}</p>
    <p className="mt-3 truncate text-xs text-slate-400">{preset.outputs.join(' · ')}</p>
    <div className="mt-4 flex items-center gap-2 text-xs text-slate-500"><span>{preset.skills.length} 个技能</span><span>·</span><span className="truncate">{label}</span></div>
    {downloading && <progress max={100} value={installation.progress} aria-label={`${preset.name} 下载进度`} className="mt-3 h-1.5 w-full accent-blue-600" />}
    {installation?.error && <p role="alert" className="mt-2 line-clamp-2 text-xs text-red-600">{installation.error}</p>}
    <div className="mt-auto flex items-center justify-between gap-2 pt-4">
      <Button variant="ghost" className="px-0 text-xs" onClick={details}>查看详情<ChevronRight size={13} /></Button>
      <Button className="text-xs" disabled={downloading || hiring} onClick={hire}>
        <UserPlus size={14} />{downloading ? '下载中…' : memberCount ? '再雇佣一位' : '雇佣'}
      </Button>
    </div>
  </article>;
}
