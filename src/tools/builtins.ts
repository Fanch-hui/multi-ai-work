import { z } from 'zod';
import { unlink, readFile, stat, realpath } from 'node:fs/promises';
import path from 'node:path';
import type { ToolExecutionContext } from '../domain/tools.js';
import { createArtifact } from './artifacts.js';
import { fetchWeb } from './web.js';
import { isSearchConnection, search, searchConnection } from './search.js';
import { NetworkConcurrency } from './network-concurrency.js';
import { createProcessTools } from './process.js';
import { createFileTools } from './files.js';
import { createArtifactTools } from './artifact-tools.js';
import { createQuestionTools } from './questions.js';
import { filePath } from './file-policy.js';
import type { McpConnections } from './mcp.js';
import { createTeamTools } from './team.js';
import { createMemoryTools } from './memory.js';
import { createArtifactReadTool } from './artifact-read.js';
import { createOfficeTools } from './office.js';
import { createSecurityScanTools } from './security-scan.js';
import { createTaskPlanTools } from './task-plan.js';
import { createTaskControlTools } from './task-control.js';

type Builtin = {
  description: string;
  schema: z.ZodObject;
  execute(args: any, context: ToolExecutionContext): Promise<unknown> | unknown;
  available?(context: ToolExecutionContext): boolean;
};
const text = z.string().min(1).max(120_000);
const id = z.string().min(1).max(200);
const argumentsSchema = z.record(z.string(), z.unknown());

export function createBuiltins(mcp: McpConnections): Record<string, Builtin> {
  const network = new NetworkConcurrency();
  return {
    ...createTeamTools(),
    ...createMemoryTools(),
    ...createFileTools(),
    ...createArtifactTools(),
    ...createProcessTools(),
    ...createQuestionTools(),
    ...createOfficeTools(),
    ...createSecurityScanTools(),
    ...createTaskPlanTools(),
    ...createTaskControlTools(),
    post_message: {
      description:
        '即时发言或发送文件，artifactIds 填写获准成果 ID，可只附文件。默认当前对话；主管可用 conversationId 发到来源主对话绑定的任务群，附带文件对群成员共享。需要成员处理时用 delegate_task 携带文件，执行中用 send_task_input 补发。当前对话发布后保留为本轮回复，最终返回用于任务结果。',
      schema: z.object({
        content: z.string().trim().max(120000).default(''),
        artifactIds: z.array(id).max(50).optional(),
        conversationId: id.optional(),
      }),
      execute: (args, context) => {
        if (!args.content && !args.artifactIds?.length) throw new Error('消息不能为空');
        for (const artifactId of args.artifactIds ?? [])
          if (!context.findArtifact(artifactId)) throw new Error('成果不存在或未授权');
        return {
          messageId: context.postMessage(args.content, args.artifactIds, args.conversationId),
        };
      },
    },
    read_messages: {
      description: '读取当前对话消息，序号游标可用于增量读取。',
      schema: z.object({
        after: z.number().int().min(0).optional(),
        around: z.number().int().min(1).optional(),
        limit: z.number().int().min(1).max(100).optional(),
      }),
      execute: (args, context) => context.readMessages(args.after, args.limit ?? 30, args.around),
    },
    search_messages: {
      description:
        '搜索当前会话已提交的原始消息，返回稳定消息 ID、序号和摘录，可用 read_messages 的 around 查看上下文。',
      schema: z.object({
        query: z.string().min(1).max(2000),
        limit: z.number().int().min(1).max(100).default(20),
      }),
      available: (context) => !!context.searchMessages,
      execute: (args, context) => context.searchMessages!(args.query, args.limit),
    },
    delegate_task: {
      description:
        '向当前团队成员委派任务，立即返回持久任务 ID。artifactIds 显式传递成员需要读取的文件。已有任务安排时填写 planStepId，Core 关联实际进度并复用前置步骤的任务依赖；同一步骤的相关成员应完整派发。独立工作同时派发，dependencyIds 仅用于额外必须等待的前置任务。',
      schema: z.object({
        botId: id,
        goal: text,
        expectedOutput: text,
        dependencyIds: z.array(id).max(10).optional(),
        artifactIds: z.array(id).max(50).optional(),
        planStepId: id.optional(),
      }),
      available: (context) => context.conversation.kind === 'group',
      execute: (args, context) =>
        context.delegateTask(
          args.botId,
          args.goal,
          args.expectedOutput,
          args.dependencyIds,
          args.artifactIds,
          args.planStepId,
        ),
    },
    get_task: {
      description:
        '只读检查已授权任务的当前阶段、最后模型/工具活动、等待对象、检查点、补充接收状态、需求版本和交付清单。返回最新运行与子任务；result 可能是上一轮结果。省略 taskId 读取当前任务，不会恢复制作。',
      schema: z.object({ taskId: id.optional() }),
      execute: (args, context) => {
        const task = context.getTask(args.taskId ?? context.task.id);
        if (!task) throw new Error('任务不存在或未授权');
        return task;
      },
    },
    recall_memory: {
      description:
        '检索并展开当前身份与对话获准使用的长期记忆。支持关键词查询、按主题过滤、分页和按 ID 读取完整正文及合并历史。',
      schema: z.object({
        query: z.string().trim().max(120_000).optional(),
        ids: z.array(id).max(50).optional(),
        topic: z.string().trim().max(200).optional(),
        offset: z.number().int().min(0).optional(),
        limit: z.number().int().min(1).max(50).optional(),
        includeHistory: z.boolean().optional(),
      }),
      execute: (args, context) => context.recallMemory(args),
    },
    propose_memory: {
      description:
        '挑选用户明确表达的长期偏好、习惯和持续要求保存为记忆，sourceIds 须引用用户原始消息；单次任务目标、预算、进度和成员讨论留在任务记录。团队公共记忆交由管家整理。',
      schema: z.object({
        content: text,
        scope: z.enum(['bot', 'team', 'shared']),
        sourceIds: z.array(id).max(50),
        topic: z.string().trim().max(120).optional(),
        summary: z.string().trim().max(200).optional(),
        tags: z.array(z.string().trim().min(1).max(60)).max(20).optional(),
      }),
      execute: (args, context) =>
        context.proposeMemory(args.content, args.scope, args.sourceIds, {
          topic: args.topic,
          summary: args.summary,
          tags: args.tags,
        }),
    },
    read_artifact: createArtifactReadTool(),
    write_artifact: {
      description:
        '生成并登记最终交付用户的文件（Markdown、DOCX、XLSX、PDF）。过程资料将 purpose 设为 intermediate；默认 deliverable 进入成果库。覆盖前须读取当前文件版本，按成员执行权限确认操作。XLSX 使用 sheets，其他格式使用 content。',
      schema: z.object({
        path: text,
        format: z.enum(['markdown', 'docx', 'xlsx', 'pdf']),
        purpose: z.enum(['deliverable', 'intermediate']).default('deliverable'),
        title: z.string().max(500).optional(),
        content: z.string().max(500_000).optional(),
        sheets: z
          .array(
            z.object({
              name: z.string().min(1).max(31),
              rows: z
                .array(
                  z
                    .array(z.union([z.string().max(32767), z.number(), z.boolean(), z.null()]))
                    .max(200),
                )
                .max(10000),
            }),
          )
          .max(30)
          .optional(),
      }),
      available: (context) => context.workspace.writable,
      execute: (args, context) => createArtifact(args, context),
    },
    delete_file: {
      description: '删除授权目录中的单个文件，按成员执行权限确认操作。',
      schema: z.object({ path: text }),
      available: (context) => context.workspace.writable,
      execute: async (args, context) => {
        const target = await filePath(args.path, context);
        if (
          !(await context.requestApproval('delete_file', `删除文件：${path.basename(target)}`, {
            path: target,
          }))
        )
          throw new Error('删除未获批准');
        if ((await filePath(target, context)) !== target)
          throw new Error('目标路径已变化，请重新确认');
        context.signal.throwIfAborted();
        context.markDispatched?.();
        await unlink(target);
        return { deleted: args.path };
      },
    },
    read_skill: {
      description:
        '按需读取获准技能及其包内文本资源。省略 resource 返回入口内容与资源目录；resource 是相对于资源目录的路径。',
      schema: z.object({
        skillId: id,
        resource: z.string().max(8000).optional(),
        offset: z.number().int().min(0).default(0),
        limit: z.number().int().min(1).max(24000).default(12000),
      }),
      available: (context) => context.skills.length > 0,
      execute: async (args, context) => {
        const skill = context.skills.find((item) => item.id === args.skillId);
        if (!skill) throw new Error('技能未授权');
        if (!args.resource)
          return {
            id: skill.id,
            name: skill.name,
            content: skill.content,
            path: skill.path,
            resourceRoot: skill.resourceRoot,
          };
        if (!skill.resourceRoot || path.isAbsolute(args.resource))
          throw new Error('技能资源路径无效');
        const root = await realpath(skill.resourceRoot),
          file = await realpath(path.resolve(root, args.resource));
        const relative = path.relative(root, file);
        if (relative.startsWith('..') || path.isAbsolute(relative))
          throw new Error('技能资源超出授权目录');
        if (!(await stat(file)).isFile() || (await stat(file)).size > 128000)
          throw new Error('请读取不超过 128 KiB 的文本资源');
        const bytes = await readFile(file);
        if (bytes.includes(0)) throw new Error('此资源为二进制，请使用已授权的运行环境处理');
        const text = bytes.toString('utf8');
        return {
          content: text.slice(args.offset, args.offset + args.limit),
          nextOffset: args.offset + args.limit < text.length ? args.offset + args.limit : null,
        };
      },
    },
    fetch_web: {
      description: '获取公共网页文本，返回来源地址与时间；不访问内网或元数据地址。',
      schema: z.object({ url: z.string().url().max(8000) }),
      execute: (args, context) =>
        network.run(`web:${new URL(args.url).origin}`, context, () => fetchWeb(args.url, context)),
    },
    search_web: {
      description:
        '通过获准的 HTTP 搜索服务或 Tavily MCP 搜索网页，返回实际服务、查询、来源和时间；多个服务可指定 connectionId。',
      schema: z.object({ query: z.string().min(1).max(2000), connectionId: id.optional() }),
      available: (context) => context.toolConnections.some(isSearchConnection),
      execute: (args, context) => {
        const connectionId = searchConnection(context, args.connectionId).id;
        return network.run(`search:${connectionId}`, context, () =>
          search(args.query, connectionId, context, mcp),
        );
      },
    },
    list_mcp_tools: {
      description: '读取获准使用的 MCP / Bridge 工具及输入 schema，调用前先检查接口。',
      schema: z.object({ connectionId: id }),
      available: (context) =>
        context.toolConnections.some((item) => item.enabled && item.kind !== 'search'),
      execute: (args, context) => mcp.describe(args.connectionId, context),
    },
    call_mcp: {
      description:
        '调用获准使用的 MCP / Bridge 工具，副作用按成员执行权限确认。Bridge 返回持久 request ID 和远端 task ID；结果未知时查询对账，禁止盲重试。',
      schema: z.object({ connectionId: id, toolName: id, arguments: argumentsSchema }),
      available: (context) =>
        context.toolConnections.some((item) => item.enabled && item.kind !== 'search'),
      execute: (args, context) =>
        mcp.call(args.connectionId, args.toolName, args.arguments, context),
    },
  };
}
