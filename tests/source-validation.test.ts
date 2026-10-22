import { describe, expect, it, vi } from 'vitest';
import { verifySourceValidation } from '../scripts/ci/source-validation.mjs';

const repository = 'Fanch-hui/multi-ai-work';
const sha = 'a'.repeat(40);
const base = `repos/${repository}/actions`;
const workflow = { id: 10, path: '.github/workflows/ci.yml' };

function sourceRun(overrides = {}) {
  return {
    id: 200,
    run_number: 2,
    run_attempt: 1,
    workflow_id: workflow.id,
    path: workflow.path,
    repository: { full_name: repository },
    head_repository: { full_name: repository },
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function platformJob(name: string, overrides = {}) {
  return {
    name,
    run_id: 200,
    head_sha: sha,
    status: 'completed',
    conclusion: 'success',
    ...overrides,
  };
}

function fixture(
  options: {
    workflow?: unknown;
    runs?: ReturnType<typeof sourceRun>[];
    run?: ReturnType<typeof sourceRun>;
    confirmedRun?: ReturnType<typeof sourceRun>;
    confirmedRuns?: ReturnType<typeof sourceRun>[];
    jobs?: ReturnType<typeof platformJob>[];
  } = {},
) {
  let listings = 0;
  let details = 0;
  const runs = options.runs ?? [sourceRun()];
  const jobs = options.jobs ?? [platformJob('macos-latest'), platformJob('windows-latest')];
  const request = vi.fn(async (endpoint: string) => {
    if (endpoint === `${base}/workflows/ci.yml`) return options.workflow ?? workflow;
    if (endpoint.startsWith(`${base}/workflows/10/runs?head_sha=${sha}&`)) {
      const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get('page'));
      if (page === 1) listings += 1;
      const values = listings > 1 ? (options.confirmedRuns ?? runs) : runs;
      return { workflow_runs: values.slice((page - 1) * 100, page * 100) };
    }
    if (/\/runs\/\d+$/.test(endpoint)) {
      details += 1;
      if (details > 1 && options.confirmedRun) return options.confirmedRun;
      return (
        options.run ??
        runs.reduce((latest, run) => (run.run_number > latest.run_number ? run : latest))
      );
    }
    if (/\/runs\/\d+\/jobs\?filter=latest&/.test(endpoint)) {
      const page = Number(new URL(`https://api.github.com/${endpoint}`).searchParams.get('page'));
      return { jobs: jobs.slice((page - 1) * 100, page * 100) };
    }
    throw new Error(`Unexpected fixture request: ${endpoint}`);
  });
  return { repository, sha, request };
}

describe('source CI gate for Release draft uploads', () => {
  it('accepts the latest successful source run after checking both platforms', async () => {
    const input = fixture();
    await expect(verifySourceValidation(input)).resolves.toEqual({
      runId: 200,
      attempt: 1,
      url: `https://github.com/${repository}/actions/runs/200`,
    });
    expect(input.request).toHaveBeenCalledWith(
      `${base}/runs/200/jobs?filter=latest&per_page=100&page=1`,
    );
    expect(input.request).toHaveBeenCalledWith(
      `${base}/workflows/10/runs?head_sha=${sha}&per_page=100&page=1`,
    );
  });

  it('requires a CI run for the exact source SHA', async () => {
    await expect(verifySourceValidation(fixture({ runs: [] }))).rejects.toThrow(
      `no CI validation run. Inspect CI: https://github.com/${repository}/actions/workflows/ci.yml`,
    );
  });

  it.each([
    { status: 'completed', conclusion: 'failure' },
    { status: 'completed', conclusion: 'cancelled' },
    { status: 'in_progress', conclusion: null },
    { status: 'queued', conclusion: null },
  ])('rejects latest status %j even when an older run succeeded', async (status) => {
    const latest = sourceRun(status);
    await expect(
      verifySourceValidation(fixture({ runs: [sourceRun({ id: 100, run_number: 1 }), latest] })),
    ).rejects.toThrow(/Latest source CI run must complete successfully/);
  });

  it.each([
    { head_sha: 'b'.repeat(40) },
    { repository: { full_name: 'other/repo' } },
    { head_repository: { full_name: 'other/repo' } },
    { path: '.github/workflows/package-validation.yml' },
    { workflow_id: 11 },
  ])('rejects a CI run with incorrect provenance %j', async (fields) => {
    await expect(verifySourceValidation(fixture({ runs: [sourceRun(fields)] }))).rejects.toThrow(
      /does not match the source repository, SHA and workflow/,
    );
  });

  it('checks the selected run details independently of the listing', async () => {
    await expect(
      verifySourceValidation(fixture({ run: sourceRun({ head_sha: 'b'.repeat(40) }) })),
    ).rejects.toThrow(/does not match the source repository, SHA and workflow/);
    await expect(verifySourceValidation(fixture({ run: sourceRun({ id: 999 }) }))).rejects.toThrow(
      /identity changed/,
    );
  });

  it('verifies the named workflow metadata', async () => {
    await expect(
      verifySourceValidation(
        fixture({ workflow: { id: 10, path: '.github/workflows/other.yml' } }),
      ),
    ).rejects.toThrow(/does not match ci.yml/);
  });

  it.each(['macos-latest', 'windows-latest'])('requires the %s job', async (name) => {
    await expect(verifySourceValidation(fixture({ jobs: [platformJob(name)] }))).rejects.toThrow(
      /requires a successful/,
    );
  });

  it.each([
    { status: 'completed', conclusion: 'skipped' },
    { status: 'completed', conclusion: 'failure' },
    { status: 'in_progress', conclusion: null },
    { head_sha: 'b'.repeat(40) },
    { run_id: 999 },
  ])('rejects an unsuccessful or mismatched platform job %j', async (fields) => {
    await expect(
      verifySourceValidation(
        fixture({ jobs: [platformJob('macos-latest', fields), platformJob('windows-latest')] }),
      ),
    ).rejects.toThrow(/requires a successful latest macos-latest/);
  });

  it('requires both platforms in the latest effective job view after a retry', async () => {
    const run = sourceRun({ run_attempt: 2 });
    const input = fixture({ runs: [run], jobs: [platformJob('windows-latest')] });
    await expect(verifySourceValidation(input)).rejects.toThrow(/latest macos-latest/);
    expect(input.request).toHaveBeenCalledWith(
      `${base}/runs/200/jobs?filter=latest&per_page=100&page=1`,
    );
  });

  it('accepts a previous macOS success and a successful Windows retry in the same run', async () => {
    const input = fixture({
      runs: [sourceRun({ run_attempt: 2 })],
      jobs: [
        platformJob('macos-latest', { run_attempt: 1 }),
        platformJob('windows-latest', { run_attempt: 2 }),
      ],
    });
    await expect(verifySourceValidation(input)).resolves.toMatchObject({ attempt: 2 });
    expect(input.request).toHaveBeenCalledWith(
      `${base}/runs/200/jobs?filter=latest&per_page=100&page=1`,
    );
  });

  it('rejects ambiguous duplicate platform checks', async () => {
    await expect(
      verifySourceValidation(
        fixture({
          jobs: [
            platformJob('macos-latest'),
            platformJob('macos-latest'),
            platformJob('windows-latest'),
          ],
        }),
      ),
    ).rejects.toThrow(/requires a successful latest macos-latest/);
  });

  it('rejects a newer failed same-name job alongside an older success', async () => {
    await expect(
      verifySourceValidation(
        fixture({
          runs: [sourceRun({ run_attempt: 2 })],
          jobs: [
            platformJob('macos-latest', { run_attempt: 1 }),
            platformJob('windows-latest', { run_attempt: 1 }),
            platformJob('windows-latest', { run_attempt: 2, conclusion: 'failure' }),
          ],
        }),
      ),
    ).rejects.toThrow(/requires a successful latest windows-latest/);
  });

  it('rejects a retry that starts while jobs are being verified', async () => {
    await expect(
      verifySourceValidation(
        fixture({
          confirmedRun: sourceRun({ run_attempt: 2, status: 'queued', conclusion: null }),
        }),
      ),
    ).rejects.toThrow(/changed during verification/);
  });

  it('rejects a newer run or retry appearing during verification', async () => {
    for (const changed of [sourceRun({ id: 201, run_number: 3 }), sourceRun({ run_attempt: 2 })]) {
      await expect(verifySourceValidation(fixture({ confirmedRuns: [changed] }))).rejects.toThrow(
        /changed during verification/,
      );
    }
  });

  it('paginates SHA-filtered runs and platform jobs', async () => {
    const runs = Array.from({ length: 100 }, (_, index) =>
      sourceRun({ id: index + 1, run_number: index + 1 }),
    );
    runs.push(sourceRun({ run_number: 101 }));
    const jobs = Array.from({ length: 100 }, (_, index) => platformJob(`other-${index}`));
    jobs.push(platformJob('macos-latest'), platformJob('windows-latest'));
    const input = fixture({ runs, jobs });
    await expect(verifySourceValidation(input)).resolves.toMatchObject({ runId: 200 });
    expect(input.request).toHaveBeenCalledWith(
      `${base}/workflows/10/runs?head_sha=${sha}&per_page=100&page=2`,
    );
    expect(input.request).toHaveBeenCalledWith(
      `${base}/runs/200/jobs?filter=latest&per_page=100&page=2`,
    );
  });

  it('reports a safe workflow entry when the API fails', async () => {
    const input = fixture();
    input.request.mockRejectedValueOnce(new Error('private request failure details'));
    await expect(verifySourceValidation(input)).rejects.toThrow(
      `Unable to read source CI validation from GitHub. Inspect CI: https://github.com/${repository}/actions/workflows/ci.yml`,
    );
  });

  it.each([
    { repository: 'https://github.com/a/b' },
    { repository: 'a/b/extra' },
    { sha: 'abc1234' },
  ])('validates inputs before issuing API calls %j', async (fields) => {
    const input = { ...fixture(), ...fields };
    await expect(verifySourceValidation(input)).rejects.toThrow(/full source SHA/);
    expect(input.request).not.toHaveBeenCalled();
  });
});
