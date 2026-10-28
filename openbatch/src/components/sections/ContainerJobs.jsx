import { useCallback, useEffect, useState } from 'react';

async function request(url, options = {}) {
  const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${localStorage.getItem('authToken')}`, ...options.headers } });
  const data = await response.json();
  if (!response.ok) throw new Error(data.message || 'Falha na operação.');
  return data;
}

export default function ContainerJobs({ onConsoleChange }) {
  const [form, setForm] = useState({ name: 'podman-demo', partition: '', cpus: 1, memoryMiB: 256, time: '00:02:00', image: 'docker.io/library/python:3.12-slim', executable: 'python', args: JSON.stringify(['-c', 'from pathlib import Path; Path("saida.txt").write_text("Executado pelo OpenBatch\\n"); print("Resultado salvo")']) });
  const [records, setRecords] = useState([]), [selected, setSelected] = useState(null);
  const [error, setError] = useState(''), [busy, setBusy] = useState(false);
  useEffect(() => {
    onConsoleChange({ selected, error, busy });
  }, [selected, error, busy, onConsoleChange]);
  const refreshList = useCallback(async () => setRecords(await request('/api/container-jobs')), []);
  useEffect(() => { refreshList().catch(e => setError(e.message)); }, [refreshList]);
  const selectedId = selected?.id;
  useEffect(() => {
    if (!selectedId) return;
    let active = true;
    const poll = async () => {
      try { const data = await request(`/api/container-jobs/${selectedId}`); if (active) setSelected(data); }
      catch (e) { if (active) setError(e.message); }
    };
    poll();
    const timer = setInterval(poll, 5000);
    return () => { active = false; clearInterval(timer); };
  }, [selectedId]);
  const submit = async e => {
    e.preventDefault(); setError(''); setSelected(null); setBusy(true);
    try {
      const args = JSON.parse(form.args);
      const data = await request('/api/container-jobs', { method: 'POST', body: JSON.stringify({ config: { name: form.name, partition: form.partition, cpus: Number(form.cpus), memoryMiB: Number(form.memoryMiB), time: form.time }, container: { image: form.image, executable: form.executable, args } }) });
      setSelected(data); await refreshList();
    } catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  const cancel = async () => {
    setBusy(true); setError('');
    try { await request(`/api/container-jobs/${selected.id}/cancel`, { method: 'POST' }); setSelected(await request(`/api/container-jobs/${selected.id}`)); }
    catch (e) { setError(e.message); }
    finally { setBusy(false); }
  };
  return <div className="content-box">
    <h2>Jobs com Podman</h2>
    <p>Uma tarefa em um nó. Os resultados são gravados no diretório resultados da submissão. Entre com sua conta Linux do cluster.</p>
    <form onSubmit={submit}>
      <div className="job-form-grid">
        {[['name', 'Nome'], ['partition', 'Partição (vazio: padrão do cluster)'], ['cpus', 'CPUs'], ['memoryMiB', 'Memória (MiB)'], ['time', 'Tempo (HH:MM:SS)'], ['image', 'Imagem com registry'], ['executable', 'Executável']].map(([key, label]) => <div className="form-group" key={key}>
          <label htmlFor={`podman-${key}`}>{label}</label>
          <input id={`podman-${key}`} type={['cpus', 'memoryMiB'].includes(key) ? 'number' : 'text'} min="1" required={key !== 'partition'} value={form[key]} onChange={e => setForm({ ...form, [key]: e.target.value })} disabled={busy} />
        </div>)}
      </div>
      <div className="form-group"><label htmlFor="podman-args">Argumentos (array JSON, um texto por argumento)</label><textarea id="podman-args" rows={4} value={form.args} onChange={e => setForm({ ...form, args: e.target.value })} disabled={busy} required /></div>
      <button className="primary-btn" disabled={busy}>{busy ? 'Aguarde...' : 'Submeter ao Slurm'}</button>
    </form>
    {error && <p role="alert">{error}</p>}
    <h3>Minhas submissões</h3>
    <button type="button" onClick={() => refreshList().catch(e => setError(e.message))}>Atualizar lista</button>
    <ul>{records.map(r => <li key={r.id}><button type="button" onClick={() => { setError(''); setSelected(r); }}>{r.job.config.name} — {r.jobId || 'ID não confirmado'} — {r.createdAt}</button></li>)}</ul>
    {selected && <section aria-live="polite">
      <h3>Job {selected.jobId || 'sem ID confirmado'}: {selected.state || 'Consultando'}</h3>
      {selected.message && <p>{selected.message}</p>}
      <p>Diretório no cluster: <code>{selected.directory}</code></p>
      <p>Nó: {selected.node || '—'} · Código de saída: {selected.exitCode || '—'} · Limpeza: {selected.cleanup || '—'}</p>
      {selected.digest && <p>Digest: <code>{selected.digest}</code></p>}
      <button type="button" disabled={busy || selected.terminal || !selected.jobId} onClick={cancel}>Cancelar job</button>
      {selected.script && <details><summary>Script gerado</summary><pre style={{ whiteSpace: 'pre-wrap' }}>{selected.script}</pre></details>}
    </section>}
  </div>;
}
