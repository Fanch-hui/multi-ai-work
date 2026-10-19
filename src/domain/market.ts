import type { ApprovalMode, Bot, QoderService } from './types.js';

export interface Profession {
  id: string;
  name: string;
}
export const professions: Profession[] = [
  { id: 'legal', name: '律师／法务' },
  { id: 'content', name: '自媒体／内容创作' },
  { id: 'marketing', name: '市场／品牌营销' },
  { id: 'product', name: '产品经理' },
  { id: 'consulting', name: '咨询／商业分析' },
  { id: 'commerce', name: '电商／商品运营' },
  { id: 'sales', name: '销售／商务／外贸' },
  { id: 'hr', name: 'HR／招聘' },
  { id: 'education', name: '教师／培训讲师' },
  { id: 'research', name: '科研／学术研究' },
  { id: 'design', name: '设计师' },
  { id: 'finance', name: '财务／经营分析' },
  { id: 'student', name: '大学生' },
  { id: 'author', name: '作者／文学创作' },
  { id: 'construction', name: '建筑／工程项目' },
  { id: 'administration', name: '行政／综合事务' },
  { id: 'procurement', name: '采购／供应链' },
  { id: 'customer_service', name: '客户服务／客户成功' },
  { id: 'project_management', name: '项目管理／项目交付' },
  { id: 'software', name: '软件开发／测试' },
  { id: 'data_analysis', name: '数据分析／BI' },
  { id: 'translation', name: '翻译／本地化' },
  { id: 'manufacturing', name: '制造／质量管理' },
  { id: 'logistics', name: '物流／仓储' },
];
export interface SkillSource {
  repository: string;
  commit: string;
  path: string;
  license: string;
  stars?: number;
  verifiedAt?: string;
}
export interface PresetSkill {
  key: string;
  name: string;
  description: string;
  directory: string;
  digest: string;
  source?: SkillSource;
}
export interface PresetDependency {
  kind: 'tool' | 'connection' | 'runtime';
  key: string;
  label: string;
  required: boolean;
}
export interface AgentPreset {
  id: string;
  version: string;
  name: string;
  role: string;
  description: string;
  professions: string[];
  group?: string;
  rank: number;
  instructions: string;
  examples: string[];
  outputs: string[];
  skills: PresetSkill[];
  dependencies: PresetDependency[];
  platforms: ('darwin' | 'win32' | 'linux')[];
  license: string;
  releaseNotes: string;
  download?: { url: string; sha256: string; bytes: number };
}
export interface PresetCatalog {
  formatVersion: 1;
  presets: AgentPreset[];
}
export interface PresetInstallation {
  id: string;
  preset: AgentPreset;
  source: 'official' | 'local';
  status: 'downloading' | 'installed' | 'failed' | 'cancelled' | 'missing';
  progress: number;
  error?: string;
  directory?: string;
  skillIds: string[];
  digest?: string;
  createdAt: string;
}
export interface BotPresetBinding {
  installationId: string;
  presetId: string;
  version: string;
  source: 'official' | 'local';
  baseInstructions: string;
  managedSkillIds: string[];
}
export interface CareerPreferences {
  professionIds: string[];
  status: 'pending' | 'completed' | 'skipped';
}
export interface MarketState {
  professions: Profession[];
  presets: AgentPreset[];
  installations: PresetInstallation[];
  preferences: CareerPreferences;
  catalogConfigured: boolean;
  refreshedAt?: string;
}
export interface PresetMemberConfiguration {
  name?: string;
  role?: string;
  avatar?: string;
  color?: string;
  connectionId: string;
  model: string;
  reasoning?: string;
  contextWindow?: number;
  compactionThreshold?: number;
  memoryMode?: Bot['memoryMode'];
  skillIds?: string[];
  toolNames: string[];
  approvalMode: ApprovalMode;
  toolConnectionIds: string[];
  qoderServices?: QoderService[];
  personalInstructions?: string;
}
export interface PresetMemberRequest {
  requestId: string;
  installationId: string;
  configuration: PresetMemberConfiguration;
}
export interface PresetMemberResult {
  requestId: string;
  botId?: string;
  error?: string;
}
