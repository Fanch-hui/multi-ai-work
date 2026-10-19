import { z } from 'zod';
import type { ToolExecutionContext } from '../domain/tools.js';

export function createSecurityScanTools() {
  return {
    scan_code_security: {
      description:
        '调用获准的 Qoder 原生安全扫描服务检查明确指定的工作目录文件或代码目录。按成员执行方式审批，提交至官方扫描服务并可能消耗积分。排除凭据、构建及依赖文件，报告登记为当前任务最终成果。',
      schema: z.object({
        paths: z.array(z.string().min(1).max(8000)).min(1).max(20),
        timeoutMs: z.number().int().min(1000).max(1800000).optional(),
      }),
      available: (context: ToolExecutionContext) => !!context.scanCodeSecurity,
      execute: (args: { paths: string[]; timeoutMs?: number }, context: ToolExecutionContext) =>
        context.scanCodeSecurity!(args),
    },
  };
}
