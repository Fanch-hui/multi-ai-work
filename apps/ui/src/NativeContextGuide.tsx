import type { Connection } from "../../../src/domain/types.js";

export function NativeContextGuide({ connection }: { connection: Connection }) {
  const antigravity = connection.provider === "antigravity";
  return (
    <div className="text-sm text-slate-500">
      <p>由原生 CLI 设置生效 · 默认</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-slate-600">配置方法</summary>
        <div className="mt-3 space-y-2 text-pretty leading-6">
          <p>在智能体设置中选择官方支持的模型，窗口上限由该模型决定。原生运行时自动管理历史与压缩，保留默认即可。</p>
          {antigravity ? <>
            <p>在终端运行 <code>agy</code>，输入 <code>/config</code> 查看原生设置，<code>/context</code> 查看上下文占用。保留默认即可；App 不覆盖原生窗口或压缩参数。</p>
            <a className="inline-block text-blue-600" href="https://antigravity.google/docs/cli/reference/" target="_blank" rel="noreferrer">Antigravity CLI 配置说明</a>
          </> : <p>Qoder 在此 App 中通过 CN SDK 启动，采用模型提供的默认窗口与原生压缩设置。当前不提供手动窗口覆盖；修改终端 CLI 配置不会覆盖此 SDK 会话。</p>}
        </div>
      </details>
    </div>
  );
}

export function AntigravityPermissionsGuide() {
  return (
    <div className="text-pretty text-sm leading-6 text-slate-500">
      <p>下方勾选管理 App 团队工具。agy 内置的文件、命令、网页及原生 MCP 权限沿用本机 CLI 设置。</p>
      <details className="mt-2">
        <summary className="cursor-pointer text-slate-600">配置原生工具权限</summary>
        <div className="mt-3 space-y-2">
          <p>在终端运行 <code>agy</code>，输入 <code>/permissions</code> 管理权限规则，或通过 <code>/config</code> 修改原生权限模式。App 中的工具勾选不会覆盖这些设置。</p>
          <a className="inline-block text-blue-600" href="https://antigravity.google/docs/permissions/" target="_blank" rel="noreferrer">Antigravity 权限说明</a>
        </div>
      </details>
    </div>
  );
}
