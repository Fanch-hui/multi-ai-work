import { execFile } from 'node:child_process';
import { resolve } from 'node:path';
import { promisify } from 'node:util';
import { describe, expect, it } from 'vitest';

const execute = promisify(execFile);
const script = resolve('apps/desktop/speech-windows.ps1');
const flags = ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass'];
const output = (text: string) => JSON.parse(text.trim());

describe.skipIf(process.platform !== 'win32')('Windows 系统语音组件', () => {
  it('只查询实际语言能力，缺少语言包时返回明确状态', async () => {
    const { stdout } = await execute(
      'powershell.exe',
      [...flags, '-File', script, '--status', '--language', 'zh'],
      { timeout: 30_000, windowsHide: true },
    );
    const status = output(stdout);
    expect(typeof status.available).toBe('boolean');
    expect(status.locale).toMatch(/^zh(?:-[a-zA-Z]+)*$/);
    expect(['not_determined', 'unavailable']).toContain(status.authorization);
    if (!status.available) expect(status.reason).toBeTruthy();
    expect(status.type).toBeUndefined();
  }, 30_000);

  it('拒绝无效录音时限，识别组件保持未启动', async () => {
    let failure: unknown;
    try {
      await execute(
        'powershell.exe',
        [...flags, '-File', script, '--recognize', '--max-duration-ms', '0'],
        { timeout: 10_000, windowsHide: true },
      );
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ code: 1 });
    const result = output((failure as { stdout: string }).stdout);
    expect(result).toMatchObject({ type: 'error' });
    expect(result.message).toContain('SPEECH_ARGUMENTS:');
    expect(result.message).toContain('duration');
  }, 15_000);

  it('系统识别实现通过真实 .NET 编译，测试不创建音频输入', async () => {
    const command = `
      $ErrorActionPreference='Stop'
      $tokens=$null; $errors=$null
      $ast=[Management.Automation.Language.Parser]::ParseFile($env:MAW_SPEECH_SCRIPT,[ref]$tokens,[ref]$errors)
      if($errors.Count){throw 'PowerShell syntax failed'}
      $definition=$ast.Find({param($node) $node -is [Management.Automation.Language.StringConstantExpressionAst] -and $node.StringConstantType -eq 'SingleQuotedHereString'},$true)
      if(!$definition){throw 'Speech implementation is missing'}
      Add-Type -AssemblyName System.Speech
      Add-Type -TypeDefinition $definition.Value -ReferencedAssemblies System.Speech,System.Core
      [Console]::WriteLine('compiled')
    `;
    const encoded = Buffer.from(command, 'utf16le').toString('base64');
    const { stdout } = await execute('powershell.exe', [...flags, '-EncodedCommand', encoded], {
      env: { ...process.env, MAW_SPEECH_SCRIPT: script },
      timeout: 30_000,
      windowsHide: true,
    });
    expect(stdout.trim()).toBe('compiled');
  }, 30_000);
});
