// Execute dentro do backend, passando o conteúdo por stdin. Não imprime tokens.
import jwt from 'jsonwebtoken';
import assert from 'node:assert/strict';
const token = jwt.sign({ username: 'julia' }, process.env.JWT_SECRET, { expiresIn: '5m' });
const base = 'http://frontend';
async function api(route, method = 'GET', body) {
  const r = await fetch(base + route, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
  const data = await r.json();
  assert.ok(r.ok, JSON.stringify(data));
  return data;
}
assert.equal((await fetch(base + '/api/container-jobs')).status, 401);
const job = await api('/api/container-jobs', 'POST', {
  config: { name: 'openbatch-api-smoke', partition: 'debug', cpus: 1, memoryMiB: 256, time: '00:02:00' },
  container: { image: 'docker.io/library/python:3.12-slim', executable: 'python', args: ['-c', 'from pathlib import Path; import os; Path("saida.txt").write_text("ok\\n"); print("UID", os.getuid()); print(Path("/proc/self/cgroup").read_text())'] },
});
assert.ok(job.jobId, JSON.stringify(job));
console.log('Submetido via frontend → backend Docker → SSH → sbatch:', job.jobId);
for (let i = 0; i < 30; i++) {
  const result = await api(`/api/container-jobs/${job.id}`);
  if (result.terminal) {
    console.log(JSON.stringify({ jobId: result.jobId, state: result.state, exitCode: result.exitCode, cleanup: result.cleanup, directory: result.directory, stdout: result.stdout, stderr: result.stderr }));
    assert.equal(result.state, 'COMPLETED');
    assert.match(result.stdout, /UID 1000/);
    assert.match(result.stdout, /slurmstepd.scope\/job_/);
    assert.equal(result.cleanup, 'done');
    break;
  }
  assert.ok(i < 29, 'Timeout aguardando job');
  await new Promise(resolve => setTimeout(resolve, 2000));
}

async function waitFor(id, predicate) {
  for (let i = 0; i < 40; i++) {
    const r = await api(`/api/container-jobs/${id}`);
    if (predicate(r)) return r;
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error('Timeout no teste integrado');
}
const payload = code => ({ config: { name: 'openbatch-api-check', partition: 'debug', cpus: 1, memoryMiB: 256, time: '00:02:00' }, container: { image: 'docker.io/library/python:3.12-slim', executable: 'python', args: ['-c', code] } });
const oom = await api('/api/container-jobs', 'POST', payload('print("oom test", flush=True); data = bytearray(512*1024*1024)'));
assert.ok(oom.jobId);
const oomResult = await waitFor(oom.id, r => r.terminal);
assert.ok(['OUT_OF_MEMORY', 'FAILED'].includes(oomResult.state));
assert.match(oomResult.stderr, /oom|Out Of Memory/i);
console.log('Limite de memória pela API:', oomResult.jobId, oomResult.state, oomResult.cleanup);
const cancelJob = await api('/api/container-jobs', 'POST', payload('import time; print("cancel test ready", flush=True); time.sleep(90)'));
assert.ok(cancelJob.jobId);
await waitFor(cancelJob.id, r => r.stdout.includes('cancel test ready'));
await api(`/api/container-jobs/${cancelJob.id}/cancel`, 'POST');
const cancelled = await waitFor(cancelJob.id, r => r.terminal);
assert.equal(cancelled.state, 'CANCELLED');
assert.equal(cancelled.cleanup, 'done');
console.log('Cancelamento e reconciliação pela API:', cancelled.jobId, cancelled.state, cancelled.cleanup);
