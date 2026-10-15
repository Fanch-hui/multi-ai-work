---
name: business-sealeap-fenghuang-amazon-product-exclusion-review-mining
description: "Screen product ideas for the US marketplace with an exclusion list—too cheap, trend-driven, seasonal, restricted—then mine competitor listings and low-star reviews for fixable defects, and confirm that an existing audience is already buying before committing to a supplier. Use for 什么产品不能做、低价产品能不能卖、季节品要不要做、看差评找改良点、竞品 Listing 有没有机会. Do not use to approve restricted categories or to estimate market size without third-party or account data."
---

## App 执行约定

先读取本技能正文及任务所需的本地参考资源。使用中文；工作目录由任务提供，仅读取用户提供、当前任务授权的资料。正文中的 `$ARGUMENTS` 及斜杠命令表示用户任务输入，不调用 Claude 专用命令。`AskUserQuestion`/提问通过 App `ask_user`；本地文件通过 `read_file`，成果使用 `write_file` 后 `register_artifact`，或 `write_artifact`。相对资源路径以本 SKILL.md 所在目录为起点。若技能读取结果含目录，按该目录构建资源绝对路径。

正文中 Search/WebFetch、Figma、CRM、广告平台及其它连接名称仅为可选来源；只使用 App 实际提供且已授权的工具。没有连接时从上传材料完成流程，把缺少的外部验证列出，不安装运行时插件或扫描用户全局配置。默认输出 Markdown/CSV 草稿；Office、图表、HTML、PNG 或图像生成只在对应工具和运行库可用时执行。不得擅自发送邮件、发表内容、签约、创建发票、修改线上商品或花费广告预算。

本技能补充约定：商品排除与差评方法以Amazon为例；不得把来源观点视为中国平台政策，所有平台费用、审核和资质判断以当前资料为准。

# Amazon 选品排除清单与差评改良验证

## 目标

Screen product ideas for the US marketplace with an exclusion list—too cheap, trend-driven, seasonal, restricted—then mine competitor listings and low-star reviews for fixable defects, and confirm that an existing audience is already buying before committing to a supplier.

## 不可妥协的边界

- 当前 Amazon 官方政策、账户资格、站点字段和一方数据优先于本 Skill 的经验框架。
- 第三方数据一律标为估算或前台观测，不得写成 Amazon 一方事实。
- 默认只读诊断和草案；任何广告、Listing、库存、促销或外部系统写操作都需逐项展示并取得明确批准。
- 一次实验只改变一个主要变量，并记录基线、样本、成功、停止和回退条件。
- 不得复制来源材料或竞品表达；输出必须按当前任务重新组织并可由现有证据支撑。
- 来源的价格带区间是个人经验，不同类目费用结构不同，必须按当前站点重新计算。
- 「差评一多销量就下滑」与「评论多就有市场」都是观察，不作定律；评论抓取受站点、变体与时间影响。
- 因运输破损产生的差评可按平台流程申请处理，结果不保证；不采用任何刷评或操纵评论的做法。
- 需求验证要用当前搜索量、销量估算与前台观测交叉，不依赖单一工具的机会评分。

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

1. 排除低价薄利品：用当前站点的佣金、FBA 费与预期 CPC 算单件利润，若几次点击就吃掉利润则不做；价格带上限以「买家能否冲动决策」和自有资金校准，来源区间仅作参考。
2. 排除短期热点与强季节品：核对关键词搜索量的历史曲线，若需求窗口短于「生产 + 头程 + 入仓」周期，或全年只有一段有销量，则记为不做，并把长期仓储费风险写入判定。
3. 排除受限与需资质品类：先查当前站点的品类审核与禁售清单，再确认是否需要认证、保险或额外预处理。
4. 在通过排除的候选里，按评论数排序看头部竞品：评论多代表样本大、有现成买家；检查其标题是否遗漏核心搜索词、图片与 A+ 是否薄弱。
5. 逐条读低星评论并分类：包装破损、口味或材质、尺寸误导、缺件等可改良项，与情绪化无信息评论分开；只保留可通过产品或包装解决的问题。
6. 以「已有人在买 + 可改良点明确 + 供应商能落实改良」三条同时成立作为进入打样的条件，缺一则 HOLD。

最后做数据充分性检查，并把结论分成 `FACT / ESTIMATE / HYPOTHESIS / UNKNOWN`。若关键证据不足，状态写 `HOLD`。

## 第三方 MCP 数据

仅在自有数据不足且当前任务确实需要外部证据时，读取 [references/mcp-data-plan.md](references/mcp-data-plan.md)，再使用 `scripts/mcp_research.py`。本 Skill 的外部取数目的：获取竞品 Listing、评论样本与关键词需求趋势的第三方代理证据。

- 先 `doctor`，再 `search-tools` 和 `describe`；工具名及参数以实时 `tools/list` 与 `inputSchema` 为准。
- Token 只从环境变量读取。不得写入命令参数、URL、Skill、报告、日志或 Git。
- `tools/call` 或 Actor 可能计费；先展示 Provider、工具、无密钥业务参数、预计成本与输出位置，核对已有授权覆盖后才加 `--allow-cost`；该标志不是费用上限。


## 必须交付的结果

- 排除清单判定表
- 候选品单件利润测算
- 竞品差评分类表
- 可改良点清单
- 进入打样判定
- 数据范围、来源、采集时间、样本与限制。
- 关键假设、待补证据、风险和不可确定项。
- 若有动作：对象、旧值、新值、预期、停止条件、回退值与审批状态。

方案状态使用 `READY FOR REVIEW / DRAFT / HOLD / STOP`；如已执行，另行记录实际结果及回读证据。未得到明确批准时，不得声称已修改线上对象。
