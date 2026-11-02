import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { validateJob, generateScript, quote, validCleanupReceipt, getSlurmStatus } from './podman-jobs.js';

const job = { config: { name: 'demo', partition: 'debug', cpus: 1, memoryMiB: 256, time: '00:02:00' }, container: { image: 'docker.io/library/python:3.12-slim', executable: 'python', args: ['-c', "print('ok')"] } };

test('status reads allocated NodeList instead of requested or excluded nodes', async () => {
  const result = await getSlurmStatus({ jobId: '4' }, async () => ({
    stdout: 'JobId=4 JobState=COMPLETED ExitCode=0:0 ReqNodeList=(null) ExcNodeList=worker2 NodeList=worker1 BatchHost=node\n',
  }));
  assert.deepEqual(result, { state: 'COMPLETED', node: 'worker1', exitCode: '0:0' });
});

test('pending jobs do not report requested nodes as allocated nodes', async () => {
  for (const allocation of ['', ' NodeList=(null)']) {
    const result = await getSlurmStatus({ jobId: '4' }, async () => ({
      stdout: `JobState=PENDING ReqNodeList=worker1 ExcNodeList=(null)${allocation} ExitCode=0:0`,
    }));
    assert.equal(result.state, 'PENDING');
    assert.equal(result.node, '');
  }
});

test('old terminal records with null nodes are refreshed from the controller', async () => {
  const result = await getSlurmStatus({ jobId: '4', terminal: true, state: 'COMPLETED', node: '(null)', exitCode: '0:0' }, async command => {
    assert.equal(command, 'scontrol');
    return { stdout: 'JobState=COMPLETED ReqNodeList=(null) NodeList=worker1 ExitCode=0:0' };
  });
  assert.equal(result.node, 'worker1');
});

test('old terminal records recover from accounting after controller expiry', async () => {
  const calls = [];
  const result = await getSlurmStatus({ jobId: '4', terminal: true, state: 'COMPLETED', node: '(null)' }, async (command, args) => {
    calls.push(command);
    assert.ok(args.includes('4'));
    if (command === 'scontrol') throw new Error('Invalid job id');
    return { stdout: '4.batch|COMPLETED|0:0|wrong-node|\n4|COMPLETED|0:0|worker1|\n' };
  });
  assert.deepEqual(calls, ['scontrol', 'sacct']);
  assert.deepEqual(result, { state: 'COMPLETED', node: 'worker1', exitCode: '0:0' });
});

test('missing scheduler data does not invent a node or a terminal state', async () => {
  const run = async () => { throw new Error('Unavailable'); };
  assert.deepEqual(await getSlurmStatus({ jobId: '4' }, run), { state: 'UNKNOWN', node: '', exitCode: '' });
  assert.deepEqual(await getSlurmStatus({ jobId: '4', terminal: true, state: 'COMPLETED', node: '(null)', exitCode: '0:0' }, run),
    { state: 'COMPLETED', node: '', exitCode: '0:0' });
});

test('valid terminal status remains cached', async () => {
  const result = await getSlurmStatus({ jobId: '4', terminal: true, state: 'COMPLETED', node: 'worker1', exitCode: '0:0' }, async () => {
    assert.fail('A valid terminal record should not query Slurm again');
  });
  assert.deepEqual(result, { state: 'COMPLETED', node: 'worker1', exitCode: '0:0' });
});
test('rejects injected directives and invalid numeric resources', () => {
  for (const config of [{ name: 'x\n#SBATCH --uid=root' }, { partition: 'debug\nfoo' }, { cpus: 0 }, { memoryMiB: '256' }, { time: '00:99:00' }]) assert.throws(() => validateJob({ ...job, config: { ...job.config, ...config } }));
});
test('rejects option-like image/executable and unstructured arguments', () => {
  for (const container of [{ image: '--privileged' }, { executable: '-c' }, { args: 'echo foo' }, { args: ['\0'] }]) assert.throws(() => validateJob({ ...job, container: { ...job.container, ...container } }));
});
test('shell quoting preserves hostile arguments without execution', () => {
  const argument = "a' $(touch /tmp/openbatch-should-not-exist) `id`\nline";
  const result = execFileSync('bash', ['-c', `printf '%s' ${quote(argument)}`], { encoding: 'utf8' });
  assert.equal(result, argument);
});
test('generated script parses and preserves Slurm control', () => {
  const script = generateScript(job, 'openbatch-test');
  execFileSync('bash', ['-n'], { input: script });
  assert.match(script, /srun --cpus-per-task="\$SLURM_CPUS_PER_TASK" --cpu-bind=cores podman/);
  assert.match(script, /--cgroups=disabled/);
  assert.match(script, /#SBATCH --mem=256M/);
  assert.doesNotMatch(script, /--privileged|--cgroupns=/);
  assert.match(script, /--pull=never/);
  assert.match(script, /--entrypoint 'python' "\$image_id"/);
  assert.match(script, /io.openbatch.slurm-job=\$SLURM_JOB_ID/);
  assert.match(script, /export XDG_RUNTIME_DIR="\/run\/user\//);
});

test('cleanup receipts must match the job, execution node and current submission', () => {
  const record = { jobId: '42', createdAt: '2026-01-02T00:00:00Z' };
  const receipt = { jobId: '42', node: 'worker1', status: 'done', finishedAt: '2026-01-02T00:01:00Z' };
  assert.equal(validCleanupReceipt(JSON.stringify(receipt), record, 'worker1'), true);
  for (const override of [{ jobId: '43' }, { node: 'master' }, { status: 'failed' }, { finishedAt: '2025-01-01T00:00:00Z' }, { finishedAt: 'invalid' }]) {
    assert.equal(validCleanupReceipt(JSON.stringify({ ...receipt, ...override }), record, 'worker1'), false);
  }
  assert.equal(validCleanupReceipt('not json', record, 'worker1'), false);
});

test('container names cannot inject shell commands', () => {
  assert.throws(() => generateScript(job, "openbatch-'; id"));
});
