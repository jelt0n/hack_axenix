import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, Check, ChevronDown, ChevronUp, Clock3, FlaskConical, LoaderCircle, Play, Plus, X } from 'lucide-react';
import { api } from './api';
import type { AutomaticCheck, CheckJob, ProgramResult, Project, Scenario } from './types';

function entryPoint(project: Project): string {
  return project.entryPoints.length === 1 ? project.entryPoints[0] : '';
}

function statusLabel(job: CheckJob | null): string {
  if (!job) return 'Нет проверок';
  if (job.status === 'queued') return 'В очереди';
  if (job.status === 'running') return 'Выполняется';
  if (job.result?.verdict === 'matched') return 'Результаты совпали';
  if (job.result?.verdict === 'different') return 'Есть различия';
  if (job.result?.error?.kind === 'compile_error') return 'Ошибка компиляции';
  return 'Проверка не завершена';
}

function ConsoleResult({ title, result }: { title: string; result: ProgramResult | null }) {
  if (!result) return <div className="check-console"><h4>{title}</h4><p>Не выполнялась</p></div>;
  return <div className="check-console"><h4>{title}<span>{result.durationMs} мс · exit {result.exitCode ?? '—'}</span></h4>
    <div className="console-channel">STDOUT</div><pre aria-label={`${title}: stdout`}>{result.stdout || '(пусто)'}</pre>
    <div className="console-channel">STDERR</div><pre aria-label={`${title}: stderr`} className={result.stderr ? 'has-stderr' : ''}>{result.stderr || '(пусто)'}</pre>
    {result.exception && <div className="exception-summary">{result.exception.type}{result.exception.message ? ': ' + result.exception.message : ''}</div>}
    {result.stackTrace && <><div className="console-channel">СТЕК ИСКЛЮЧЕНИЯ</div>
      <pre aria-label={`${title}: стек исключения`}>{result.stackTrace}</pre></>}
    {result.status !== 'finished' && <div className="check-incomplete">{result.status}</div>}
  </div>;
}

export default function CheckPanel({ project, open, onToggle, pendingChanges = false, automaticCheck }: {
  project: Project; open: boolean; onToggle: () => void; pendingChanges?: boolean; automaticCheck?: AutomaticCheck | null;
}) {
  const [scenarios, setScenarios] = useState<Scenario[]>([{ name: 'Сценарий 1', stdin: '' }]);
  const [originalMainClass, setOriginalMainClass] = useState(project.originalEntryPoints.length === 1 ? project.originalEntryPoints[0] : '');
  const [mainClass, setMainClass] = useState(() => entryPoint(project));
  const [job, setJob] = useState<CheckJob | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [available, setAvailable] = useState(false);
  const lastAutomatic = useRef<number | null>(null);
  const requestGeneration = useRef(0);
  const displayedJobId = useRef<string | null>(null);
  const inferred = entryPoint(project);
  const previousInferred = useRef(inferred);
  const edited = useRef(false);
  const projectIdentity = useRef(project.id);
  projectIdentity.current = project.id;
  const currentProject = useRef(project);
  currentProject.current = project;
  const active = job?.status === 'queued' || job?.status === 'running';
  const stale = !!job && (pendingChanges || job.sourceRevision !== project.revision || job.projectId !== project.id
    || job.mainClass !== mainClass || (!!originalMainClass && job.originalMainClass !== originalMainClass) || JSON.stringify(job.scenarios) !== JSON.stringify(scenarios));

  useEffect(() => {
    let live = true;
    const generation = ++requestGeneration.current;
    edited.current = false;
    displayedJobId.current = null;
    setJob(null); setError(null); setSending(false);
    setMainClass(entryPoint(project));
    setOriginalMainClass(project.originalEntryPoints.length === 1 ? project.originalEntryPoints[0] : '');
    setScenarios([{ name: 'Сценарий 1', stdin: '' }]);
    api.latestCheck(project.id).then(latest => {
      if (!live || generation !== requestGeneration.current) return;
      displayedJobId.current = latest.id;
      setJob(latest);
      if (!edited.current) {
        setScenarios(latest.scenarios);
        setOriginalMainClass(latest.originalMainClass);
        setMainClass(latest.sourceRevision === currentProject.current.revision
          ? latest.mainClass : entryPoint(currentProject.current));
      }
    }).catch(() => {});
    return () => { live = false; };
  }, [project.id]);

  useEffect(() => {
    const previous = previousInferred.current;
    setMainClass(current => current === previous ? inferred : current);
    previousInferred.current = inferred;
  }, [inferred]);

  useEffect(() => {
    let live = true;
    const refresh = () => api.runner().then(state => { if (live) setAvailable(state.available); })
      .catch(() => { if (live) setAvailable(false); });
    void refresh();
    const timer = setInterval(() => { void refresh(); }, 3000);
    return () => { live = false; clearInterval(timer); };
  }, []);

  useEffect(() => {
    if (!job || !active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await api.check(job.id);
        if (live && displayedJobId.current === job.id) setJob(next);
      } catch (reason) {
        if (live && displayedJobId.current === job.id) setError(reason instanceof Error ? reason.message : 'Не удалось обновить проверку');
      }
      if (live) timer = setTimeout(poll, 900);
    };
    timer = setTimeout(poll, 900);
    return () => { live = false; clearTimeout(timer); };
  }, [job?.id, job?.status]);

  function updateScenario(index: number, change: Partial<Scenario>) {
    edited.current = true;
    setScenarios(items => items.map((item, i) => i === index ? { ...item, ...change } : item));
  }

  async function submit() {
    const generation = ++requestGeneration.current;
    edited.current = true;
    setSending(true); setError(null);
    try {
      const next = await api.createCheck(project, scenarios, mainClass, originalMainClass);
      if (projectIdentity.current === project.id && generation === requestGeneration.current) {
        displayedJobId.current = next.id;
        setJob(next);
      }
    } catch (reason) {
      if (projectIdentity.current === project.id && generation === requestGeneration.current) setError(reason instanceof Error ? reason.message : 'Не удалось создать проверку');
    } finally { if (projectIdentity.current === project.id && generation === requestGeneration.current) setSending(false); }
  }

  useEffect(() => {
    if (!automaticCheck || lastAutomatic.current === automaticCheck.sequence
        || automaticCheck.projectId !== project.id || automaticCheck.revision !== project.revision
        || pendingChanges) return;
    lastAutomatic.current = automaticCheck.sequence;
    void submit();
  }, [automaticCheck, project.id, project.revision, pendingChanges]);

  const tone = stale ? 'stale' : job?.result?.verdict === 'matched' ? 'matched'
    : job?.result?.verdict === 'different' ? 'different' : '';
  return <section className={`checks-panel ${open ? 'expanded' : ''}`} id="checks-panel" aria-label="Проверка поведения">
    <div className="checks-heading"><button className="checks-toggle" aria-expanded={open} onClick={onToggle}>
      <FlaskConical size={17} /><strong>Консоль · Проверка поведения</strong>{open ? <ChevronUp size={15} /> : <ChevronDown size={15} />}
    </button><span className={`check-status ${tone}`} data-testid="check-status" aria-live="polite">
      {active ? <LoaderCircle size={12} className="spin" /> : job?.result?.verdict === 'matched' && !stale ? <Check size={12} /> : <Clock3 size={12} />}
      {stale ? pendingChanges || job?.sourceRevision !== project.revision ? 'Результат предыдущей версии' : 'Результат предыдущих входов' : statusLabel(job)}
    </span></div>
    {open && <div className="checks-body">
      <div className="checks-form"><div className="terminal-heading">JAVA CONSOLE · STDIN / STDOUT / STDERR</div><div className="checks-intro">Ввод задаётся перед запуском; вывод появится после выполнения. Одинаковые входы для исходной и рабочей версий. Проверка относится к ревизии {project.revision}.</div>
        <label className="check-entry">Класс с main<input value={mainClass} placeholder="com.example.Main" aria-label="Класс с main"
          onChange={event => { edited.current = true; setMainClass(event.target.value); }} /></label>
        <label className="check-entry">Исходный класс с main<input value={originalMainClass} placeholder="Определить автоматически" aria-label="Исходный класс с main"
          onChange={event => { edited.current = true; setOriginalMainClass(event.target.value); }} /></label>
        {scenarios.map((scenario, index) => <div className="scenario-form" key={index}>
          <div><input aria-label={`Имя сценария ${index + 1}`} value={scenario.name} maxLength={80}
            onChange={event => updateScenario(index, { name: event.target.value })} />
          {scenarios.length > 1 && <button className="icon-button" aria-label={`Удалить сценарий ${index + 1}`} onClick={() => {
            edited.current = true; setScenarios(items => items.filter((_, i) => i !== index));
          }}><X size={13} /></button>}</div>
          <label className="stdin-label">STDIN · сценарий {index + 1}<textarea aria-label={`Ввод сценария ${index + 1}`} placeholder="stdin · можно оставить пустым" value={scenario.stdin} maxLength={32768}
            onChange={event => updateScenario(index, { stdin: event.target.value })} rows={4} /></label>
        </div>)}
        <div className="scenario-actions"><button className="button secondary" disabled={scenarios.length >= 5} onClick={() => {
          edited.current = true; setScenarios(items => [...items, { name: `Сценарий ${items.length + 1}`, stdin: '' }]);
        }}><Plus size={13} />Сценарий</button>
          <button className="button primary" aria-label="Запустить проверку" onClick={() => void submit()}
            disabled={pendingChanges || sending || active || !mainClass.trim() || scenarios.some(s => !s.name.trim())}>
            {sending || active ? <LoaderCircle size={14} className="spin" /> : <Play size={14} />}Запустить проверку</button></div>
        <div className={`runner-availability ${available ? 'online' : ''}`}><i />{available ? 'Исполнитель готов' : 'Исполнитель недоступен. Задание останется в очереди.'}</div>
        {pendingChanges && <div className="check-warning">Сохраните черновики файлов кнопкой «Обновить граф». Несохранённый файл нужно открыть в проводнике.</div>}
      </div>
      <div className="checks-output" data-testid="check-results">
        {error && <div className="check-error" role="alert"><AlertTriangle size={15} /><span>{error}</span></div>}
        {job && stale && <div className="check-warning">Входы или версия изменены. Ниже — результат для сохранённого снимка проверки.</div>}
        {!job || !job.result ? <div className="checks-empty"><FlaskConical size={25} /><strong>Результата пока нет</strong>
          <span>{job?.status === 'queued' ? `Позиция в очереди: ${job.queuePosition ?? '—'}. Ждём свободного исполнителя.`
            : job?.status === 'running' ? `Выполняется: ${job.phase.replace('original:', 'исходная версия, сценарий ').replace('working:', 'рабочая версия, сценарий ')}`
            : 'Добавьте входы и запустите обе версии программы.'}</span></div>
          : <>
            <div className={`verdict ${tone}`}><strong>{statusLabel(job)}</strong><span>Ревизия {job.sourceRevision} · {job.scenarios.length} сценариев</span></div>
            {job.result.error && <div className="check-error" role="alert"><AlertTriangle size={15} /><span>{job.result.error.message}</span></div>}
            {job.result.cases.map((item, index) => <details key={index} className="case-result" open={index === 0}>
              <summary>{item.name}<span>{item.original?.status !== 'finished' || item.working?.status !== 'finished' ? 'Не завершён' : item.matches ? 'Совпало' : 'Различается'}</span></summary>
              <div className="case-input"><span>ВХОД ЭТОЙ ПРОВЕРКИ</span><pre>{item.stdin || '(пустой ввод)'}</pre></div>
              <div className="result-pair"><ConsoleResult title="Исходная версия" result={item.original} /><ConsoleResult title="Рабочая версия" result={item.working} /></div>
            </details>)}
            <p className="check-scope">Совпадение на выбранных сценариях не доказывает эквивалентность для всех возможных входов.</p>
          </>}
      </div>
    </div>}
  </section>;
}
