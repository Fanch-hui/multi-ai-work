import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const workflowPath = '.github/workflows/ci.yml';
const requiredJobs = ['macos-latest', 'windows-latest'];

function validId(value) {
  return Number.isSafeInteger(value) && value > 0;
}

function assertRun(run, repository, sha, workflowId, fail) {
  if (
    !validId(run?.id) ||
    !validId(run.run_number) ||
    !validId(run.run_attempt) ||
    run.repository?.full_name !== repository ||
    run.head_repository?.full_name !== repository ||
    run.head_sha !== sha ||
    run.path !== workflowPath ||
    run.workflow_id !== workflowId
  ) {
    fail('CI run does not match the source repository, SHA and workflow');
  }
}

async function readPages(request, endpoint, key, fail) {
  const values = [];
  const separator = endpoint.includes('?') ? '&' : '?';
  for (let page = 1; ; page += 1) {
    const data = await request(`${endpoint}${separator}per_page=100&page=${page}`);
    const batch = data?.[key];
    if (!Array.isArray(batch)) fail('GitHub returned an invalid CI response');
    values.push(...batch);
    if (batch.length < 100) return values;
  }
}

export async function verifySourceValidation({ repository, sha, request }) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !/^[0-9a-f]{40}$/.test(sha)) {
    throw new Error('A repository and full source SHA are required for CI validation');
  }
  const base = `repos/${repository}/actions`;
  let entry = `https://github.com/${repository}/actions/workflows/ci.yml`;
  const fail = (message) => {
    throw new Error(`${message}. Inspect CI: ${entry}`);
  };
  const read = async (endpoint) => {
    try {
      return await request(endpoint);
    } catch {
      fail('Unable to read source CI validation from GitHub');
    }
  };
  const workflow = await read(`${base}/workflows/ci.yml`);
  if (!validId(workflow?.id) || workflow.path !== workflowPath) {
    fail('Source validation workflow does not match ci.yml');
  }
  const latestRun = async () => {
    const runs = await readPages(
      read,
      `${base}/workflows/${workflow.id}/runs?head_sha=${sha}`,
      'workflow_runs',
      fail,
    );
    if (runs.length === 0) fail('Source SHA has no CI validation run');
    for (const run of runs) assertRun(run, repository, sha, workflow.id, fail);
    return runs.reduce((latest, run) => (run.run_number > latest.run_number ? run : latest));
  };
  const selected = await latestRun();
  entry = `https://github.com/${repository}/actions/runs/${selected.id}`;
  const runEndpoint = `${base}/runs/${selected.id}`;
  const run = await read(runEndpoint);
  assertRun(run, repository, sha, workflow.id, fail);
  if (run.id !== selected.id || run.run_number !== selected.run_number) {
    fail('Source CI run identity changed');
  }
  if (run.status !== 'completed' || run.conclusion !== 'success') {
    fail('Latest source CI run must complete successfully before uploading');
  }
  const jobs = await readPages(read, `${runEndpoint}/jobs?filter=latest`, 'jobs', fail);
  for (const name of requiredJobs) {
    const matches = jobs.filter((job) => job.name === name);
    if (
      matches.length !== 1 ||
      matches[0].run_id !== run.id ||
      matches[0].head_sha !== sha ||
      matches[0].status !== 'completed' ||
      matches[0].conclusion !== 'success'
    ) {
      fail(`Source CI requires a successful latest ${name} check`);
    }
  }
  const confirmed = await read(runEndpoint);
  assertRun(confirmed, repository, sha, workflow.id, fail);
  const latest = await latestRun();
  if (
    confirmed.id !== run.id ||
    confirmed.run_attempt !== run.run_attempt ||
    confirmed.status !== 'completed' ||
    confirmed.conclusion !== 'success' ||
    latest.id !== run.id ||
    latest.run_attempt !== run.run_attempt ||
    latest.status !== 'completed' ||
    latest.conclusion !== 'success'
  ) {
    fail('Source CI changed during verification; validate the latest run again');
  }
  return { runId: run.id, attempt: run.run_attempt, url: entry };
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  const result = await verifySourceValidation({
    repository: process.env.GITHUB_REPOSITORY,
    sha: process.env.SOURCE_RUN_SHA,
    request: async (endpoint) =>
      JSON.parse(
        execFileSync('gh', ['api', endpoint], {
          encoding: 'utf8',
          stdio: 'pipe',
          timeout: 30_000,
          maxBuffer: 16 * 1024 ** 2,
        }),
      ),
  });
  console.log(`Source CI passed: ${result.url} (attempt ${result.attempt})`);
}
