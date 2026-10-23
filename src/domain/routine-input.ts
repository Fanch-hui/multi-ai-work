import { z } from 'zod';

const scheduleSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('once'), at: z.iso.datetime({ offset: true }) }).strict(),
  z.object({ kind: z.literal('daily'), time: z.string() }).strict(),
  z
    .object({
      kind: z.literal('weekly'),
      time: z.string(),
      weekdays: z.array(z.number().int().min(0).max(6)).min(1).max(7),
    })
    .strict(),
]);

export const routineInputSchema = z
  .object({
    id: z.string().optional(),
    name: z.string().trim().min(1).max(120),
    botId: z.string().min(1),
    workspaceId: z.string().min(1),
    goal: z.string().trim().min(1).max(120000),
    expectedOutput: z.string().max(120000).default(''),
    inputArtifactIds: z.array(z.string()).max(50).default([]),
    schedule: scheduleSchema,
    timeZone: z.string().min(1),
    missedRunPolicy: z.enum(['latest', 'skip']).default('latest'),
    enabled: z.boolean().default(true),
  })
  .strict();
