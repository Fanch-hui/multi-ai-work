# 核心流程与维护入口

## 从一条消息到一次执行

```mermaid
flowchart TD
  User[用户消息] --> Entry{管家固定入口}
  Entry -->|是| Routing[ChiefRoutingService 保存输入并接入连续主对话]
  Entry -->|群聊或成员私聊| Task[TaskService 保存消息与任务输入]
  Routing --> Task
  Task --> Scheduler[Scheduler 判断排队与准入]
  Scheduler --> Executor[Executor 管理一次运行]
  Executor --> Preparation[RunPreparation 准备请求与回调]
  Preparation --> Provider[ProviderAdapter 执行模型协议]
  Provider --> Tools[ToolRuntime 授权并执行工具]
  Tools --> Provider
  Provider --> Results[RunResults 保存运行结果]
  Results --> Storage[Storage 保存任务、消息与历史]
  Storage --> Sync[SnapshotSync 增量投影]
  Sync --> UI[TeamSnapshotStore 更新界面]
  Results --> Waiting[等待用户、成员或恢复时间]
  Waiting --> Scheduler
```

应用请求从 `CoreService.request` 进入。维护准入检查之后，请求按领域分发到连接、团队、历史、成果或现有业务服务。`CoreService` 同时是依赖装配和启动、关闭、备份恢复编排的入口。

一次用户消息可能创建任务，也可能成为正在执行任务的补充输入。任务运行成功后，若仍有未接收输入或成员结果，任务会重新排队或等待成员。`Run` 保存一次执行的结果，`Task` 保存整个任务的进度，两者各自表达不同的生命周期。

## 连续管家主对话与后台工作

`settings.mainConversationId` 是固定可见入口，名称和头像取自管家 Bot；模型、推理强度和上下文预算统一在「我的团队」配置。每个入口拥有唯一 `mainContextId`，指向 `ChiefWorkContext.kind = main` 的连续交流上下文。问候、讨论、追问和补充共用当前主段；实际执行继续使用 `Conversation → Task → Run → SessionBinding`。

| 服务 | 权威状态与职责 |
| --- | --- |
| `ChiefRoutingService` | `ChiefInput` 接收、幂等、顺序接入主段、重试与取消 |
| `ChiefContextService` | `main / work / history` 工作归属、当前段及来源引用；实际进度读取 Task |
| `ChiefWorkService` | `start_work / list_work`、独立工作创建、补充与续做、项目选择及资料授权 |
| `ChiefWorkReports` | 关键等待和最终结果的持久回报队列、去重及主对话串行接收 |
| `ChiefTimelineService` | `ChiefTimelineEntry` 稳定显示顺序、原消息引用与已读投影 |
| `ChiefHistoryService` | 管家直属历史检索、原消息锚点及确切来源授权 |
| `ChiefHistoryTasks` | 历史工作及执行段分页、原始指令归属、结束后的记录清理 |
| `ChiefMaintenanceService` | 上下文压力判断、压缩或分段、来源校验与交接 |

`chief.inputs.send` 在事务中保存输入与时间线引用，立即展示同一个用户消息气泡，再按提交顺序直接接入当前主段。派发时保存正式消息、绑定原时间线条目并清除临时正文。回复引用和旧工作参数作为本轮背景交给管家理解；归属问题由管家自然询问。失败与重试关联原输入和消息，已派发任务失败时沿真实 Task 的恢复规则处理。

文件制作、修改、命令及多步骤工作通过 `start_work` 建立独立内部会话，使用同一 Chief Bot 和普通 Task。调用幂等键由 Core 按来源任务和工具调用生成。该工作根任务通过工作索引关联主对话来源，不挂为主对话 Task 的子任务，主聊天可继续接收新消息。团队协作由后台工作建立显式来源任务群，成员任务沿现有父子任务树执行。

`send_task_input` 补充活动工作，消息在目标执行会话保存并保留来源及需求版本，接收游标取自目标会话。已结束工作以同一稳定工作 ID 创建关联的新 Task，保留 `reworkOfTaskId`、相关历史和成果。控制工具使用真实 Task/Run ID 校验主入口对工作及其成员后代的权限。附件与历史成果按确切 ID 授权，各工作保留自己的资料范围。

后台回报按工作、任务和内容版本去重并持久保存；用户输入优先。主会话空闲且待输入已接入后，回报由普通主对话任务串行处理，同一绑定只有一个写入者。原始工具过程留在工作记录，管家向用户发表简短状态和交付。Scheduler 优先接入主对话；全局和同账号上限大于 1 时为前台保留一个名额，上限为 1 时按原额度排队。

时间线保存原消息或待输入引用，保留原消息 ID、会话 ID 和序号，按独立显示序号分页。流式更新按原消息 ID 合并，已读按实际展示的来源消息分组确认。旧时间线及历史可继续查看；后台工作中的普通过程输出保存在真实执行会话。快照与增量携带工作目录、唯一主上下文和待输入。

主界面展示消息、输入框及一行真实后台工作进度；历史搜索位于「记录」，成果位于「库」。群聊与成员私聊保留会话管理。底部用量累计全部 Chief 请求，包括主聊天、本人后台工作和摘要整理；上下文占用读取当前主段，成员用量在各自任务详情查看。

「记录 → 历史任务」按稳定工作归属列出主上下文、后台工作和旧历史，展开后按执行段读取消息、交接、任务及原始用户指令。指令显示其真实来源上下文，关联任务指向实际接收该指令的工作。`chief.history.tasks.list / read / delete` 由 Core 校验当前管家所有权；主上下文持续保留，其他工作须先完成任务、关联群任务、问题、审批和操作对账。

历史工作删除先锁定全部执行会话，再保留独立成果正文并复核空闲状态，在同一事务中清理工作、任务、绑定和执行资料。主时间线已显示的原消息、序号和已读游标保留；仍承载这些原消息的内部会话标记 `timelineOnly`，仅用于时间线读取，普通会话管理、历史召回及任务接入均排除该载体。独立任务群保留并解除已删除工作的来源关系，交付成果及版本继续保留。

## 语音输入与语音对话

输入框的麦克风将识别文字写入可编辑草稿；侧栏呼叫图标打开固定管家入口并开始连续语音，停顿后发送识别结果并朗读回复。按钮使用图标及可访问名称，录音、识别、等待和朗读显示简短状态。离开会话释放录音与播放，尚未消费的呼叫请求随导航清理。

两种功能共用语音识别配置，连续语音另需合成模型和音色。语音服务与聊天模型连接独立，OpenAI 语音地址需要单独配置 API Key；免密钥的兼容服务可以留空。Core 与界面使用同一配置检查结果区分缺失项，实际服务请求再次校验。录音仅在内存处理并发送至配置地址，麦克风授权失败或初始化失败均释放已取得的设备资源。

## 项目授权与实际执行目录

`Workspace` 是授权目录的唯一来源，`enabled = false` 表示撤销，`writable` 表示读写或只读。`settings.defaultWorkspaceId` 稳定指向业务数据目录下的内置 `workspace`。迁移按实际路径复用该目录记录；显示名称、排序及最近使用项目不参与默认选择。

新工作未指定项目时使用内置「工作成果」，续做沿用原项目；明确名称匹配不到或重名时先询问确认。设置中的「工作目录」通过 `workspaces.add / workspaces.update` 登记目录、改名及调整授权。撤销保留目录记录、历史和原文件，内置默认目录保持可用。

管家可访问全部已授权目录，普通成员仅访问任务所在项目。`workspace-authorization.ts` 逐次解析工具的显式项目和实际路径，在审批、写锁及派发前确定有效工作区，并在排队或审批后重新检查。文件、搜索、命令执行目录、进程记录与成果归属共用该结果；文档转换分别校验输入来源与输出项目。会话的工作区不随某次工具调用改写。

授权收紧与目录写操作互斥，活跃写入或命令需先收尾；符号链接、敏感文件、观察版本及确切成果引用继续沿现有边界校验。

## 管家升级与历史兼容

数据库兼容版本为 3，备份格式为 4，恢复支持格式 1–4。结构升级预检位于表迁移、管家指令同步和调度恢复之前，要求全部任务结束或停止，运行与命令进程收尾。旧版本存在活动工作时，启动明确要求先在原版本完成或停止。

迁移保留固定入口及全部原消息、Task、Run、绑定、协议、成果 ID 和显示序号；旧话题上下文成为历史归属。新主段使用新绑定，按时间线来源引用组织近期原文和历史摘要，原协议保存在原绑定。稳定映射和迁移标记使重复执行保持幂等。旧任务接续建立关联的新 Task 和执行段，未知副作用先核查对账。

未派发输入保留请求 ID、消息 ID、附件和引用后进入主对话队列；已派发输入保留原归属。备份恢复将未结束任务标为中断、清理自动恢复检查点，待执行输入等待用户明确重试。恢复时内置目录定位到当前业务数据目录，外部项目保留原路径。新主段继承固定入口原有的记忆授权范围，原记忆分区和来源持续保留。

历史全文索引采用可重建的 SQLite FTS5 trigram、短词匹配和相关性排序，先过滤获准的管家直属历史，再由 `recall_work` 搜索候选、`read_work_history` 按消息锚点展开原文和成果。

主对话与各工作分别管理上下文，沿用既有预算和默认 85% 压缩阈值。活动执行在完整工具边界压缩；到达阈值后判断压缩续做或阶段交接。主段切换只等待主会话轮次、输入、问答、审批、命令及对账收尾，独立后台工作继续执行；工作换段检查其完整任务树。

交接保存目标、约束、决定、进度、待办、成果、后台工作引用及近期用户原文锚点，来源复核后原子更新当前段。摘要或校验失败保留现有可用历史，整理期间新输入持久等待。工作段与 `SessionBinding.generation` 分别表达工作接续和配置兼容性。

## 调度与执行的阅读顺序

1. [tasks.ts](../src/core/tasks.ts)：消息保存、任务创建、补充输入接入、成员结果回传。
2. [scheduler.ts](../src/core/scheduler.ts)：候选任务、准入判断、执行名额和停止；[scheduler-recovery.ts](../src/core/scheduler-recovery.ts)：启动恢复。
3. [executor.ts](../src/core/executor.ts)：启动运行、执行 Provider、等待在途操作结束、选择结果保存路径、释放资源。
4. [run-preparation.ts](../src/core/run-preparation.ts)：目录准备、历史和提示词、图片、工具及检查点回调装配。
5. [run-results.ts](../src/core/run-results.ts)：完成、提问等待、恢复和失败时的持久化。

Scheduler 优先安排管家主对话，再按现有优先级安排执行任务、主管代答和记忆整理，并检查依赖、成员资格、同成员同会话占用、账号额度与全局额度。排队展示与实际准入复用候选资料。取消请求先保存请求时间，再停止执行并等待实际收尾。

成功结束模型运行后，任务结果按以下优先级保存：

| 条件 | 任务状态 |
| --- | --- |
| 存在结果未知的工具操作或成员结果 | `interrupted`，等待对账 |
| 有尚未接收的补充输入 | `queued` |
| 仍有未结束或未回传的成员结果 | `waiting_children` |
| 本轮已完成且资料完整 | `completed` |

提问等待与模型恢复是独立路径。提问保存后释放执行名额，用户回答接续原任务；可恢复模型异常保留检查点与恢复时间，由 Scheduler 到期接续。

## 状态归属

| 状态 | 写入归属与读取入口 |
| --- | --- |
| 排队、运行、等待和任务结果 | `TaskService` 及运行结果保存事务；Scheduler 管理执行名额 |
| 本轮回复草稿 | `RunReplyWriter`；通过 `current` 读取当前消息，通过方法切换、发布或保留失败输出 |
| 补充消息的 pending / claimed / delivered | `TaskInputService`；用户与主管入口分别保留自己的授权检查 |
| 托管 Provider 运行中的消息、阶段、重试状态 | `ManagedRunState`；普通工具与提前工具通过状态方法写入 |
| 原始协议档案、工作投影与有效性 | `ManagedHistory`；运行结束在原结算事务中提交 |
| 工具操作 prepared / dispatched / succeeded / failed / unknown | `ToolOperationJournal`；ToolRuntime 负责授权、排队与派发顺序 |
| 文件观察版本与工具执行上下文 | `ToolContextFactory`；执行前继续读取当前授权 |
| MCP 初始化、连接、串行队列、目录修订和关闭 | `McpSessionManager`；`McpConnections` 保留授权、目录映射和工具调用业务 |
| 桌面 Core 子进程及未完成请求 | `CoreHost`；平台文件选择和系统操作在 `core-platform.ts` |
| 界面快照、会话选择与刷新队列 | 一个 `TeamSnapshotStore`；合并函数只计算投影 |

状态按职责就近保存。新增状态时应先确定唯一写入者，再选择现有存储或类作为归属；共享对象通过明确操作更新。

最终回复通过 `reply-artifacts.ts` 自动附加尚未发表的最新交付文件，同任务已通过 `post_message` 发出的文件沿用原消息；显式重发仍保留。启动与备份恢复时校正历史最终回复的重复附件关联，原文件和消息正文保留。

库与自动交付共用 `latestArtifactVersions`，显式版本系列优先，其余按稳定工作、实际项目、产出智能体和工作路径选择最新文件。续做沿用工作归属，跨段版本连续展示，不同工作或项目的同名文件独立保存。旧成果保留历史归属；库按工作分组并标注实际项目，历史版本折叠保留。真实产出者、任务、成果 ID 和正文持续保存。

聊天中的 AI 附件、工作记录的成果列表和库统一通过 `isDeliverableArtifact` 筛选最终交付。用户上传的资料保留在自己的消息中，工具全文、文档预览页等过程文件供内部读取。库将内容不同的历史交付版本折叠在当前成果下。

`ArtifactObjects` 按 SHA256 保存不可变正文，各会话、智能体和任务仍有独立成果记录与授权。文件名别名优先通过只读硬链接共享正文，文件系统不支持时使用副本；`registerTaskArtifact` 复用同一任务内内容、来源和版本一致的登记。旧 App 副本在空闲时分批迁移，引用 ID 保持稳定。

`ArtifactStorage` 管理容量统计、策略和后台回收。派生图片与文档页面统一按内容及转换参数缓存，默认总额度 512 MiB、闲置 7 天回收，活动转换受保护；工具 TXT 沿用独立的可重建正文缓存。未发送上传附件使用草稿租期，24 小时失去续租且没有持久引用后回收，删除前在同一同步边界复核租期与引用。交付成果、历史版本和工作区原文件持续保留。备份暂停维护并导出独立正文，恢复后可再次共享内容。

## 上下文、检查点与恢复

原始协议、工作上下文、摘要分别承担取证、模型输入和压缩职责。完整协议包含工具配对和不透明字段；工作投影可重建。`ManagedHistory` 集中历史加载、来源映射、归档提交和有效性保存，继续使用已有元数据键与档案格式。

Core 在 Provider 启动前准备恢复资料与运行上下文；Provider 开始执行后，运行中的可变状态由 `ManagedRunState` 管理。检查点保存成功后才确认补充输入已接收。

三个游标属于不同视图：

| 游标 | 含义 |
| --- | --- |
| `currentStart` | 工作投影中当前用户轮次的起点 |
| `archiveStart` | 当前运行在原始协议视图中的起点 |
| `compaction.start` | 压缩后工作投影中新增协议片段的起点 |

请求输入先持久化，再发送模型请求。完整 assistant 保存成功后才派发对应工具，结果逐项保存。普通执行、提前执行和增量重放共用 `insertOrderedToolResult`，按原调用顺序插入结果。恢复读取已保存结果，接续剩余操作；结果未知的副作用进入原有对账流程。

压缩只在完整工具边界替换工作投影，保留当前用户要求与原始资料。兼容性签名、绑定代次、来源版本和授权共同决定投影能否复用。

托管模型只调整推理强度时保留绑定和检查点。Core 的 `run-reasoning.ts` 在模型请求边界读取当前设置，Provider 为本次请求保存独立配置快照，当前流和工具继续使用原运行上下文。更换模型、连接或账号仍触发原有代次隔离；原生通道在后续运行应用新配置。

自定义 API 使用官方 Responses 端点且模型目录声明支持时，使用 `configuration_update`。ChatGPT 登录使用 SIWC 路由，其输入能力与 Codex 路由分别判断，推理强度通过每次请求的 `reasoning.effort` 更新；旧配置条目保留在档案中，发送时过滤。可信的 `reasoningUpdate` 历史条目保存请求强度基线和后续选择，随现有协议档案及检查点持久化，发送前保存成功；相邻配置仅在请求副本中合并，原始历史保持完整。配置更新不参与语义摘要，成功压缩后从工作投影清除，下次请求按当前强度建立新基线；失败或未压缩时保留原基线。其他端点、能力未知或供应商自定义档位保持请求级推理参数，完整历史与已完成工具结果继续复用。

## 存储、通知与界面同步

`Storage` 是统一 SQLite 入口，负责实体、消息、运行事件、事务和表版本。`storage-schema.ts` 保存初始化表、索引与兼容迁移。业务事务仍由发起该业务操作的服务拥有。

流式片段先保存到运行事件，再由 MessageStream 合并到消息。发布、回复切换、检查点和运行终态前会刷新待合并文字。五类配置快照按表版本缓存，事务内读取和恢复后的失效继续由存储与缓存层处理。

业务变化和流式内容分别通知；桌面通知合并在当前同步事务结束后发布。任务更新和已读确认可显式选择增量投影，仍按业务变化即时唤醒调度及补充输入监听。`state.changes` 的 `businessDeltas` 参数使客户端接收受影响会话、任务安排和补充输入；省略参数沿用原有完整刷新策略。消息变化只重算相关会话的未读数，完整快照仍提供全局列表。配置、需求变更、删除、恢复及未支持的投影变化继续完整刷新。

SnapshotSync 持有同步 epoch 与版本游标，TeamSnapshotStore 分别管理会话选择代次和历史分页代次。必要的完整重载前先发布已经持久化的增量；旧会话及旧分页响应经过代次检查后才可应用。消息顺序由合并层维护，空增量只推进游标，未变更的消息保持对象引用；聊天 Markdown 按正文复用渲染结果。

发送消息时按当前会话查询一次接收任务候选，排队任务的补充输入按任务索引查询。群聊各成员复用本次候选集合，仍按原有状态优先级及创建时间选择任务。上下文压缩仅在单次调用内复用 Token 估值，保持协议、摘要边界和持久化格式一致。

## 依赖边界与表达规范

- Domain 定义模型与公共协议；Runtime 依赖 Domain；Provider 和 Tools 依赖 Domain 与 Runtime；Core 负责业务编排和持久化。
- UI 的共享模型来自 Domain；桌面进程的双向消息类型也位于 Domain。桌面继续拥有 Electron 平台能力。
- Biome 检查受限导入与运行时循环依赖。纯类型引用按编译后的运行时依赖规则处理。
- 手写 JS、TS、TSX 使用两空格、单引号、分号、LF 换行和 100 字符换行参考线。Git 检出与 Biome 使用相同换行规则；固定摘要资料保留原始字节。不同副作用分行书写，复杂分支使用具名条件或顺序判断。
- 有独立变化原因的职责提取为模块；强时序和共享状态继续集中。文件和函数规模按展开后的代码评估。

## 验证入口

桌面更新只保存一个校验完成的候选包及原子写入的缓存记录。启动仍读取官方清单，平台、版本、大小与摘要匹配且文件复验通过后恢复安装入口；清单请求失败保留缓存。安装助手在任务目录记录实际进程 ID，回收避开仍在使用的源包，安装前继续复验文件并执行任务准入检查。

Release 草稿上传复用已校验安装包，并查询包源提交 SHA 对应的最新日常 CI。最新运行及 macOS、Windows 检查均成功后才允许上传；查询期间运行或重试轮次变化需要重新校验。

| 变更 | 优先测试 |
| --- | --- |
| 连续管家、后台工作、迁移与展示 | [chief-background-work](../tests/chief-background-work.test.ts)、[chief-continuity-migration](../tests/chief-continuity-migration.test.ts)、 [chief-routing](../tests/chief-routing.test.ts)、[chief-contracts](../tests/chief-contracts.test.ts)、[chief-history](../tests/chief-history.test.ts)、[chief-maintenance](../tests/chief-maintenance.test.ts)、[chief-maintenance-routing](../tests/chief-maintenance-routing.test.ts)、[chief-compat](../tests/chief-compat.test.ts)、[chief-work-ui](../tests/chief-work-ui.test.ts) |
| 调度、启动恢复、补充输入 | [scheduler](../tests/scheduler.test.ts)、[scheduler-recovery](../tests/scheduler-recovery.test.ts)、[task-input-admission](../tests/task-input-admission.test.ts)、[core-user-input](../tests/core-user-input.test.ts) |
| 执行结果、草稿、提问与停止 | [execution-lifecycle](../tests/execution-lifecycle.test.ts)、[run-publication](../tests/run-publication.test.ts)、[core-questions](../tests/core-questions.test.ts)、[task-controls](../tests/task-controls.test.ts) |
| 文件交付、历史附件与库版本 | [reply-artifacts](../tests/reply-artifacts.test.ts)、[artifact-groups](../tests/artifact-groups.test.ts)、[artifact-delete](../tests/artifact-delete.test.ts) |
| 协议、历史、检查点与压缩 | [managed-history](../tests/managed-history.test.ts)、[managed-progress](../tests/managed-progress.test.ts)、[managed-progress-deltas](../tests/managed-progress-deltas.test.ts)、[managed-recovery-lifecycle](../tests/managed-recovery-lifecycle.test.ts)、[manual-compaction-mcp](../tests/manual-compaction-mcp.test.ts) |
| 工具权限、操作保存与 MCP 生命周期 | [workspace-authorization](../tests/workspace-authorization.test.ts)、 [core-permissions](../tests/core-permissions.test.ts)、[core-mcp-revocation](../tests/core-mcp-revocation.test.ts)、[tool-operation-lifecycle](../tests/tool-operation-lifecycle.test.ts)、[mcp-lifecycle](../tests/mcp-lifecycle.test.ts) |
| 存储、增量快照和桌面进程 | [storage-binding](../tests/storage-binding.test.ts)、[snapshot-cache](../tests/snapshot-cache.test.ts)、[snapshot-sync](../tests/snapshot-sync.test.ts)、[snapshot-store](../tests/snapshot-store.test.ts)、[core-host](../tests/core-host.test.ts) |

测试文件位于 `tests/`，以上名称对应 `.test.ts`。涉及本地 HTTP/WebSocket 的协议用例需要允许监听本机临时端口。

常用命令：

```sh
pnpm format
pnpm check
pnpm typecheck
pnpm exec vitest run tests/execution-lifecycle.test.ts
pnpm test
python3 -B -m unittest discover -s scripts/presets -p 'test_*.py'
pnpm build
```

`pnpm format` 只负责格式，`pnpm check` 在 CI 中只读检查格式与规则。完整验证复用已有 macOS、Windows CI；界面交互由用户手动验收。
