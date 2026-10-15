import { appendFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { ToolExecutionContext } from '../domain/tools.js';
import { createToolRegistry } from '../tools/index.js';

export function verificationTools(workspacePath: string, signal: AbortSignal) {
  const denied = (): never => { throw new Error('验证仅授权 read_file'); };
  const context: ToolExecutionContext = {
    runId: randomUUID(), botId: 'verification', workspace: { id: 'verification', name: 'verification', path: workspacePath, writable: false },
    conversation: { id: 'verification', name: 'verification', kind: 'private', memberIds: ['verification'], workspaceId: 'verification', createdAt: '' },
    task: { id: 'verification', botId: 'verification', conversationId: 'verification', dependencyIds: [], goal: '只读验证', expectedOutput: '',
      status: 'running', runIds: [], artifactIds: [], requestId: '', depth: 0, createdAt: '', updatedAt: '' },
    signal, requestApproval: async () => false, listArtifacts: () => [], findArtifact: () => undefined,
    registerArtifact: denied, postMessage: denied, readMessages: denied, delegateTask: denied, getTask: () => undefined,
    recallMemory: () => [], proposeMemory: denied, getSecret: async () => undefined, toolConnections: [], skills: [],
  };
  const registry = createToolRegistry();
  const tools = registry.definitions(context).filter(tool => tool.name === 'read_file');
  return { tools, close: () => registry.close(), execute: async (name: string, args: Record<string, unknown>, callId: string) => {
    if (name !== 'read_file' || args.path !== 'verification.txt') denied();
    const value = await registry.execute(name, args, context);
    await appendFile(`${workspacePath}/calls.jsonl`, JSON.stringify({ callId }) + '\n', { mode: 0o600 });
    return value;
  } };
}
