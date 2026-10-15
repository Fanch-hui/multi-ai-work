# 参与开发

使用 Node.js 22.23.2 与 `package.json` 指定的 pnpm 版本：

```sh
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
python scripts/presets/test_build.py
pnpm build
```

Core 是任务、工具权限与持久状态的权威。原生通道由各自运行时管理会话，App 管理 ChatGPT 与自定义 API 的上下文。修改恢复逻辑时，应保留完整工具配对、取消语义、文件版本校验与未知操作对账。

## 提交内容

| 内容 | 处理方式 |
| --- | --- |
| 源码、测试、构建脚本、锁文件、公开文档与 CI | 提交 |
| 预设技能、示例、媒体与许可文件 | 按固定摘要完整提交，保留原始字节及各自许可 |
| 账号凭据、环境变量文件、密钥、vault、原生 profile 与会话 | 留在本机 |
| 用户数据库、备份、附件、真实任务和验收成果 | 留在本机 |
| 依赖、缓存、运行库、构建与发布产物、日志 | 由本机或 CI 生成 |
| 本机协作规则、项目记忆与临时计划 | 留在本机 |

项目自有代码使用 [Apache-2.0](LICENSE)。第三方材料以各目录的许可证为准，参见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。

## 持续集成

复用 `.github/workflows/ci.yml`：push、Pull Request 或手动触发都会运行 macOS 与 Windows 的完整测试、类型检查、预设构建测试和生产构建。同一分支的新提交会取消旧的运行。

pnpm store 按系统、架构、Node、pnpm 和锁文件缓存，依赖安装成功即保存。Electron 下载缓存用于安装包门禁，在实际打包下载后保存。安装始终使用 frozen lockfile；不缓存 `node_modules`，避免复用错误的原生 ABI。

发布前从 Actions 手动运行 `Validate desktop packages`。它复用依赖与下载缓存，并生成两平台安装包，在独立目录验证 Core 启动及 Office 转换。Office 下载按运行库锁文件缓存，命中后仍校验摘要。安装包与报告通过 Actions artifacts 获取。

常规 CI 没有随包 Office 运行库时，相关转换测试会显式跳过。真实账号推理、窗口交互、托盘和安装生命周期需要单独验收；CI 日志与摘要会保留实际覆盖范围。
