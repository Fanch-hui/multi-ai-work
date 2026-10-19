import type { TaskStatus } from './types.js';
import { z } from 'zod';

export type PlanStepStatus = TaskStatus | 'pending' | 'skipped';
export interface PlanStepInput {
  id: string;
  title: string;
  description?: string;
  kind: 'work' | 'discussion';
  memberIds: string[];
  dependencyIds: string[];
}
export interface TaskPlanInput {
  title: string;
  steps: PlanStepInput[];
}
export interface PlanStepUpdate {
  stepId: string;
  status?: 'running' | 'completed' | 'skipped';
  note?: string;
}
export interface PlanStep extends PlanStepInput {
  status: PlanStepStatus;
  taskIds: string[];
  conversationIds: string[];
  note?: string;
}
export interface TaskPlan {
  id: string;
  taskId: string;
  conversationId: string;
  title: string;
  steps: PlanStep[];
  createdAt: string;
  updatedAt: string;
}
export interface TaskPlanRecord extends Omit<TaskPlan, 'steps'> {
  steps: (PlanStepInput & {
    chiefStatus?: 'pending' | 'running' | 'completed' | 'skipped';
    note?: string;
  })[];
}

export const taskPlanSchema = z
  .object({
    title: z.string().trim().min(1).max(160),
    steps: z
      .array(
        z
          .object({
            id: z.string().trim().min(1).max(80),
            title: z.string().trim().min(1).max(160),
            description: z.string().trim().max(2000).optional(),
            kind: z.enum(['work', 'discussion']),
            memberIds: z.array(z.string().min(1)).min(1).max(50),
            dependencyIds: z.array(z.string().min(1)).max(30).default([]),
          })
          .strict(),
      )
      .min(1)
      .max(30),
  })
  .strict();
export const planStepUpdateSchema = z
  .object({
    stepId: z.string().min(1).max(80),
    status: z.enum(['running', 'completed', 'skipped']).optional(),
    note: z.string().trim().max(2000).optional(),
  })
  .strict()
  .refine(
    (input) => input.status !== undefined || input.note !== undefined,
    '请提供进展状态或说明',
  );
