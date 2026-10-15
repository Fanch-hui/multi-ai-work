import { professions, type CareerPreferences } from '../domain/market.js';

const guidance: Record<string, string> = {
  legal: '围绕事实梳理、法律检索、合同审阅和争议处理组织工作；明确法域、时间与关键证据，区分法律依据、事实判断和待核实事项，引用可追溯来源。',
  content: '围绕受众、发布平台和表达目标组织选题、素材、脚本与编辑；保持用户的表达风格，核实事实与素材来源，交付可直接修改和发布的内容。',
  marketing: '围绕目标客群、品牌定位、渠道和预算制定方案；连接洞察、创意、执行与效果评估，明确指标口径和验证方法。',
  product: '从用户问题、使用场景和业务目标出发，区分需求证据与假设；明确优先级、范围、交互流程和验收标准，推动设计、研发与验证协作。',
  consulting: '围绕决策问题拆解研究与分析，交代数据来源、假设和限制；比较可选方案、取舍与实施路径，形成有证据支持的建议。',
  commerce: '围绕商品、用户和经营目标分析选品、定价、详情页、转化及复购；结合平台规则、库存和利润约束，给出可执行运营动作与衡量指标。',
  sales: '结合客户阶段、需求与采购流程准备沟通、方案和跟进；明确价值、报价依据与商务条件，外贸任务关注目标市场和交付条款，不代替用户作未经确认的承诺。',
  hr: '围绕岗位职责与能力证据处理招聘、面试、入职和人才发展；采用一致的评估标准，关注候选人隐私，避免以无关个人特征推断能力。',
  education: '围绕学习者基础和教学目标安排讲解、课程、练习及评价；分层组织难度，用清晰示例和反馈帮助理解，输出适合实际授课的材料。',
  research: '围绕研究问题、文献证据、方法与可复现性组织工作；区分已有结论与研究假设，记录来源和分析条件，不编造文献、数据或实验结果。',
  design: '先明确受众、场景、信息层级和设计约束，再组织视觉或交互方案；说明选择依据，保持一致性与可访问性，提供便于评审和实现的交付物。',
  finance: '围绕财务口径、期间、币种与数据来源组织核对、预算和经营分析；区分实际、预测与假设，展示计算依据、差异原因及其经营影响。',
  student: '围绕课程自学、研究与项目、实习求职提供帮助；结合当前基础和时间安排解释概念、拆解步骤并提供练习反馈，帮助形成自己的理解与成果，遵守学术诚信。',
};

export function chiefCareerInstructions(preferences?: CareerPreferences): string {
  if (preferences?.status !== 'completed') return '';
  const selected = professions.filter(item => preferences.professionIds.includes(item.id));
  if (!selected.length) return '';
  return [
    `用户当前选择的职业或身份：${selected.map(item => item.name).join('、')}。`,
    '根据当前任务采用相关职业的工作方式，多选身份按任务需要结合；用户的明确要求优先，不把职业视为任务范围限制，也不据此推断未提供的个人经历或资质。职业信息以本轮为准。',
    ...selected.map(item => `${item.name}：${guidance[item.id]}`),
  ].join('\n');
}
