---
name: business-porters-five-forces
description: "Perform Porter's Five Forces analysis — competitive rivalry, supplier power, buyer power, threat of substitutes, and threat of new entrants. Use when analyzing industry dynamics, assessing competitive forces, or evaluating market attractiveness."
---

## App 执行约定

先读取本技能正文及任务所需的本地参考资源。使用中文；工作目录由任务提供，仅读取用户提供、当前任务授权的资料。正文中的 `$ARGUMENTS` 及斜杠命令表示用户任务输入，不调用 Claude 专用命令。`AskUserQuestion`/提问通过 App `ask_user`；本地文件通过 `read_file`，成果使用 `write_file` 后 `register_artifact`，或 `write_artifact`。相对资源路径以本 SKILL.md 所在目录为起点。若技能读取结果含目录，按该目录构建资源绝对路径。

正文中 Search/WebFetch、Figma、CRM、广告平台及其它连接名称仅为可选来源；只使用 App 实际提供且已授权的工具。没有连接时从上传材料完成流程，把缺少的外部验证列出，不安装运行时插件或扫描用户全局配置。默认输出 Markdown/CSV 草稿；Office、图表、HTML、PNG 或图像生成只在对应工具和运行库可用时执行。不得擅自发送邮件、发表内容、签约、创建发票、修改线上商品或花费广告预算。

# Porter's Five Forces

## Metadata
- **Name**: porters-five-forces
- **Description**: Perform a Porter's Five Forces analysis evaluating competitive rivalry, supplier power, buyer power, threat of substitutes, and threat of new entrants.
- **Triggers**: Porter's five forces, competitive forces, industry analysis, market forces, competitive dynamics

## Instructions

You are a competitive strategist conducting a Porter's Five Forces analysis for $ARGUMENTS.

Your task is to evaluate the structural attractiveness of an industry and identify the competitive dynamics that will determine profitability.

## Input Requirements
- Industry or market definition
- Current competitors and competitive positioning
- Supplier and customer landscape
- Potential substitutes and new entrants
- Product or service specifics

## Porter's Five Forces Framework

### 1. Competitive Rivalry (How intense is competition?)
The degree to which companies compete directly for market share and customers.

**High Rivalry When:**
- Many competitors of similar size and strength
- Slow industry growth (zero-sum competition)
- Low product differentiation (commoditized)
- High fixed costs (pressure to maintain volume)
- Exit barriers are high (expensive to leave)
- Price competition is intense
- Rivals have diverse strategies and goals
- Emotional or strategic commitments keep rivals fighting

**Low Rivalry When:**
- Few competitors
- High growth market
- High differentiation (less price-sensitive)
- Low fixed costs
- Low switching costs for competitors
- Industry leader has clear dominance
- Rivals are cooperative or have compatible goals

**Strategic Implications:**
- Assess competitive positioning and differentiation
- Define defensible competitive advantages
- Monitor competitor moves and market consolidation
- Invest in differentiation or cost leadership

---

### 2. Supplier Power (How much power do suppliers have?)
The ability of suppliers to increase prices or reduce quality, affecting your profitability.

**High Supplier Power When:**
- Few suppliers or concentrated supplier base
- Switching costs are high (changing suppliers is expensive)
- Backward integration threat (suppliers become competitors)
- Suppliers' product is critical or unique
- Suppliers have strong bargaining position
- No substitutes for supplier offerings
- Suppliers sell to many industries (less dependent on you)

**Low Supplier Power When:**
- Many suppliers available
- Low switching costs
- Suppliers depend on your business
- Commodity products (interchangeable suppliers)
- Threat of forward integration (you become your own supplier)
- Available substitutes for supplier offerings
- You have significant bargaining leverage

**Strategic Implications:**
- Diversify supplier base to reduce dependency
- Build strong supplier relationships
- Consider vertical integration or alternatives
- Negotiate long-term contracts with favorable terms
- Invest in suppliers' success (partnerships)

---

### 3. Buyer Power (How much power do customers have?)
The ability of customers to negotiate lower prices or demand higher quality, affecting your margin.

**High Buyer Power When:**
- Few large customers (concentrated demand)
- Buyers switch easily and often (low switching costs)
- Backwards integration threat (customers become competitors)
- Product is undifferentiated (commoditized)
- Buyers have price sensitivity or tight budgets
- Buyers have full information about alternatives
- Customers can bypass you entirely

**Low Buyer Power When:**
- Many fragmented customers
- High switching costs (lock-in, integration, training)
- High product differentiation (fewer alternatives)
- Customers depend on your product
- You have strong brand or reputation
- Switching to alternatives involves risk
- Customers lack information about alternatives

**Strategic Implications:**
- Build strong customer relationships and loyalty
- Create switching costs through integration
- Invest in brand and differentiation
- Develop customer success programs
- Create network effects or communities
- Segment customers by willingness to pay

---

### 4. Threat of Substitutes (Are there alternative solutions?)
The risk that customers will switch to alternative products that solve the same problem.

**High Threat When:**
- Good substitutes exist and are easily accessible
- Substitutes have similar performance or better value
- Switching costs to substitutes are low
- Customers are willing to try alternatives
- Substitutes are improving faster than your product
- Price-to-performance of substitutes is attractive
- Substitute technology is disruptive or emerging

**Low Threat When:**
- No good substitutes exist
- Substitutes are more expensive or inferior
- Switching costs are high
- Your product is deeply integrated into customer workflows
- Customer preference and loyalty are strong
- Barrier to substitute entry are high
- Your product solves the problem uniquely

**Strategic Implications:**
- Monitor emerging substitutes and disruptive technologies
- Build customer stickiness through integration and loyalty
- Invest in product innovation and improvement
- Create switching costs through ecosystem or community
- Diversify into adjacent or complementary products
- Defend through brand, service, or convenience

---

### 5. Threat of New Entrants (Can new competitors easily enter?)
The risk that new competitors will enter the market and capture share.

**High Threat When:**
- Low barriers to entry (capital, expertise, licensing)
- Attractive industry margins and growth
- Incumbents are vulnerable or complacent
- Distribution or channel access is available
- Economies of scale are limited
- Network effects are weak or absent
- Regulation is permissive
- New technologies enable disruption

**Low Threat When:**
- High barriers to entry (capital, IP, expertise, relationships)
- Entrenched incumbents with scale advantages
- Strong network effects or switching costs
- Brand loyalty is high
- Regulatory or licensing barriers exist
- Economies of scale create cost advantage
- Control of critical resources or distribution
- Retaliation by incumbents is credible

**Strategic Implications:**
- Build defensible barriers (IP, brand, network effects)
- Establish cost leadership and scale advantages
- Create switching costs and customer lock-in
- Invest in brand and customer relationships
- Monitor startups and disruptors in your space
- Build alliances and control key resources

---

## Output Process
1. Assess each of the five forces (High, Medium, Low)
2. Rate industry attractiveness (High rivalry + strong forces = less attractive)
3. For each force, identify:
   - Current state and trend (getting stronger/weaker)
   - Key players or dynamics
   - Implications for profitability
4. Prioritize the 2-3 forces most critical to your strategy
5. Develop strategic responses:
   - How can we reduce threat of high-power forces?
   - How can we leverage weak forces for advantage?
6. Identify competitive positioning opportunities
7. Create strategic initiatives aligned with force analysis

## Industry Attractiveness
- **Attractive**: Low rivalry, weak supplier/buyer power, few substitutes, high entry barriers
- **Unattractive**: High rivalry, strong supplier/buyer power, many substitutes, low entry barriers
- **Moderate**: Mixed dynamics requiring strategic differentiation

## Notes
- No industry is universally attractive or unattractive; position matters
- Same industry can be attractive for some companies, unattractive for others
- Forces change over time; re-assess as market evolves
- Use Porter's Five Forces with SWOT and PESTLE for comprehensive analysis
- Strategy should directly address the highest-force threats

---

### Further Reading

- [The Product Management Frameworks Compendium + Templates](https://www.productcompass.pm/p/the-product-frameworks-compendium)
