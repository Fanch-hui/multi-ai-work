---
name: business-sealeap-qiongqi-amazon-ai-product-gap-research
description: "Use an agentic AI workflow on raw Amazon keyword exports and customer feedback to locate shopper-intent gaps with demand but weak supply, then produce a product definition, unit economics, and supplier quote requests that are verified by hand before any sourcing decision. Use for AI 选品、找市场缺口、有需求没供给的细分、产品开发方向、单位经济测算、供应商询价整理. Do not use AI projections as final numbers or to skip compliance and IP checks."
---

## App 执行约定

先读取本技能正文及任务所需的本地参考资源。使用中文；工作目录由任务提供，仅读取用户提供、当前任务授权的资料。正文中的 `$ARGUMENTS` 及斜杠命令表示用户任务输入，不调用 Claude 专用命令。`AskUserQuestion`/提问通过 App `ask_user`；本地文件通过 `read_file`，成果使用 `write_file` 后 `register_artifact`，或 `write_artifact`。相对资源路径以本 SKILL.md 所在目录为起点。若技能读取结果含目录，按该目录构建资源绝对路径。

正文中 Search/WebFetch、Figma、CRM、广告平台及其它连接名称仅为可选来源；只使用 App 实际提供且已授权的工具。没有连接时从上传材料完成流程，把缺少的外部验证列出，不安装运行时插件或扫描用户全局配置。默认输出 Markdown/CSV 草稿；Office、图表、HTML、PNG 或图像生成只在对应工具和运行库可用时执行。不得擅自发送邮件、发表内容、签约、创建发票、修改线上商品或花费广告预算。

本技能补充约定：有上传数据时不必取外部数据；外部取数脚本为可选，不调用任何未授权或需付费接口。当前App连接通过实际工具目录授权，不能以脚本代替授权。

# Amazon AI 辅助选品缺口与单位经济

## 目标

Use an agentic AI workflow on raw Amazon keyword exports and customer feedback to locate shopper-intent gaps with demand but weak supply, then produce a product definition, unit economics, and supplier quote requests that are verified by hand before any sourcing decision.

## 不可妥协的边界

- 当前 Amazon 官方政策、账户资格、站点字段和一方数据优先于本 Skill 的经验框架。
- 第三方数据一律标为估算或前台观测，不得写成 Amazon 一方事实。
- 默认只读诊断和草案；任何广告、Listing、库存、促销或外部系统写操作都需逐项展示并取得明确批准。
- 一次实验只改变一个主要变量，并记录基线、样本、成功、停止和回退条件。
- 不得复制来源材料或竞品表达；输出必须按当前任务重新组织并可由现有证据支撑。
- 『几分钟产出等同顾问级报告』是来源观点；AI 的财务预测与供应商报价可能失真或幻觉，只作草稿。
- 『需求高供给弱』依赖第三方搜索量估算，季节性与词义歧义会夸大需求，需交叉验证。
- 智能体自动操作浏览器与外部网站时要控制授权范围与数据泄露风险，不要把账户凭证交给它。
- 选品决策还受合规、IP、库存资金等约束，本流程只覆盖需求与经济性初筛。

## 先判断任务模式

1. **诊断**：读取现状、证据和缺口，不生成线上写入动作。
2. **方案草案**：输出可审核的结构、参数范围、实验和回退值。
3. **执行准备**：只生成待批准变更表或 API/控制台操作草案。
4. **已批准执行**：仅对用户在当前会话明确批准的对象和字段执行，并立即回读核验。

用户未指定时采用“诊断”。

## 开始前要拿到

- 目标 marketplace、类目、价格带、上架时间与运营模式
- 候选品与同购买意图可比样本的销量、评论、价格和上架时间
- 关键词需求、历史趋势、广告依赖、同款密度和品牌集中度
- 采购、头程、平台费、退货、仓储、交期和合规/IP 基础信息

缺失项必须标为 `NEEDS_EVIDENCE`；不得猜数字、补属性或把不同站点、ASIN、变体、币种和时间窗混在一起。

## 工作流

先读取 [references/playbook.md](references/playbook.md)，确认该方法适用于当前对象。按以下顺序执行：

1. 先定上下文：目标细分、现有产品事实、约束（预算、MOQ、目标毛利、站点）；给智能体的任务要像交给一名员工，附资料而非只给一句话。
2. 从关键词工具导出该细分主词的完整未过滤关键词列表，连同评论或反馈样本一起提供；不要预处理，让模型做聚合与分组。
3. 要求输出：按购买意图聚类的关键词及搜索量合计、每个意图簇下现有供给（在售数量、评论数、评分、价格）与需求的对照，标出『需求高、供给弱』的缺口。
4. 对每个缺口人工验证：回到导出数据核对该簇搜索量是否真实、在站内搜索确认供给确实稀少或质量差、查看评论确认痛点存在。
5. 让 AI 基于反馈做产品定义（必备特性、差异点）与单位经济（售价、成本、物流、费用、目标 ACOS 下的盈亏平衡），并整理供应商询价；所有价格与报价当作草稿，逐条向供应商与物流核实。
6. 补做合规与 IP 初筛后再决定是否立项；把该意图簇的关键词表直接带入后续 PPC 活动规划。

最后做数据充分性检查，并把结论分成 `FACT / ESTIMATE / HYPOTHESIS / UNKNOWN`。若关键证据不足，状态写 `HOLD`。

## 第三方 MCP 数据

仅在自有数据不足且当前任务确实需要外部证据时，读取 [references/mcp-data-plan.md](references/mcp-data-plan.md)，再使用 `scripts/mcp_research.py`。本 Skill 的外部取数目的：获取关键词需求、竞品供给（在售数量、评论、价格）与评论痛点的第三方代理数据。

- 先 `doctor`，再 `search-tools` 和 `describe`；工具名及参数以实时 `tools/list` 与 `inputSchema` 为准。
- Token 只从环境变量读取。不得写入命令参数、URL、Skill、报告、日志或 Git。
- `tools/call` 或 Actor 可能计费；先展示 Provider、工具、无密钥业务参数、预计成本与输出位置，核对已有授权覆盖后才加 `--allow-cost`；该标志不是费用上限。


## 必须交付的结果

- 上下文与资料包
- 意图缺口分析表
- 缺口人工验证记录
- 产品定义与单位经济草案
- 供应商询价清单
- 数据范围、来源、采集时间、样本与限制。
- 关键假设、待补证据、风险和不可确定项。
- 若有动作：对象、旧值、新值、预期、停止条件、回退值与审批状态。

方案状态使用 `READY FOR REVIEW / DRAFT / HOLD / STOP`；如已执行，另行记录实际结果及回读证据。未得到明确批准时，不得声称已修改线上对象。
