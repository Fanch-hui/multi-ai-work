---
name: business-customer-journey-map
description: "Create an end-to-end customer journey map with stages, touchpoints, emotions, pain points, and opportunities. Use when mapping the customer experience, identifying friction points, improving onboarding, or visualizing the user journey."
---

## App 执行约定

先读取本技能正文及任务所需的本地参考资源。使用中文；工作目录由任务提供，仅读取用户提供、当前任务授权的资料。正文中的 `$ARGUMENTS` 及斜杠命令表示用户任务输入，不调用 Claude 专用命令。`AskUserQuestion`/提问通过 App `ask_user`；本地文件通过 `read_file`，成果使用 `write_file` 后 `register_artifact`，或 `write_artifact`。相对资源路径以本 SKILL.md 所在目录为起点。若技能读取结果含目录，按该目录构建资源绝对路径。

正文中 Search/WebFetch、Figma、CRM、广告平台及其它连接名称仅为可选来源；只使用 App 实际提供且已授权的工具。没有连接时从上传材料完成流程，把缺少的外部验证列出，不安装运行时插件或扫描用户全局配置。默认输出 Markdown/CSV 草稿；Office、图表、HTML、PNG 或图像生成只在对应工具和运行库可用时执行。不得擅自发送邮件、发表内容、签约、创建发票、修改线上商品或花费广告预算。

## Customer Journey Map

Map the end-to-end customer experience from awareness through advocacy, identifying emotions, pain points, and improvement opportunities at each stage.

### Context

You are creating a customer journey map for **$ARGUMENTS**.

If the user provides files (interview transcripts, survey data, analytics, support tickets, or existing journey maps), read them first. Use web search to understand the product if a URL is provided.

### Instructions

1. **Define the persona**: Who is traveling this journey? Use a specific persona with JTBD, not a generic user.

2. **Map the journey stages** (adapt to the product):

   | Stage | Description |
   |---|---|
   | **Awareness** | How do they first learn about the product? |
   | **Consideration** | What do they evaluate? What alternatives do they compare? |
   | **Acquisition** | How do they sign up or purchase? |
   | **Onboarding** | First experience with the product — time to value |
   | **Engagement** | Regular usage — building habits |
   | **Retention** | What keeps them coming back? What might cause churn? |
   | **Advocacy** | When and why do they recommend the product to others? |

3. **For each stage, document**:

   - **Touchpoints**: Where the user interacts with the product, brand, or team (website, email, in-app, support, social media)
   - **User actions**: What they do at this stage
   - **Thoughts & questions**: What's on their mind ("Is this worth my time?" "How do I...?")
   - **Emotions**: How they feel (excited, confused, frustrated, delighted) — rate on a scale or use emoji indicators
   - **Pain points**: Friction, confusion, drop-off risks
   - **Opportunities**: How to improve the experience at this point

4. **Identify critical moments**:
   - **Aha moment**: When the user first experiences core value
   - **Moments of truth**: Decision points where they commit or abandon
   - **Churn triggers**: Where users most commonly drop off

5. **Create the journey map table**:

   | Stage | Touchpoint | User Action | Emotion | Pain Point | Opportunity |
   |---|---|---|---|---|---|

6. **Recommend prioritized improvements**:
   - Which pain points have the highest impact on conversion or retention?
   - What quick wins can improve the experience immediately?
   - What requires deeper investment but has the biggest payoff?

Think step by step. Save as a markdown document. For visual journey maps, suggest the user create one in Miro or FigJam using this analysis as the foundation.

---

### Further Reading

- [User Journey Mapping 101](https://www.productcompass.pm/p/user-journey-mapping-101)
- [Funnel Analysis 101: How to Track and Optimize Your User Journey](https://www.productcompass.pm/p/funnel-analysis)
- [Market Research: Advanced Techniques](https://www.productcompass.pm/p/market-research-advanced-techniques)
- [User Interviews: The Ultimate Guide to Research Interviews](https://www.productcompass.pm/p/interviewing-customers-the-ultimate)
