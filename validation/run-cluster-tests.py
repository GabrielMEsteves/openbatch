#!/usr/bin/env python3
"""Real end-to-end tests: login -> frontend -> backend -> SSH -> Slurm -> Podman.

Run through an SSH tunnel (http://127.0.0.1:8081) or HTTPS. No credentials are
written to the evidence files. These tests create real jobs in the debug queue.
"""
import argparse
import datetime
import getpass
import json
import os
from pathlib import Path
import time
import urllib.error
import urllib.parse
import urllib.request


SMOKE = '''from pathlib import Path
import json, os, platform
assert Path('/run/.containerenv').exists(), 'Processo fora de um container Podman'
assert os.getuid() == EXPECTED_UID, ('UID incorreto', os.getuid())
assert os.environ['SLURMD_NODENAME'] == EXPECTED_NODE, 'Executor incorreto'
assert len(os.sched_getaffinity(0)) == int(os.environ['SLURM_CPUS_PER_TASK']), 'CPU sem confinamento esperado'
data = dict(uid=os.getuid(), architecture=platform.machine(), node=os.environ['SLURMD_NODENAME'],
            job=os.environ['SLURM_JOB_ID'], cpus=sorted(os.sched_getaffinity(0)),
            cgroup=Path('/proc/self/cgroup').read_text())
Path('resultado.json').write_text(json.dumps(data, indent=2))
print('OPENBATCH_RESULT', json.dumps(data), flush=True)
'''

MONTE_CARLO = '''import concurrent.futures, json, math, os, random, time
from pathlib import Path
def sample(seed):
    rng = random.Random(seed)
    return sum(rng.random()**2 + rng.random()**2 <= 1 for _ in range(1000000))
if __name__ == '__main__':
    workers = int(os.environ['SLURM_CPUS_PER_TASK'])
    assert len(os.sched_getaffinity(0)) == workers
    start = time.monotonic()
    with concurrent.futures.ProcessPoolExecutor(max_workers=workers) as pool:
        hits = sum(pool.map(sample, range(4)))
    estimate = 4 * hits / 4000000
    assert abs(estimate - math.pi) < 0.01
    data = dict(hits=hits, samples=4000000, pi=estimate, seconds=time.monotonic()-start, workers=workers)
    Path('monte-carlo.json').write_text(json.dumps(data, indent=2))
    print('OPENBATCH_RESULT', json.dumps(data), flush=True)
'''

IO = '''from pathlib import Path
import hashlib, json
block = bytes(range(256)) * 4096
target = Path('dados.bin')
with target.open('wb') as out:
    for _ in range(32): out.write(block)
expected = hashlib.sha256(block * 32).hexdigest()
actual = hashlib.sha256(target.read_bytes()).hexdigest()
assert actual == expected
data = dict(bytes=target.stat().st_size, sha256=actual)
Path('checksum.json').write_text(json.dumps(data, indent=2))
print('OPENBATCH_RESULT', json.dumps(data), flush=True)
'''


class Client:
    def __init__(self, url):
        self.url, self.token = url.rstrip('/'), None

    def request(self, route, body=None):
        headers = {'Content-Type': 'application/json'}
        if self.token:
            headers['Authorization'] = f'Bearer {self.token}'
        request = urllib.request.Request(self.url + route, headers=headers,
                                         data=json.dumps(body).encode() if body is not None else None)
        try:
            with urllib.request.urlopen(request, timeout=60) as response:
                return json.load(response)
        except urllib.error.HTTPError as error:
            raise RuntimeError(f'HTTP {error.code}: {error.read().decode()[:2000]}') from None

    def wait(self, record, ready=None):
        deadline = time.monotonic() + 900
        while time.monotonic() < deadline:
            result = self.request(f"/api/container-jobs/{record['id']}")
            if ready and ready in result.get('stdout', ''):
                return result
            if result.get('terminal') and result.get('cleanup') in ('done', 'not-needed'):
                return result
            time.sleep(3)
        raise RuntimeError(f"Tempo esgotado: confira squeue/sacct para o job {record['jobId']}; não foi resubmetido")


def scientific_result(record):
    for line in record.get('stdout', '').splitlines():
        if line.startswith('OPENBATCH_RESULT '):
            return json.loads(line.removeprefix('OPENBATCH_RESULT '))
    raise AssertionError('Resultado científico ausente no stdout')


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--url', default='http://127.0.0.1:8081')
    parser.add_argument('--user', default='pesquisador')
    parser.add_argument('--uid', type=int, default=2000)
    parser.add_argument('--expected-node', default='worker1')
    parser.add_argument('--partition', default='debug')
    parser.add_argument('--cpus', type=int, default=2, help='CPUs for the parallel experiment; must fit the worker')
    parser.add_argument('--image', default='docker.io/library/python:3.12-slim')
    parser.add_argument('--suite', choices=['smoke', 'full'], default='smoke')
    parser.add_argument('--output', default='validation-results/' + datetime.datetime.now().strftime('%Y%m%d-%H%M%S'))
    args = parser.parse_args()
    url = urllib.parse.urlsplit(args.url)
    if url.scheme != 'https' and not (url.scheme == 'http' and url.hostname in ('127.0.0.1', 'localhost', '::1')):
        parser.error('Use HTTPS ou um túnel SSH para localhost; não envie a senha em HTTP público.')
    if args.cpus < 1:
        parser.error('--cpus deve ser positivo')
    os.umask(0o077)
    output = Path(args.output)
    output.mkdir(parents=True, exist_ok=False)
    client = Client(args.url)
    login = client.request('/login', dict(username=args.user, password=getpass.getpass('Senha Linux do cluster: ')))
    client.token = login['token']
    print('Login real confirmado. As evidências não incluem a senha nem o token.')
    image = args.image
    evidence = []

    def run(name, code, cpus=1, memory=512, limit='00:05:00', expected='COMPLETED', cancel=False):
        payload = dict(config=dict(name='tcc-' + name, partition=args.partition, cpus=cpus, memoryMiB=memory, time=limit),
                       container=dict(image=image, executable='python', args=['-u', '-c', code]))
        job = client.request('/api/container-jobs', payload)
        item = dict(test=name, submitted=job, expected=expected, passed=False)
        evidence.append(item)
        try:
            if not job.get('jobId'):
                raise RuntimeError(f"Submissão incerta ({job.get('id')}): confira squeue antes de repetir")
            print(f"{name}: Slurm job {job['jobId']}", flush=True)
            if cancel:
                ready = client.wait(job, ready='CANCEL_READY')
                assert 'CANCEL_READY' in ready.get('stdout', ''), 'Job terminou antes de testar cancelamento'
                client.request(f"/api/container-jobs/{job['id']}/cancel", {})
            result = client.wait(job)
            item['result'] = result
            assert result['node'] == args.expected_node, ('Nó inesperado', result['node'])
            assert result['cleanup'] == 'done', ('Limpeza não confirmada', result['cleanup'])
            if expected == 'OOM':
                assert 'OOM_READY' in result.get('stdout', '')
                assert result['state'] == 'OUT_OF_MEMORY' or (
                    result['state'] == 'FAILED' and 'oom' in result.get('stderr', '').lower())
            else:
                assert result['state'] == expected, (result['state'], result.get('stderr'))
            if expected == 'COMPLETED':
                assert result['exitCode'] == '0:0', result['exitCode']
                item['scientificResult'] = scientific_result(result)
            if name == 'exit-7':
                assert result['exitCode'].startswith('7:'), result['exitCode']
            item['passed'] = True
            return result
        except (AssertionError, RuntimeError, OSError) as error:
            item['error'] = str(error)
            raise
        finally:
            (output / f'{name}.json').write_text(json.dumps(item, indent=2, ensure_ascii=False), encoding='utf-8')
            (output / 'summary.json').write_text(json.dumps(evidence, indent=2, ensure_ascii=False), encoding='utf-8')

    smoke = run('smoke', f'EXPECTED_UID={args.uid}\nEXPECTED_NODE={args.expected_node!r}\n' + SMOKE)
    # Subsequent experiments use the same immutable manifest as the first job.
    digest = smoke.get('digest', '')
    if not digest.startswith('sha256:'):
        raise RuntimeError('Sem digest verificável; não prosseguir com testes de reprodutibilidade')
    repository = image.split('@')[0]
    if ':' in repository.rsplit('/', 1)[-1]:
        repository = repository.rsplit(':', 1)[0]
    image = f'{repository}@{digest}'
    if args.suite == 'full':
        serial = run('monte-carlo-1cpu', MONTE_CARLO)
        parallel = run('monte-carlo-paralelo', MONTE_CARLO, cpus=args.cpus)
        a, b = scientific_result(serial), scientific_result(parallel)
        comparison = dict(sameHits=a['hits'] == b['hits'], sameDigest=serial['digest'] == parallel['digest'],
                          serialSeconds=a['seconds'], parallelSeconds=b['seconds'],
                          observedSpeedup=a['seconds'] / b['seconds'])
        (output / 'reproducibility.json').write_text(json.dumps(comparison, indent=2), encoding='utf-8')
        assert comparison['sameHits'] and comparison['sameDigest'], 'Resultado ou imagem não reproduzível'
        run('io-checksum', IO)
        run('exit-7', 'raise SystemExit(7)', expected='FAILED')
        run('memoria', 'print("OOM_READY", flush=True); data=bytearray(768*1024*1024)', memory=256, expected='OOM')
        run('timeout', 'import time; time.sleep(180)', limit='00:01:00', expected='TIMEOUT')
        run('cancelamento', 'import time; print("CANCEL_READY", flush=True); time.sleep(240)', expected='CANCELLED', cancel=True)
    print(f'Testes concluídos: {len(evidence)}. Evidências em {output.resolve()}')


if __name__ == '__main__':
    main()
