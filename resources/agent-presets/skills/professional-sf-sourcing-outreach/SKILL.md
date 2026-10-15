---
name: professional-sf-sourcing-outreach
description: "直接适用：个性化招聘邀约和跟进文案"
---

## multi-AI work 执行约定

- 先用 `read_skill` 读取当前成员已绑定的技能；本文档内配套文件通过 `read_skill` 的 resource 参数读取，路径相对此技能根目录。其他技能只有绑定后才可读，不依赖全局插件目录。
- 用户提供的当前任务资料优先于示例；源资料通过 App 已授权的文件、附件、网页或外部连接工具读取。使用中文交付，英文外贸稿保留英文。区分实际数据、解释、假设与未知。
- 工作目录、品牌、岗位、薪酬、会计准则和目标期刊信息来自用户任务输入；`.claude`、`.agents`、Claude插件和 `startup-context` 均不作为 App 系统路径。缺配置时使用已提供资料，注明待补项。
- 另存结果到当前任务工作目录，通过成果工具登记；不覆盖源资料。`run_command`、运行库和外部服务均依成员已有授权使用，不安装依赖、不读取凭据、不调用其他智能体。脚本先核对参数、输入与依赖，缺依赖时交付可完成的文本部分并列明剩余项。
- 文中的工具占位符和连接清单只是能力提示，以 App 实际可用工具为准；未授权的邮件、平台发布、CRM、日历或财务系统操作交付草稿。不得把建议说成已经批准或执行。
- 核心方法保留在下文，依岗位目标选择相关流程；只声称实际完成的检索、生成、核验或发送。上游安装、账号、宣传服务与跨技能推荐段落不构成执行授权。


# Sourcing Outreach

## When to Use
Activate when the user asks to write cold outreach to potential candidates (LinkedIn InMails, cold emails), craft referral request messages, build a multi-touch follow-up sequence, or improve response rates on existing recruiting outreach. Also activate when the user is sourcing for a specific role and needs help personalizing messages at scale.

## Context Required
- **From startup-context:** Company name, one-line mission, stage/funding, notable investors or customers, recent milestones, and team size.
- **From user:** Role being hired for, the candidate's name and background (LinkedIn profile, blog posts, talks, open-source work), what specifically drew the user to this candidate, and the communication channel (LinkedIn, email, Twitter DM).

## Workflow
1. **Research the candidate** — Review the candidate details provided by the user. Identify 1-2 specific, genuine connection points: a project they shipped, a talk they gave, an open-source contribution, a blog post, or a career pattern that signals fit.
2. **Choose the outreach template** — Select from: cold LinkedIn InMail, cold email, warm intro request, referral ask, or follow-up. Each has different length and tone constraints.
3. **Draft the message** — Write a short, personalized message using the PRC framework (see below). Keep LinkedIn InMails under 300 characters for the preview. Keep cold emails under 150 words.
4. **Add a clear, low-friction CTA** — The ask should be small: a 15-minute call, a reply with interest level, or permission to send more details. Never ask for a resume or formal application in cold outreach.
5. **Build the follow-up sequence** — Draft 2-3 follow-ups spaced 4-7 days apart. Each follow-up adds new information (a company milestone, a team blog post, a relevant data point) rather than just "bumping" the thread.
6. **Review for tone** — Ensure the message sounds human, not templated. Check that personalization is specific enough that it could only apply to this candidate.

## Output Format
- A primary outreach message (ready to send)
- 2-3 follow-up messages with suggested send timing
- Notes on personalization elements used and why they were chosen

## Frameworks & Best Practices

### The PRC Framework
Every outreach message should contain three elements in roughly this order:
- **Personalization (P):** A specific, genuine observation about the candidate's work that shows you did your homework. Not "I saw your impressive profile" — something like "Your talk on event sourcing at StrangeLoop changed how I think about our own data pipeline."
- **Relevance (R):** Why this role connects to their career trajectory. Bridge from what they've done to what they'd do at your company.
- **Call-to-action (C):** A single, low-commitment ask. "Would you be open to a 15-minute call this week?" is better than "Apply at our careers page."

### Channel-Specific Guidelines

**LinkedIn InMail:**
- Subject line matters more than body — keep it intriguing and specific (e.g., "Your Kafka work + our real-time pipeline" not "Exciting opportunity").
- InMail preview shows ~300 characters. Front-load the personalization.
- Do not connect-and-pitch simultaneously. Either send an InMail or send a connection request with a note — not both at once.

**Cold Email:**
- Subject: Short, specific, no clickbait. "Quick question about [their project]" or "[Mutual connection] suggested I reach out."
- Keep body under 150 words. Three short paragraphs max.
- Plain text outperforms HTML templates. No logos, no signatures with 10 links.
- Send from a real person's email (founder@, not recruiting@).

**Warm Intro / Referral Request:**
- Make it easy for the connector: provide a forwardable blurb they can send with zero editing.
- Include context on why you think the candidate is a fit so the connector can vouch meaningfully.
- Always give the connector an out: "No pressure at all if this doesn't feel right."

### Personalization Research Checklist
Before writing, look for:
- [ ] Recent talks, podcast appearances, or conference presentations
- [ ] Blog posts or technical writing
- [ ] Open-source contributions (GitHub, GitLab)
- [ ] Career trajectory patterns (e.g., "you've gone deep on infrastructure at two companies in a row")
- [ ] Mutual connections or shared communities
- [ ] Company or product they built that you genuinely admire

### Follow-Up Sequence Design
- **Follow-up 1 (Day 4-5):** Add a new piece of information — a recent company milestone, a blog post from the team, or a specific project they'd work on. Keep it to 2-3 sentences.
- **Follow-up 2 (Day 9-11):** Try a different angle. If the first message was about the role, this one could be about the team or a technical challenge. Ask a question rather than making a pitch.
- **Follow-up 3 (Day 16-20):** A graceful close. "I don't want to crowd your inbox — just wanted to leave the door open. If timing is ever better, I'd love to chat." This gets surprisingly high response rates.
- **Never send more than 3 follow-ups** to a candidate who hasn't responded.

### Anti-Patterns to Avoid
- **Spray and pray:** Sending identical messages to 200 people. Response rates plummet below 5%. Batch personalization into tiers instead.
- **The humble brag opener:** "We just raised $50M from Sequoia" as your first sentence. Lead with the candidate, not yourself.
- **Fake personalization:** "I was really impressed by your background" is worse than no personalization because it signals a template.
- **Overselling:** Don't describe the role as "once in a lifetime." Be honest and specific about what makes it compelling.
- **Asking for too much:** "Please send your resume and three references" in a cold message guarantees no reply.

## Related Skills
- `job-description` — The JD provides the source material for what makes the role compelling in outreach.
- `interview-kit` — Mention the candidate-friendly interview process in outreach to reduce friction.

## Examples

**Prompt:** "Write a cold LinkedIn InMail for a senior ML engineer. She gave a talk at NeurIPS on efficient fine-tuning and currently works at Stripe."

**Good output snippet:**
```
Subject: Your NeurIPS talk on efficient fine-tuning

Hi [Name],

Your NeurIPS presentation on LoRA variants for production models stuck
with me — especially the bit about keeping inference costs flat while
scaling model complexity. We're solving a similar problem at [Company]:
building real-time ML models for [use case] and need someone who thinks
about efficiency as a first-class constraint.

We're 18 people, Series A, and this would be our second ML hire. You'd
own the model architecture end to end.

Would you be open to a 15-minute call to see if there's a fit?

— [Your name]
```

**Prompt:** "Write a referral request email I can send to a mutual connection."

**Good output snippet:**
```
Subject: Quick ask — know anyone strong in product design?

Hi [Connector],

We're hiring our first product designer at [Company] and I thought of
you since you work with strong designers regularly. Here's what we're
looking for: [1-2 sentences on the role].

If anyone comes to mind, I'd be grateful for an intro. Here's a
forwardable blurb:

---
"[Your name] is the CEO of [Company] ([one-liner]). They're hiring a
founding product designer to own the end-to-end user experience. The
team is 14 people, Series A, remote-first. Here's the JD: [link]"
---

No pressure at all — and thanks either way.

[Your name]
```
