---
name: business-competitive-battlecard
description: "Create sales-ready competitive battlecards comparing your product against a specific competitor — positioning, feature comparison, objection handling, and win/loss patterns. Use when preparing sales teams, creating competitive materials, or responding to 'why not competitor X?'"
---

## App 执行约定

先读取本技能正文及任务所需的本地参考资源。使用中文；工作目录由任务提供，仅读取用户提供、当前任务授权的资料。正文中的 `$ARGUMENTS` 及斜杠命令表示用户任务输入，不调用 Claude 专用命令。`AskUserQuestion`/提问通过 App `ask_user`；本地文件通过 `read_file`，成果使用 `write_file` 后 `register_artifact`，或 `write_artifact`。相对资源路径以本 SKILL.md 所在目录为起点。若技能读取结果含目录，按该目录构建资源绝对路径。

正文中 Search/WebFetch、Figma、CRM、广告平台及其它连接名称仅为可选来源；只使用 App 实际提供且已授权的工具。没有连接时从上传材料完成流程，把缺少的外部验证列出，不安装运行时插件或扫描用户全局配置。默认输出 Markdown/CSV 草稿；Office、图表、HTML、PNG 或图像生成只在对应工具和运行库可用时执行。不得擅自发送邮件、发表内容、签约、创建发票、修改线上商品或花费广告预算。

## Competitive Battlecard

Create a concise, sales-ready battlecard for use against a specific competitor.

### Context

You are creating a competitive battlecard for **$ARGUMENTS**.

Use web search to research the competitor's current product, pricing, positioning, and recent changes. If the user provides files (feature lists, win/loss data, sales call notes), read them first.

### Instructions

1. **Research the competitor** (use web search):
   - Current product offerings and features
   - Pricing tiers and model
   - Target market and positioning
   - Recent product launches or changes
   - Known strengths and weaknesses
   - Customer reviews and sentiment (G2, Capterra, Reddit)

2. **Create the battlecard** with these sections:

   ### Company Overview
   - Founded, HQ, funding/revenue (if public)
   - Target market and ICP
   - Positioning in one sentence

   ### Quick Comparison

   | Capability | Us | Them | Winner |
   |---|---|---|---|
   | [Feature area 1] | [Our approach] | [Their approach] | [Us/Them/Tie] |
   | [Feature area 2] | ... | ... | ... |
   | Pricing | ... | ... | ... |
   | Support | ... | ... | ... |

   ### Where We Win
   - [Advantage 1]: [Proof point or customer quote]
   - [Advantage 2]: [Specific capability they lack]
   - [Advantage 3]: [Better approach with reasoning]

   ### Where They Win
   - [Their strength 1]: [Our counter-positioning]
   - [Their strength 2]: [How we mitigate this gap]

   ### Common Objections & Responses

   | Prospect Says | Respond With |
   |---|---|
   | "Competitor X has [feature]" | "[Our alternative approach and why it's better for them]" |
   | "They're cheaper" | "[Value framing: total cost of ownership, ROI, hidden costs]" |
   | "They're more established" | "[Our advantages: speed, innovation, focus, support]" |

   ### Landmines to Plant
   Questions to ask the prospect that highlight competitor weaknesses:
   - "How important is [area where we excel] to your team?"
   - "Have you evaluated [specific capability they lack]?"

   ### Win/Loss Patterns
   - We tend to win when: [pattern]
   - We tend to lose when: [pattern]
   - Key differentiator in competitive deals: [what tips the scale]

3. **Keep it scannable**: Sales reps need to reference this during calls. Use tables, bold text, and short bullets.

Save as markdown. Format for easy printing or sharing in Notion/Confluence.

---

### Further Reading

- [How to Design a Value Proposition Customers Can't Resist?](https://www.productcompass.pm/p/how-to-design-value-proposition-template)
