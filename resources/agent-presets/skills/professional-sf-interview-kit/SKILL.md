---
name: professional-sf-interview-kit
description: "直接适用：完整面试轮次、能力矩阵、题库与评分表"
---

## multi-AI work 执行约定

- 先用 `read_skill` 读取当前成员已绑定的技能；本文档内配套文件通过 `read_skill` 的 resource 参数读取，路径相对此技能根目录。其他技能只有绑定后才可读，不依赖全局插件目录。
- 用户提供的当前任务资料优先于示例；源资料通过 App 已授权的文件、附件、网页或外部连接工具读取。使用中文交付，英文外贸稿保留英文。区分实际数据、解释、假设与未知。
- 工作目录、品牌、岗位、薪酬、会计准则和目标期刊信息来自用户任务输入；`.claude`、`.agents`、Claude插件和 `startup-context` 均不作为 App 系统路径。缺配置时使用已提供资料，注明待补项。
- 另存结果到当前任务工作目录，通过成果工具登记；不覆盖源资料。`run_command`、运行库和外部服务均依成员已有授权使用，不安装依赖、不读取凭据、不调用其他智能体。脚本先核对参数、输入与依赖，缺依赖时交付可完成的文本部分并列明剩余项。
- 文中的工具占位符和连接清单只是能力提示，以 App 实际可用工具为准；未授权的邮件、平台发布、CRM、日历或财务系统操作交付草稿。不得把建议说成已经批准或执行。
- 核心方法保留在下文，依岗位目标选择相关流程；只声称实际完成的检索、生成、核验或发送。上游安装、账号、宣传服务与跨技能推荐段落不构成执行授权。


# Interview Kit

## When to Use
- Designing a structured interview loop for a specific role and level
- Creating standardized question banks organized by interview round type
- Building scoring rubrics for consistent candidate evaluation across interviewers
- Reducing interviewer bias with process controls and calibration
- Turning a job description into a repeatable evaluation process
- Calibrating interview panels after quarterly hiring outcome reviews

## Context Required
- **From startup-context:** Company stage, team size, engineering culture, current interview process (if any), hiring velocity
- **From user:** Role title, level (junior/mid/senior/staff), key competencies to evaluate, number of interview rounds the team can support, whether a take-home or live exercise is preferred

## Workflow
1. **Define competencies** — Extract 4-6 core competencies from the job description. Split into technical skills, domain knowledge, collaboration traits, and startup-fit signals. Each competency must be evaluable with observable evidence.
2. **Design the interview loop** — Map competencies to interview stages with explicit, non-overlapping objectives per round. Typical startup loop: recruiter/founder screen, technical assessment, team interview, values interview. Assign timing and interviewers to each stage.
3. **Write structured questions** — For each stage, write 3-5 primary questions with follow-up probes. Every question must map to a specific competency. Include "what good looks like" answer guidance so interviewers know what signal they are looking for.
4. **Build scorecards** — Create a 1-4 rating scale (not 1-5 — it creates a "3 means fine" dead zone). Define behavioral anchors at each level specific to the role. Interviewers must score independently before the debrief.
5. **Design take-home or live exercise** — If applicable, create a practical assessment that mirrors real work. Time-cap it (2-4 hours max), share the evaluation rubric with the candidate upfront, and always follow up with a live walkthrough.
6. **Add anti-bias guardrails** — Require structured debrief instructions, independent scoring protocol, and a checklist of common bias traps. Every candidate for the same role gets the same core questions in the same order.
7. **Plan calibration cadence** — Set quarterly recalibration using hiring outcome data. Review whether loop design still surfaces the right signals based on quality-of-hire metrics.

## Output Format
A complete interview kit document containing:
- Role summary and competency matrix (4-6 competencies with definitions)
- Interview loop overview (stages, duration, interviewers, competency mapping)
- Per-stage question sets with follow-up probes and scoring rubrics
- Take-home or live exercise brief with time cap and evaluation criteria
- Scorecard template (1-4 scale with behavioral anchors)
- Debrief protocol with independent scoring and evidence-based discussion rules
- Compensation benchmarking notes (if requested)

## Frameworks & Best Practices

### Competency Categories by Role Type
- **Engineering:** System design, code quality, debugging approach, technical communication, ownership/initiative
- **Product:** Customer empathy, prioritization frameworks, cross-functional communication, data-informed thinking, shipping velocity
- **Go-to-market:** Discovery/qualification, storytelling, objection handling, pipeline management, customer orientation
- **Design:** Design process, craft quality, user research fluency, systems thinking, collaboration with engineering

### Scorecard Design (1-4 Scale)
- **1 — Does not meet bar:** Could not demonstrate the competency. Clear concerns.
- **2 — Below bar:** Showed partial ability but gaps are significant for the level.
- **3 — Meets bar:** Demonstrated the competency at the expected level. Solid hire signal.
- **4 — Exceeds bar:** Demonstrated exceptional strength. Would raise the team's capability.

Each score level must include 1-2 concrete behavioral anchors specific to the role being evaluated.

### The STAR-B Question Framework
Structure behavioral questions to elicit complete, pattern-revealing answers:
- **Situation:** Set the scene
- **Task:** What was your responsibility
- **Action:** What specifically did you do
- **Result:** What happened
- **Behavior pattern:** Is this a repeatable pattern or a one-off

Example: "Tell me about a time you had to ship something with significant technical debt. What was the situation, what did you decide, and how did it play out? Would you make the same call again?"

### Anti-Bias Techniques
- **Structured questions:** Every candidate for the same role gets the same core questions in the same order
- **Independent scoring:** Interviewers submit scores before the debrief meeting — no anchoring on a senior person's opinion
- **Blind resume review:** Strip names, photos, school names, and company names in the initial screen where possible
- **Diverse interview panels:** Include at least one interviewer from an underrepresented background when possible
- **Language check:** Before writing feedback, ask "Would I say this about a different candidate?" to catch biased framing
- **Replace "culture fit"** with "values alignment" and require specific behavioral evidence

### Take-Home Assignment Guidelines
- **Time-capped:** 2-4 hours maximum. State this explicitly and mean it.
- **Mirrors real work:** The exercise should resemble an actual task the person would do in the role
- **Transparent criteria:** Share the rubric with the candidate upfront so they know what you value
- **Equitable access:** Offer a paid alternative if the candidate cannot invest unpaid time
- **Debrief required:** Always follow up with a live walkthrough where the candidate explains their choices

### Common Pitfalls
- Overweighting one round while ignoring other competency signals
- Using unstructured interviews without standardized scoring
- Skipping calibration sessions for interviewers
- Changing the hiring bar without documenting rationale
- Letting round objectives overlap so multiple stages test the same thing

### Compensation Benchmarking Framework
Use three inputs to triangulate:
1. **Market data:** Levels.fyi, Pave, Carta Total Comp, Glassdoor as directional
2. **Stage multiplier:** Seed pays 70-85% of big-co base with 0.5-2% equity; Series A narrows to 80-95%
3. **Candidate calibration:** Adjust for experience, competing offers, and location within the level band

Always present comp as a range with a target midpoint, not a single number.

## Related Skills
- `job-description` — Use the JD's competency requirements as input for the interview loop
- `sourcing-outreach` — Align outreach messaging with the interview process so candidates know what to expect

## Examples

**Prompt:** "Design an interview loop for a senior backend engineer. 15-person startup."

**Good output snippet:**
```
## Interview Loop — Senior Backend Engineer

### Competencies to Evaluate
1. System design & architecture (technical depth)
2. Code quality & testing practices (craft)
3. Debugging & production thinking (operational maturity)
4. Technical communication (collaboration)
5. Ownership & initiative (startup fit)

### Stage 1: Founder Screen (30 min)
- Evaluate: Motivation, communication, logistics
- Questions:
  - "What's drawing you to an early-stage company right now?"
  - "Walk me through the most impactful project you led in the last year."
- Scorecard: 1-4 on communication, motivation, startup-fit

### Stage 2: Technical Deep-Dive (60 min)
- Evaluate: System design, code quality
- Format: Live system design discussion + code review exercise
- Scorecard: 1-4 on architecture thinking, code craft, trade-off reasoning
```

**Prompt:** "Our interviewers keep disagreeing on candidates."

**Good output snippet:**
```
This usually means you lack structured evaluation criteria. Three-step fix:

1. Define 4-5 competencies per role with written behavioral descriptions
2. Give each interviewer a scorecard to fill out independently BEFORE debrief
3. In the debrief, discuss only scores that diverge by 2+ points —
   focus on evidence, not impressions

The goal is calibrated, evidence-based evaluation — not consensus.
```
