import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { ProviderEvent } from '../src/domain/provider.js';
import { AntigravityEvents } from '../src/providers/native/antigravity-events.js';
import { antigravitySessionArgs, runAntigravitySession } from '../src/providers/native/antigravity-session.js';

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map(folder => rm(folder, { recursive: true, force: true }))); });
const init = (id = 'session') => ({ event: 'init', conversation_id: id,
  init: { cwd: '/workspace', tools: ['call_mcp_tool'], permission_mode: 'request-review' } });
const result = (usage: Record<string, number> = {}, response = 'answer', status = 'SUCCESS') => ({ event: 'result',
  result: { conversation_id: 'session', status, response, usage } });
const step = (index: number, usage: Record<string, number>, extra = {}) => ({ event: 'step_update',
  step_update: { conversation_id: 'session', step_index: index, step_type: 'agent_response', state: 'DONE', usage, ...extra } });

describe('Antigravity event accounting', () => {
  it('uses streamed text once and does not duplicate the final response', () => {
    const events: ProviderEvent[] = [], projection = new AntigravityEvents({ emit: event => events.push(event) });
    projection.accept(init());
    projection.accept(step(1, {}, { state: 'ACTIVE', text_delta: 'ans' }));
    projection.accept(step(1, { input_tokens: 3, output_tokens: 2 }, { text_delta: 'wer' }));
    expect(projection.accept(result({ input_tokens: 3, output_tokens: 2 }))?.text).toBe('answer');
    expect(events.filter(event => event.type === 'text').map(event => event.data.delta).join('')).toBe('answer');
  });

  it('subtracts the preceding native session totals on resume', () => {
    const projection = new AntigravityEvents({ expectedSessionId: 'session',
      previousUsage: { input_tokens: 100, output_tokens: 10, cache_read_tokens: 40 } });
    projection.accept(init());
    const turn = projection.accept(result({ input_tokens: 140, output_tokens: 15, cache_read_tokens: 65 }));
    expect(turn?.usage).toEqual({ inputTokens: 40, outputTokens: 5, cachedInputTokens: 25, source: 'reported' });
    expect(turn?.cumulativeUsage?.input_tokens).toBe(140);
  });

  it('uses completed step counters once when a resumed session has no baseline', () => {
    const projection = new AntigravityEvents({ expectedSessionId: 'session' });
    projection.accept(init());
    projection.accept(step(8, { input_tokens: 25, output_tokens: 4, cache_read_tokens: 10 }, { state: 'ACTIVE' }));
    projection.accept(step(8, { input_tokens: 30, output_tokens: 5, cache_read_tokens: 10 }));
    projection.accept(step(8, { input_tokens: 30, output_tokens: 5, cache_read_tokens: 10 }));
    projection.accept(step(9, { input_tokens: 2, output_tokens: 1 }, { step_type: 'checkpoint' }));
    expect(projection.accept(result({ input_tokens: 1000, output_tokens: 100 }))?.usage)
      .toEqual({ inputTokens: 32, outputTokens: 6, cachedInputTokens: undefined, source: 'reported' });
  });

  it('keeps unknown per-turn usage unknown instead of displaying session totals', () => {
    const projection = new AntigravityEvents({ expectedSessionId: 'session' });
    projection.accept(init());
    expect(projection.accept(result({ input_tokens: 1000, output_tokens: 100 }))?.usage).toEqual({ source: 'unknown' });
  });

  it('rejects different sessions, unfinished terminal states and an empty reply', () => {
    expect(() => new AntigravityEvents({ expectedSessionId: 'session' }).accept(init('other'))).toThrow('其他原生会话');
    for (const status of ['ERROR', 'CANCELED', 'INTERRUPTED', 'WAITING']) {
      const projection = new AntigravityEvents(); projection.accept(init());
      expect(() => projection.accept(result({}, 'partial', status))).toThrow('未完成');
    }
    const projection = new AntigravityEvents(); projection.accept(init());
    expect(() => projection.accept(result({}, ''))).toThrow('空结果');
  });
});

const fixtureSource = `
import readline from 'node:readline';
import { writeFileSync } from 'node:fs';
const args=process.argv.slice(2), mode=args[0], marker=args[1];
const position=args.indexOf('--conversation');
const id=position>=0?args[position+1]:'session';
const send=value=>process.stdout.write(JSON.stringify(value)+'\\n');
send({event:'init',conversation_id:id,init:{cwd:process.cwd(),tools:['call_mcp_tool'],permission_mode:'request-review'}});
const input=readline.createInterface({input:process.stdin});
input.on('line',line=>{
  const user=JSON.parse(line); writeFileSync(marker,JSON.stringify({user,id,args,pid:process.pid}));
  if(mode==='wait'){
    send({event:'step_update',step_update:{conversation_id:id,step_index:2,state:'ACTIVE',step_type:'agent_response',text_delta:'partial'}});
    setInterval(()=>{},1000);return;
  }
  if(mode==='missing'){input.close();process.exit(0);}
  send({event:'step_update',step_update:{conversation_id:id,step_index:2,state:'ACTIVE',step_type:'agent_response',text_delta:'ans'}});
  send({event:'step_update',step_update:{conversation_id:id,step_index:2,state:'DONE',step_type:'agent_response',text_delta:'wer',usage:{input_tokens:20,output_tokens:3}}});
  send({event:'result',result:{conversation_id:id,status:mode==='failed'?'ERROR':'SUCCESS',response:'answer',usage:{input_tokens:120,output_tokens:13}}});
});
input.on('close',()=>process.exit(mode==='exit-failed'?1:0));
`;

async function fixture(mode = 'success') {
  const folder = await mkdtemp(join(tmpdir(), 'ai-team-agy-events-')); folders.push(folder);
  const executable = join(folder, 'agy.mjs'), marker = join(folder, 'input.json');
  await writeFile(executable, fixtureSource);
  return { folder, marker, options: { executable, args: [mode, marker], cwd: folder,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, prompt: 'user prompt', signal: new AbortController().signal,
    beforePrompt: async () => {} } };
}

describe('Antigravity native process session', () => {
  it('awaits initialization approval, sends one prompt and closes the process naturally', async () => {
    const test = await fixture();
    test.options.beforePrompt = async () => { await expect(readFile(test.marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' }); };
    expect(await runAntigravitySession(test.options)).toMatchObject({ text: 'answer', nativeSessionId: 'session' });
    expect(JSON.parse(await readFile(test.marker, 'utf8')).user).toEqual({ event: 'user', message: { content: 'user prompt' } });
  });

  it('does not submit user content when the initialization callback rejects', async () => {
    const test = await fixture(); test.options.beforePrompt = async () => { throw new Error('配置检查失败'); };
    await expect(runAntigravitySession(test.options)).rejects.toThrow('配置检查失败');
    await expect(readFile(test.marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('restores only the requested session and checks its cumulative counters', async () => {
    const test = await fixture();
    const turn = await runAntigravitySession({ ...test.options, expectedSessionId: 'session',
      previousUsage: { input_tokens: 100, output_tokens: 10 } });
    expect(turn.usage).toMatchObject({ inputTokens: 20, outputTokens: 3 });
    expect(JSON.parse(await readFile(test.marker, 'utf8')).args).toContain('--conversation');
    expect(() => antigravitySessionArgs(['--continue'], 'session')).toThrow('精确 ID');
  });

  it('fails on an unfinished result, a missing result or unsuccessful process exit', async () => {
    for (const mode of ['failed', 'missing', 'exit-failed']) {
      const test = await fixture(mode);
      await expect(runAntigravitySession(test.options)).rejects.toThrow(/未完成|最终结果|未正常结束/);
    }
  });

  it('cancels and terminates a process still waiting for a result', async () => {
    const test = await fixture('wait'), controller = new AbortController();
    test.options.signal = controller.signal;
    const pending = runAntigravitySession({ ...test.options,
      onEvent: event => { if (event.type === 'text') controller.abort(new Error('用户取消')); } });
    await expect(pending).rejects.toThrow('用户取消');
    const input = JSON.parse(await readFile(test.marker, 'utf8'));
    expect(() => process.kill(input.pid, 0)).toThrow();
  });

  it('pauses after a paired App question without reporting a native failure', async () => {
    const test = await fixture('wait'), input = new AbortController();
    const turn = await runAntigravitySession({ ...test.options, expectedSessionId: 'session',
      inputSignal: input.signal, isWaitingForInput: () => true,
      onEvent: event => { if (event.type === 'text') input.abort(); } });
    expect(turn).toMatchObject({ text: 'partial', nativeSessionId: 'session', outcome: 'waiting_input', usage: { source: 'unknown' } });
    const submitted = JSON.parse(await readFile(test.marker, 'utf8'));
    expect(submitted.args).toContain('--conversation');
    expect(() => process.kill(submitted.pid, 0)).toThrow();
  });

  it('checks initialization before observing an already requested input pause', async () => {
    const test = await fixture(), input = new AbortController(); input.abort();
    test.options.beforePrompt = async () => { throw new Error('工具权限检查失败'); };
    await expect(runAntigravitySession({ ...test.options, inputSignal: input.signal, isWaitingForInput: () => true }))
      .rejects.toThrow('工具权限检查失败');
    await expect(readFile(test.marker, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('keeps user cancellation authoritative when input is also pending', async () => {
    const test = await fixture('wait'), input = new AbortController(), cancel = new AbortController();
    await expect(runAntigravitySession({ ...test.options, signal: cancel.signal,
      inputSignal: input.signal, isWaitingForInput: () => true,
      onEvent: event => { if (event.type === 'text') { input.abort(); cancel.abort(new Error('用户取消')); } },
    })).rejects.toThrow('用户取消');
  });
});
