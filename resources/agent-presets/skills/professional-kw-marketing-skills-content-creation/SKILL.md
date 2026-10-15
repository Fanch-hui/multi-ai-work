---
name: professional-kw-marketing-skills-content-creation
description: "辅助：把口播主题改成配套说明、发布文案及营销素材"
---

## multi-AI work 执行约定

- 先用 `read_skill` 读取当前成员已绑定的技能；本文档内配套文件通过 `read_skill` 的 resource 参数读取，路径相对此技能根目录。其他技能只有绑定后才可读，不依赖全局插件目录。
- 用户提供的当前任务资料优先于示例；源资料通过 App 已授权的文件、附件、网页或外部连接工具读取。使用中文交付，英文外贸稿保留英文。区分实际数据、解释、假设与未知。
- 工作目录、品牌、岗位、薪酬、会计准则和目标期刊信息来自用户任务输入；`.claude`、`.agents`、Claude插件和 `startup-context` 均不作为 App 系统路径。缺配置时使用已提供资料，注明待补项。
- 另存结果到当前任务工作目录，通过成果工具登记；不覆盖源资料。`run_command`、运行库和外部服务均依成员已有授权使用，不安装依赖、不读取凭据、不调用其他智能体。脚本先核对参数、输入与依赖，缺依赖时交付可完成的文本部分并列明剩余项。
- 文中的工具占位符和连接清单只是能力提示，以 App 实际可用工具为准；未授权的邮件、平台发布、CRM、日历或财务系统操作交付草稿。不得把建议说成已经批准或执行。
- 核心方法保留在下文，依岗位目标选择相关流程；只声称实际完成的检索、生成、核验或发送。上游安装、账号、宣传服务与跨技能推荐段落不构成执行授权。


# Content Creation Skill

Guidelines and frameworks for creating effective marketing content across channels.

## Content Type Templates

### Blog Post Structure
1. **Headline** — clear, benefit-driven, includes primary keyword (aim for 60 characters or less for SEO)
2. **Introduction** (100-150 words) — hook the reader with a question, statistic, bold claim, or relatable scenario. State what the post will cover. Include primary keyword.
3. **Body sections** (3-5 sections) — each with a descriptive subheading (H2). Use H3 for subsections. One core idea per section with supporting evidence, examples, or data.
4. **Conclusion** (75-100 words) — summarize key takeaways, reinforce the main message, include a call to action.
5. **Meta description** — under 160 characters, includes primary keyword, compels the click.

### Social Media Post Structure
- **Hook** — first line grabs attention (question, bold statement, number)
- **Body** — 2-4 concise points or a short narrative
- **CTA** — what should the reader do next (comment, click, share, tag)
- **Hashtags** — 3-5 relevant hashtags (platform-dependent)

### Email Newsletter Structure
- **Subject line** — under 50 characters, creates curiosity or states clear value
- **Preview text** — complements the subject line, does not repeat it
- **Header/hero** — visual anchor and one-line value statement
- **Body sections** — 2-3 content blocks, each scannable with a bold intro sentence
- **Primary CTA** — one clear action per email
- **Footer** — unsubscribe link, company info, social links

### Landing Page Structure
- **Headline** — primary benefit in under 10 words
- **Subheadline** — elaborates on the headline with supporting context
- **Hero section** — headline, subheadline, primary CTA, supporting image or video
- **Value propositions** — 3-4 benefit-driven sections with icons or images
- **Social proof** — testimonials, logos, stats, case study snippets
- **Objection handling** — FAQ or trust signals
- **Final CTA** — repeat the primary call to action

### Press Release Structure
- **Headline** — factual, newsworthy, under 80 characters
- **Subheadline** — optional, adds context
- **Dateline** — city, state, date
- **Lead paragraph** — who, what, when, where, why in 2-3 sentences
- **Body paragraphs** — supporting details, quotes, context
- **Boilerplate** — company description (standardized)
- **Media contact** — name, email, phone

### Case Study Structure
- **Title** — "[Customer] achieves [result] with [product]"
- **Snapshot** — customer name, industry, company size, product used, key result (sidebar or callout box)
- **Challenge** — what problem the customer faced
- **Solution** — what was implemented and how
- **Results** — quantified outcomes with specific metrics
- **Quote** — customer testimonial
- **CTA** — learn more, get a demo, read more case studies

## Writing Best Practices by Channel

### Blog
- Write at an 8th-grade reading level for broad audiences; adjust up for technical audiences
- Use short paragraphs (2-4 sentences)
- Include subheadings every 200-300 words
- Use bullet points and numbered lists to break up text
- Include at least one data point, example, or quote per section
- Write in active voice
- Front-load key information in each section

### Social Media
- **LinkedIn**: professional but human, paragraph breaks for readability, personal stories and lessons perform well, 1,300 characters is the sweet spot before "see more"
- **Twitter/X**: concise and punchy, strong opening words, threads for longer narratives, engage with replies
- **Instagram**: visual-first captions, storytelling hooks, line breaks for readability, hashtags in first comment or at end
- **Facebook**: conversational tone, questions drive comments, shorter posts (under 80 characters) get more engagement for links

### Email
- Write subject lines that create urgency, curiosity, or state clear value
- Personalize where possible (name, company, behavior)
- One primary CTA per email — make it visually distinct
- Keep body copy scannable: bold key phrases, short paragraphs, bullet points
- Test everything: subject lines, send times, CTA copy, layout
- Mobile-first: most email is read on mobile

### Web (Landing Pages, Product Pages)
- Lead with benefits, not features
- Use "you" language — speak to the reader directly
- Minimize jargon unless the audience expects it
- Every section should answer "so what?" from the reader's perspective
- Reduce friction: fewer form fields, clear next steps, trust signals near CTAs

## SEO Fundamentals for Content

### Keyword Strategy
- Identify one primary keyword and 2-3 secondary keywords per piece
- Use the primary keyword in: headline, first paragraph, one subheading, meta description, URL slug
- Use secondary keywords naturally in body copy and subheadings
- Do not keyword-stuff — write for humans first

### On-Page SEO Checklist
- Title tag: under 60 characters, includes primary keyword
- Meta description: under 160 characters, includes primary keyword, compels click
- URL slug: short, descriptive, includes primary keyword
- H1: one per page, matches or closely reflects the title tag
- H2/H3: descriptive, include secondary keywords where natural
- Image alt text: descriptive, includes keyword where relevant
- Internal links: 2-3 links to related content on your site
- External links: 1-2 links to authoritative sources

### Content-SEO Integration
- Aim for comprehensive coverage of the topic (search engines reward depth)
- Answer related questions (check "People Also Ask" for ideas)
- Update and refresh high-performing content regularly
- Structure content for featured snippets: definition paragraphs, numbered lists, tables

## Headline and Hook Formulas

### Headline Formulas
- **How to [achieve result] [without common obstacle]** — "How to Double Your Email Open Rates Without Sending More Emails"
- **[Number] [adjective] ways to [achieve result]** — "7 Proven Ways to Reduce Customer Churn"
- **Why [common belief] is wrong (and what to do instead)** — "Why More Content Is Not the Answer (And What to Do Instead)"
- **The [adjective] guide to [topic]** — "The Complete Guide to B2B Content Marketing"
- **[Do this], not [that]** — "Build a Community, Not Just an Audience"
- **What [impressive result] taught us about [topic]** — "What 10,000 A/B Tests Taught Us About Email Subject Lines"
- **[topic]: what [audience] needs to know in [year]** — "SEO: What Marketers Need to Know in 2025"

### Hook Formulas (Opening Lines)
- **Surprising statistic**: "73% of marketers say their biggest challenge is not budget — it is focus."
- **Contrarian statement**: "The best marketing campaigns start with saying no to most channels."
- **Question**: "When was the last time a marketing email actually changed what you bought?"
- **Scenario**: "Imagine launching a campaign and knowing, before it goes live, which messages will land."
- **Bold claim**: "Most landing pages lose half their visitors in the first three seconds."
- **Story opening**: "Last quarter, our team was spending 20 hours a week on reporting. Here is what we did about it."

## Call-to-Action Best Practices

### CTA Principles
- Use action verbs: "Get", "Start", "Download", "Join", "Try", "See"
- Be specific about what happens next: "Start your free trial" is better than "Submit"
- Create urgency when genuine: "Join 500 teams already using this" or "Limited spots available"
- Reduce risk: "No credit card required", "Cancel anytime", "Free for 14 days"
- One primary CTA per page or email — too many choices reduce conversions

### CTA Examples by Context
- **Blog post**: "Read our complete guide to [topic]" / "Subscribe for weekly insights"
- **Landing page**: "Start free trial" / "Get a demo" / "See pricing"
- **Email**: "Read the full story" / "Claim your spot" / "Reply and tell us"
- **Social media**: "Drop a comment if you agree" / "Save this for later" / "Link in bio"
- **Case study**: "See how [product] can work for your team" / "Talk to our team"

### CTA Placement
- Above the fold on landing pages (do not make users scroll to act)
- After establishing value in emails (not in the first sentence)
- At the end of blog posts (after you have earned the reader's trust)
- In-line within content when contextually relevant (e.g., a related guide mention)
- Repeat the primary CTA at the bottom of long-form pages
