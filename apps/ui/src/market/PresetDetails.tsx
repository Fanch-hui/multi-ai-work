import type { AgentPreset, PresetInstallation } from '../../../../src/domain/market.js';
import type { Bot } from '../../../../src/domain/types.js';
import { Button, Confirm, Modal } from '../components.js';

export function PresetDetails({ preset, installation, bots, close, hire, hiring, cancel, remove, openMember, update, checkUpdates }: {
  preset: AgentPreset; installation?: PresetInstallation; bots: Bot[]; close: () => void;
  hire: () => void; hiring: boolean; cancel: () => void; remove: () => Promise<unknown>;
  openMember: (bot: Bot) => void; update?: () => void; checkUpdates: () => void;
}) {
  return <Modal open title={preset.name} description={preset.description} onOpenChange={open => !open && close()} wide>
    <div className="grid gap-5">
      <div className="flex flex-wrap gap-3 text-xs text-slate-500"><span>版本 {preset.version}</span><span>{installation?.source === 'local' ? '本地导入' : '官方精选'}</span><span>{preset.license}</span></div>
      <div><h3 className="mb-2 text-sm font-medium">典型成果</h3><p className="text-sm leading-6 text-slate-500">{preset.outputs.join('、')}</p></div>
      <div><h3 className="mb-2 text-sm font-medium">使用示例</h3><ul className="grid list-inside list-disc gap-2 text-sm leading-6 text-slate-500">{preset.examples.map(example => <li key={example}>{example}</li>)}</ul></div>
      <details className="rounded-xl border border-slate-200 p-4"><summary className="cursor-pointer text-sm font-medium">岗位职责与工作指令</summary><p className="mt-3 whitespace-pre-wrap text-sm leading-6 text-slate-600">{preset.instructions}</p></details>
      <div><h3 className="mb-3 text-sm font-medium">配套技能</h3><div className="grid gap-3">{preset.skills.map(skill => <div key={skill.key} className="rounded-xl bg-slate-50 p-4">
        <h4 className="text-sm font-medium">{skill.name}</h4><p className="mt-1 text-sm leading-6 text-slate-500">{skill.description}</p>
        {skill.source && <div className="mt-3 text-xs leading-5 text-slate-400">
          <a href={skill.source.repository} target="_blank" rel="noreferrer" className="text-blue-700 hover:underline">来源仓库</a> · {skill.source.license}{skill.source.stars !== undefined && ` · ${skill.source.stars} Star`}
          <p className="break-all">固定提交：{skill.source.commit}</p><p className="break-all">路径：{skill.source.path}</p>
          {skill.source.verifiedAt && <p>选型核验：{skill.source.verifiedAt}</p>}
        </div>}
      </div>)}</div></div>
      <div><h3 className="mb-2 text-sm font-medium">依赖与支持平台</h3><p className="text-xs text-slate-500">{preset.platforms.map(platform => ({ darwin: 'macOS', win32: 'Windows', linux: 'Linux' })[platform]).join(' / ')}</p>
        {preset.dependencies.length ? <ul className="mt-2 grid gap-2 text-sm text-slate-500">{preset.dependencies.map(item => <li key={`${item.kind}:${item.key}`}>{item.label} · {item.required ? '必需' : '可选'}</li>)}</ul> : <p className="mt-2 text-sm text-slate-500">无需额外服务。</p>}
      </div>
      {bots.length > 0 && <div><h3 className="mb-2 text-sm font-medium">关联成员</h3><div className="flex flex-wrap gap-2">{bots.map(bot => <Button key={bot.id} onClick={() => openMember(bot)}>{bot.name}{bot.archived ? '（已归档）' : ''}</Button>)}</div></div>}
      {installation?.error && <p role="alert" className="text-sm text-red-600">{installation.error}</p>}
      <div className="flex flex-wrap items-center justify-between gap-3 border-t border-slate-100 pt-4">
        {installation?.status === 'downloading' ? <Button onClick={cancel}>取消下载</Button> : installation ? <Confirm title="删除下载内容？" description="只删除本地资源；仍被成员引用的版本需要先解除引用。" actionLabel="删除" onConfirm={remove}><Button variant="ghost">删除下载内容</Button></Confirm> : <span />}
        <div className="flex flex-wrap gap-2">{installation && <Button onClick={checkUpdates}>检查更新</Button>}{update && <Button onClick={update}>更新成员</Button>}
          <Button variant="primary" disabled={installation?.status === 'downloading' || hiring} onClick={hire}>{installation?.status === 'downloading' ? `下载中 ${installation.progress}%` : bots.length ? '再雇佣一位' : '雇佣'}</Button>
        </div>
      </div>
    </div>
  </Modal>;
}
