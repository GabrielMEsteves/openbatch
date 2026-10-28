import { execFile, spawn } from 'node:child_process';
import { promisify } from 'node:util';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import process from 'node:process';

const exec = promisify(execFile);
export async function authenticateClusterUser(user, password) {
  if (!/^[a-z_][a-z0-9_-]*[$]?$/i.test(user) || typeof password !== 'string' || password.includes('\0')) throw new Error('Credenciais inválidas.');
  const host = process.env.SLURM_SSH_HOST;
  if (!/^[a-zA-Z0-9._-]+$/.test(host || '')) throw new Error('Host SSH inválido.');
  await exec('ssh', ['-T', '-o', 'StrictHostKeyChecking=yes', '-o', `UserKnownHostsFile=${process.env.SLURM_SSH_KNOWN_HOSTS || '/run/slurm-ssh/known_hosts'}`, '-o', 'PreferredAuthentications=password,keyboard-interactive', '-o', 'PubkeyAuthentication=no', '-o', 'NumberOfPasswordPrompts=1', '-o', 'ConnectTimeout=10', `${user}@${host}`, 'true'], {
    timeout: 20000,
    env: { ...process.env, DISPLAY: 'openbatch:0', SSH_ASKPASS_REQUIRE: 'force', SSH_ASKPASS: fileURLToPath(new URL('./ssh-askpass.sh', import.meta.url)), OPENBATCH_LOGIN_PASSWORD: password },
  });
}
const terminal = new Set(['COMPLETED', 'FAILED', 'CANCELLED', 'TIMEOUT', 'OUT_OF_MEMORY', 'NODE_FAIL', 'PREEMPTED', 'BOOT_FAIL', 'DEADLINE', 'REVOKED']);
export const quote = value => `'${String(value).replaceAll("'", "'\\''")}'`;

export function validateJob(body) {
  const c = body?.config || {}, image = body?.container?.image;
  const executable = body?.container?.executable, args = body?.container?.args;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(c.name || '')) throw new Error('Nome inválido.');
  if (c.partition && !/^[A-Za-z0-9_-]{1,64}$/.test(c.partition)) throw new Error('Partição inválida.');
  for (const [key, max] of [['cpus', 1024], ['memoryMiB', 1048576]]) {
    if (!Number.isInteger(c[key]) || c[key] < 1 || c[key] > max) throw new Error(`${key} inválido.`);
  }
  if (!/^\d{1,3}:[0-5]\d:[0-5]\d$/.test(c.time || '') || c.time === '00:00:00') throw new Error('Tempo inválido: use HH:MM:SS.');
  if (typeof image !== 'string' || image.length > 512 || !/^[a-zA-Z0-9][a-zA-Z0-9.:_-]*\/[a-zA-Z0-9/.:_@-]+$/.test(image)) throw new Error('Informe imagem com registry completo.');
  if (typeof executable !== 'string' || !executable || executable.startsWith('-') || executable.length > 1024 || [...executable].some(char => char.charCodeAt(0) < 32)) throw new Error('Executável inválido.');
  if (!Array.isArray(args) || args.length > 128 || args.some(a => typeof a !== 'string' || a.length > 16384 || a.includes('\0'))) throw new Error('Argumentos devem ser um array JSON de textos.');
  return { config: c, container: { image, executable, args } };
}

export function generateScript(job, containerName) {
  const { config: c, container: p } = validateJob(job);
  return `#!/bin/bash
#SBATCH --job-name=${c.name}
${c.partition ? `#SBATCH --partition=${c.partition}\n` : ''}#SBATCH --nodes=1
#SBATCH --ntasks=1
#SBATCH --cpus-per-task=${c.cpus}
#SBATCH --mem=${c.memoryMiB}M
#SBATCH --time=${c.time}
#SBATCH --output=stdout.log
#SBATCH --error=stderr.log
set -euo pipefail
# sbatch --chdir selects this submission's isolated directory.
umask 077
mkdir -p resultados
hostname > execution-node
finish() {
  rc=$?
  trap - EXIT
  printf '%s\\n' "$rc" > exit-code
  podman rm -f ${quote(containerName)} >/dev/null 2>&1 || true
  exit "$rc"
}
trap finish EXIT
podman pull ${quote(p.image)}
podman image inspect --format '{{.Digest}}' ${quote(p.image)} > image-digest
srun podman --cgroup-manager=cgroupfs run --rm --name ${quote(containerName)} \\
  --cgroups=disabled --userns=keep-id --network=none \\
  --volume "$PWD/resultados:/resultados:rw" --workdir /resultados \\
  --entrypoint ${quote(p.executable)} ${quote(p.image)} ${p.args.map(quote).join(' ')}
`;
}

// Commands always execute under the authenticated Linux account. No shell interpolation.
async function asUser(user, command, args = [], input) {
  if (process.env.SLURM_SSH_HOST) {
    const host = process.env.SLURM_SSH_HOST;
    if (!/^[a-zA-Z0-9._-]+$/.test(host)) throw new Error('SLURM_SSH_HOST inválido.');
    const key = path.join(process.env.SLURM_SSH_KEY_DIR || '/run/slurm-ssh', `${user}.key`);
    const remote = `exec ${[command, ...args].map(quote).join(' ')}`;
    const sshArgs = ['-T', '-o', 'BatchMode=yes', '-o', 'StrictHostKeyChecking=yes', '-o', 'ConnectTimeout=10', '-o', `UserKnownHostsFile=${process.env.SLURM_SSH_KNOWN_HOSTS || '/run/slurm-ssh/known_hosts'}`, '-i', key, `${user}@${host}`, remote];
    if (input === undefined) return exec('ssh', sshArgs, { timeout: 20000, maxBuffer: 1024 * 1024 });
    return new Promise((resolve, reject) => {
      const child = spawn('ssh', sshArgs);
      let stdout = '', stderr = '';
      const timer = setTimeout(() => child.kill(), 20000);
      child.stdout.on('data', d => { stdout += d; });
      child.stderr.on('data', d => { stderr += d; });
      child.stdin.on('error', () => {});
      child.on('error', e => { clearTimeout(timer); reject(e); });
      child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `SSH terminou com ${code}`)); });
      child.stdin.end(input);
    });
  }
  const account = (await exec('getent', ['passwd', user])).stdout.trim().split(':');
  if (account.length < 7 || Number(account[2]) === 0) throw new Error('Conta Linux inválida.');
  const env = { ...process.env, HOME: account[5], USER: user, LOGNAME: user, XDG_RUNTIME_DIR: `/run/user/${account[2]}` };
  for (const key of ['JWT_SECRET', 'ADMIN_PASSWORD', 'CONTAINER_HOST', 'CONTAINER_CONNECTION', 'CONTAINERS_CONF', 'CONTAINERS_CONF_OVERRIDE']) delete env[key];
  const argv = ['-u', user, '--', 'env', `HOME=${env.HOME}`, `USER=${user}`, `LOGNAME=${user}`, `XDG_RUNTIME_DIR=${env.XDG_RUNTIME_DIR}`, command, ...args];
  if (input === undefined) return exec('runuser', argv, { env, timeout: 15000, maxBuffer: 1024 * 1024 });
  return new Promise((resolve, reject) => {
    const child = spawn('runuser', argv, { env });
    let stdout = '', stderr = '';
    const timer = setTimeout(() => child.kill(), 15000);
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.stdin.on('error', () => {});
    child.on('close', code => { clearTimeout(timer); code === 0 ? resolve({ stdout, stderr }) : reject(new Error(stderr || `Comando terminou com ${code}`)); });
    child.stdin.end(input);
  });
}

export function installPodmanJobs(app, authenticate) {
  const store = process.env.OPENBATCH_JOB_STORE || '/var/lib/openbatch/podman-jobs';
  const save = async record => {
    await fs.mkdir(store, { recursive: true, mode: 0o700 });
    const temporary = path.join(store, `${record.id}.${randomUUID()}.tmp`);
    await fs.writeFile(temporary, JSON.stringify(record), { mode: 0o600 });
    await fs.rename(temporary, path.join(store, `${record.id}.json`));
  };
  const load = async (id, user) => {
    if (!/^[a-f0-9-]{36}$/.test(id)) throw new Error('Submissão inválida.');
    const record = JSON.parse(await fs.readFile(path.join(store, `${id}.json`), 'utf8'));
    if (record.user !== user) throw new Error('Submissão não pertence ao usuário.');
    return record;
  };
  const read = async (r, file) => {
    try { return (await asUser(r.user, 'tail', ['-c', '65536', '--', path.join(r.directory, file)])).stdout; }
    catch { return ''; }
  };
  const snapshot = async r => {
    if (!r.jobId) return { ...r, state: 'SUBMISSION_UNCERTAIN', message: 'Verifique a fila antes de repetir a submissão.' };
    let state = r.terminal ? r.state : 'UNKNOWN', node = r.node || '', exitCode = r.exitCode || '';
    if (!r.terminal) {
    try {
      const output = (await asUser(r.user, 'scontrol', ['show', 'job', r.jobId, '-o'])).stdout;
      state = output.match(/JobState=(\S+)/)?.[1] || state;
      node = output.match(/NodeList=(\S+)/)?.[1] || '';
      exitCode = output.match(/ExitCode=(\S+)/)?.[1] || '';
    } catch {
      try {
        const rows = (await asUser(r.user, 'sacct', ['-j', r.jobId, '-n', '-P', '--format=JobIDRaw,State,ExitCode,NodeList'])).stdout.split('\n');
        const row = rows.find(line => line.split('|')[0] === r.jobId);
        if (row) [, state, exitCode, node] = row.split('|');
        state = state.split(/[ +]/)[0];
      } catch { /* Accounting may not be installed; never invent a terminal state. */ }
    }
    }
    const stdout = await read(r, 'stdout.log'), stderr = await read(r, 'stderr.log');
    let cleanup = r.cleanup || 'pending';
    if (terminal.has(state) && cleanup !== 'done') {
      const executionNode = (await read(r, 'execution-node')).trim();
      if (!executionNode) cleanup = 'not-needed';
      else if (executionNode === (process.env.SLURM_SSH_HOST ? (await asUser(r.user, 'hostname')).stdout.trim() : os.hostname())) {
        try { await asUser(r.user, 'podman', ['rm', '-f', '--ignore', r.containerName]); cleanup = 'done'; }
        catch { cleanup = 'failed'; }
      } else cleanup = 'remote-node-required';
    }
    if (terminal.has(state)) await save({ ...r, state, node, exitCode, terminal: true, cleanup });
    return { ...r, state, node, exitCode, terminal: terminal.has(state), cleanup, stdout, stderr, digest: (await read(r, 'image-digest')).trim() };
  };
  const route = fn => async (req, res) => {
    try {
      if (req.user === 'admin' || !/^[a-z_][a-z0-9_-]*[$]?$/i.test(req.user)) return res.status(403).json({ message: 'Entre com uma conta Linux real para submeter jobs.' });
      await fn(req, res);
    } catch (error) { res.status(400).json({ message: error.stderr?.trim() || error.message }); }
  };
  app.post('/api/container-jobs', authenticate, route(async (req, res) => {
    const job = validateJob(req.body);
    const id = randomUUID(), containerName = `openbatch-${id}`;
    const account = (await asUser(req.user, 'getent', ['passwd', req.user])).stdout.trim().split(':');
    if (account.length < 7 || !account[5].startsWith('/') || Number(account[2]) === 0) throw new Error('Conta Linux inválida no cluster.');
    const base = path.join(account[5], '.openbatch_jobs');
    await asUser(req.user, 'mkdir', ['-p', '--', base]);
    const directory = (await asUser(req.user, 'mktemp', ['-d', `${base}/podman-XXXXXXXX`])).stdout.trim();
    const script = generateScript(job, containerName);
    await asUser(req.user, 'tee', [path.join(directory, 'job.sbatch')], script);
    const record = { id, user: req.user, directory, containerName, job, createdAt: new Date().toISOString() };
    await save(record);
    try {
      const result = await asUser(req.user, 'sbatch', ['--parsable', '--chdir', directory, path.join(directory, 'job.sbatch')]);
      const match = result.stdout.trim().match(/^(\d+)(?:;[^\s]+)?$/);
      if (!match) throw new Error('Resposta inesperada do sbatch.');
      record.jobId = match[1];
      await save(record);
      res.status(201).json({ ...record, state: 'SUBMITTED', script });
    } catch {
      res.status(202).json({ ...record, state: 'SUBMISSION_UNCERTAIN', message: 'O resultado da submissão é incerto. Verifique squeue antes de repetir.' });
    }
  }));
  app.get('/api/container-jobs', authenticate, route(async (req, res) => {
    let files = [];
    try { files = await fs.readdir(store); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    const records = await Promise.all(files.filter(f => f.endsWith('.json')).map(async f => JSON.parse(await fs.readFile(path.join(store, f), 'utf8'))));
    res.json(records.filter(r => r.user === req.user).sort((a, b) => b.createdAt.localeCompare(a.createdAt)));
  }));
  app.get('/api/container-jobs/:id', authenticate, route(async (req, res) => res.json(await snapshot(await load(req.params.id, req.user)))));
  app.post('/api/container-jobs/:id/cancel', authenticate, route(async (req, res) => {
    const r = await load(req.params.id, req.user);
    if (!r.jobId) throw new Error('Submissão sem identificador confirmado.');
    await asUser(req.user, 'scancel', [r.jobId]);
    res.json({ message: 'Cancelamento solicitado; aguarde confirmação do Slurm.' });
  }));
  // Reconciliation continues after the browser disconnects or the backend restarts.
  let monitoring = false;
  const monitor = async () => {
    if (monitoring) return;
    monitoring = true;
    try {
      let files;
      try { files = await fs.readdir(store); } catch (e) { if (e.code === 'ENOENT') return; throw e; }
      for (const file of files.filter(f => f.endsWith('.json'))) {
        const record = JSON.parse(await fs.readFile(path.join(store, file), 'utf8'));
        if (record.jobId && !(record.terminal && ['done', 'not-needed', 'remote-node-required'].includes(record.cleanup))) {
          await snapshot(record).catch(e => console.error(`Reconciliação ${record.id}: ${e.message}`));
        }
      }
    } catch (e) { console.error(`Monitor Podman: ${e.message}`); }
    finally { monitoring = false; }
  };
  setInterval(monitor, 15000).unref();
}
