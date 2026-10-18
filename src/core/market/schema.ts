import { z } from 'zod';
import { professions } from '../../domain/market.js';

const text = z.string().trim().min(1).max(128_000);
export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const identifier = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,119}$/);
export const resourcePathSchema = z.string().min(1).max(500).refine(value =>
  !value.includes('\\') && !value.includes(':') && !value.includes('\0')
  && value.split('/').every(part => part !== '' && part !== '.' && part !== '..'), '资源路径必须位于包内');
const sourceSchema = z.object({
  repository: z.string().url().refine(value => { const url = new URL(value); return url.protocol === 'https:' && !url.username && !url.password; }),
  commit: z.string().regex(/^[a-f0-9]{40}$/),
  path: resourcePathSchema, license: text, stars: z.number().int().nonnegative().optional(),
  verifiedAt: z.string().datetime().optional(),
}).strict();
export const presetSchema = z.object({
  id: identifier, version: identifier, name: text.max(120), role: text.max(200), description: text,
  professions: z.array(z.string().refine(value => professions.some(item => item.id === value))).min(1).max(professions.length),
  group: text.optional(), rank: z.number().int().nonnegative(), instructions: text.max(40000),
  examples: z.array(text).max(30), outputs: z.array(text).max(30),
  skills: z.array(z.object({ key: identifier, name: text, description: text,
    directory: resourcePathSchema, digest: sha256Schema, source: sourceSchema.optional() }).strict()).min(1).max(20),
  dependencies: z.array(z.object({ kind: z.enum(['tool', 'connection', 'runtime']),
    key: identifier, label: text, required: z.boolean() }).strict()).max(50),
  platforms: z.array(z.enum(['darwin', 'win32', 'linux'])).min(1).max(3),
  license: text, releaseNotes: z.string().max(128_000),
  download: z.object({ url: z.string().url(), sha256: sha256Schema,
    bytes: z.number().int().positive().max(256 * 1024 * 1024) }).strict().optional(),
}).strict().superRefine((preset, context) => {
  if (new Set(preset.skills.map(skill => skill.key)).size !== preset.skills.length)
    context.addIssue({ code: 'custom', message: '技能 key 不能重复', path: ['skills'] });
  const roots = preset.skills.map(skill => skill.directory);
  if (roots.some((root, index) => roots.some((other, otherIndex) => index !== otherIndex
    && (root === other || root.startsWith(`${other}/`)))))
    context.addIssue({ code: 'custom', message: '技能资源目录不能重叠', path: ['skills'] });
});
export const manifestSchema = z.object({ formatVersion: z.literal(1), preset: presetSchema }).strict();
export const catalogSchema = z.object({ formatVersion: z.literal(1), presets: z.array(presetSchema).max(1000) }).strict();
