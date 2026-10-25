import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { VoiceStatus } from '../src/domain/voice.js';
import { SystemSpeechHost } from '../apps/desktop/system-speech-host.js';
import { DesktopVoiceService, systemSpeechLaunch } from '../apps/desktop/voice-host.js';

let directory: string;
let helper: string;
let trace: string;
const hosts: SystemSpeechHost[] = [];
beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), 'system-speech-host-'));
  helper = join(directory, 'helper.mjs');
  trace = join(directory, 'trace.txt');
  await writeFile(
    helper,
    `
import {appendFileSync} from 'node:fs';
import {createInterface} from 'node:readline';
const args=process.argv.slice(2);
const value=(name)=>args[args.indexOf(name)+1];
const log=(text)=>appendFileSync(value('--trace'),text+' '+process.pid+'\\n');
if(args.includes('--status')) {
  console.log(JSON.stringify({available:true,locale:args.includes('--language')?value('--language'):'system',authorization:'not_determined'}));
  process.exit(0);
}
const scenario=value('--scenario');
const interval=setInterval(()=>{},1000);
process.on('SIGTERM',()=>{
  if(scenario==='stubborn')return;
  setTimeout(()=>{log('terminated');process.exit(0);},scenario==='delayed'?150:0);
});
const lines=createInterface({input:process.stdin});
lines.on('line',(line)=>{
  if(line!=='stop'||scenario==='stubborn')return;
  log('stopped');
  console.log(JSON.stringify({type:'result',text:'系统识别的草稿'}));
  clearInterval(interval);lines.close();process.stdin.destroy();
});
log('start');
console.log(JSON.stringify({type:'ready'}));
if(scenario==='malformed') console.log('broken protocol');
if(scenario==='denied') console.log(JSON.stringify({type:'error',message:'SPEECH_PERMISSION_DENIED'}));
`,
  );
});
afterEach(async () => {
  await Promise.all(hosts.splice(0).map((host) => host.close()));
  await rm(directory, { recursive: true, force: true });
});
function create(scenario = 'normal', options: { timeoutMs?: number; stopTimeoutMs?: number } = {}) {
  const host = new SystemSpeechHost({
    command: process.execPath,
    args: [helper, '--trace', trace, '--scenario', scenario],
    helperPath: helper,
    ...options,
  });
  hosts.push(host);
  return host;
}
async function events() {
  return readFile(trace, 'utf8').catch(() => '');
}
async function waitForStarts(count: number) {
  const deadline = Date.now() + 4_000;
  while ((await events()).split('\n').filter((line) => line.startsWith('start ')).length < count) {
    if (Date.now() > deadline) throw new Error('Speech helper did not start');
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

describe('system speech process lifecycle', () => {
  it('queries actual helper protocol without starting recording and keeps dialogue readiness independent', async () => {
    const host = create();
    const status: VoiceStatus = {
      configuration: {
        baseUrl: 'https://api.openai.com/v1',
        transcriptionModel: '',
        speechModel: '',
        voice: 'alloy',
        language: 'zh',
        dictationLanguage: 'zh-CN',
      },
      hasApiKey: false,
      transcriptionAvailable: false,
      speechAvailable: false,
      transcriptionUnavailableReason: '请配置语音对话识别服务',
      mode: 'segmented',
      maxRecordingMs: 45_000,
    };
    const core = vi.fn(async () => status);
    const service = new DesktopVoiceService(core, host);
    const result = (await service.request('voice.status', {})) as VoiceStatus;
    expect(result.recognition).toEqual({
      available: true,
      locale: 'zh-CN',
      authorization: 'not_determined',
    });
    expect(result.transcriptionAvailable).toBe(false);
    expect(result.configuration).toEqual(status.configuration);
    expect(await events()).toBe('');
    expect(core).toHaveBeenCalledExactlyOnceWith('voice.status', {});
    expect(await host.status('中文')).toMatchObject({
      available: false,
      authorization: 'unavailable',
      reason: expect.stringContaining('语言代码'),
    });
  });

  it('returns the final text after stop and releases the actual helper process', async () => {
    const host = create();
    const result = host.start({ requestId: 'dictation', language: 'zh' });
    await waitForStarts(1);
    const pid = Number((await events()).trim().split(' ')[1]);
    await host.stop('dictation');
    expect(await result).toEqual({ text: '系统识别的草稿' });
    expect(alive(pid)).toBe(false);
  });

  it('cancels the old capture before restart and ignores a stale cancel request', async () => {
    const host = create();
    const first = host.start({ requestId: 'first' });
    expect(host.start({ requestId: 'first' })).toBe(first);
    await waitForStarts(1);
    const next = host.start({ requestId: 'next' });
    await waitForStarts(2);
    expect(await first).toEqual({ text: '' });
    expect(
      (await events())
        .split('\n')
        .filter(Boolean)
        .map((line) => line.split(' ')[0]),
    ).toEqual(process.platform === 'win32' ? ['start', 'start'] : ['start', 'terminated', 'start']);
    await host.cancel('first');
    await host.stop('next');
    expect(await next).toEqual({ text: '系统识别的草稿' });
  });

  it('does not open a queued capture after it has been cancelled', async () => {
    const host = create('delayed');
    const first = host.start({ requestId: 'first' });
    await waitForStarts(1);
    const next = host.start({ requestId: 'next' });
    await host.cancel('next');
    expect(await first).toEqual({ text: '' });
    expect(await next).toEqual({ text: '' });
    expect((await events()).match(/start /g)).toHaveLength(1);
  });

  it.each([
    ['malformed', '格式错误'],
    ['denied', '系统未允许麦克风访问'],
  ])('rejects %s and releases capture', async (scenario, message) => {
    const host = create(scenario);
    await expect(host.start({ requestId: 'request' })).rejects.toThrow(message);
    const pid = Number((await events()).trim().split(' ')[1]);
    expect(alive(pid)).toBe(false);
  });

  it('enforces stop deadline even when a helper ignores graceful termination', async () => {
    const host = create('stubborn', { stopTimeoutMs: 100 });
    const result = host.start({ requestId: 'request' });
    const rejected = expect(result).rejects.toThrow('未能结束');
    await waitForStarts(1);
    const pid = Number((await events()).trim().split(' ')[1]);
    await host.stop('request');
    await rejected;
    expect(alive(pid)).toBe(false);
  }, 10_000);

  it('bounds missing results and prevents new captures after close', async () => {
    const host = create('normal', { timeoutMs: 100 });
    await expect(host.start({ requestId: 'request' })).rejects.toThrow('超时');
    await host.close();
    await expect(host.start({ requestId: 'later' })).rejects.toThrow('退出');
  });

  it('locates packaged helpers and preserves the system policy outside the child process', () => {
    const launch = systemSpeechLaunch('win32', directory);
    expect(launch.helperPath).toBe(join(directory, 'speech-windows.ps1'));
    expect(launch.args).toEqual([
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      launch.helperPath,
    ]);
    expect(systemSpeechLaunch('darwin', directory).command).toBe(
      join(directory, 'system-speech-helper'),
    );
    expect(systemSpeechLaunch('linux', directory)).toEqual({});
  });
});
