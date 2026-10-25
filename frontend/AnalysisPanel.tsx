import { useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { AnalysisFinding, AnalysisReport, Project } from './types';

const rules: Record<string, string> = {
  'long-method': 'Длинный метод', 'deep-nesting': 'Глубокая вложенность',
  'constant-condition': 'Константное условие', 'nested-loops': 'Вложенные циклы',
};

export default function AnalysisPanel({ project, pendingChanges, onNavigate, onConflict }: {
  project: Project; pendingChanges: boolean; onConflict: () => void; onNavigate: (finding: AnalysisFinding) => void;
}) {
  const [report, setReport] = useState<AnalysisReport | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const current = useRef('');
  const unavailable = pendingChanges || project.graphRevision !== project.revision;
  current.current = `${project.id}:${project.revision}:${unavailable}`;
  const visible = report?.projectId === project.id ? report : null;
  const stale = unavailable || visible?.sourceRevision !== project.revision;

  async function analyze() {
    const key = current.current;
    setBusy(true); setError('');
    try {
      const next = await api.analyze(project.id, project.revision, project.fileId);
      if (current.current === key) setReport(next);
    } catch (reason) {
      if (current.current === key) {
        setError(reason instanceof Error ? reason.message : 'Анализ недоступен');
        if (reason instanceof ApiError && reason.status === 409) onConflict();
      }
    } finally { setBusy(false); }
  }

  return <section className="analysis-panel" aria-label="Диагностика и сложность">
    <div className="analysis-heading"><div><strong>Диагностика и сложность</strong>
      <p>Проверяемые правила · без ИИ</p></div>
      <button className="button secondary" disabled={busy || unavailable} onClick={() => void analyze()}>
        {busy ? 'Анализируем…' : 'Анализировать'}</button></div>
    {error && <p role="alert">{error}</p>}
    {unavailable && <p>Сохраните изменения и обновите граф перед анализом.</p>}
    {visible && <>
      <p role="status">{stale ? 'Анализ устарел. Повторите его после обновления графа.'
        : `Анализ ревизии ${visible.sourceRevision} · находок: ${visible.findings.length}`}</p>
      <details><summary>Правила и ограничения</summary><p>Длинный метод: больше {visible.thresholds.longMethodLines} физических строк, включая комментарии и пустые строки.
        Глубокая вложенность: от {visible.thresholds.deepNesting} уровней управляющих конструкций.
        Константное условие: только буквальное true/false в if, включая скобки.
        Вложенные циклы: цикл внутри другого цикла; это не доказательство квадратичной сложности.</p></details>
      <div className="analysis-results">
        <div className="analysis-findings"><h3>Находки</h3>
          {!visible.findings.length && <p>По поддержанным правилам проблем не найдено. Это не гарантия отсутствия дефектов.</p>}
          {visible.findings.map((finding, index) => <article key={index}>
            <span className="analysis-rule">{rules[finding.rule] ?? finding.rule} · строка {finding.range.startLine}</span>
            <button disabled={stale} onClick={() => onNavigate(finding)}>{finding.message}</button>
            <p>{finding.recommendation}</p>
          </article>)}
        </div>
        <div className="analysis-complexity"><h3>Оценка Big O</h3>
          {visible.methods.map(method => <article key={method.methodId}>
            <strong>{method.signature}</strong><span className="complexity-label">{method.complexity.label}</span>
            <p>{method.complexity.explanation}</p>
            {method.complexity.assumptions.length > 0 && <details><summary>Допущения оценки</summary>
              <ul>{method.complexity.assumptions.map(text => <li key={text}>{text}</li>)}</ul></details>}
          </article>)}
          {!visible.methods.length && <p>Нет методов с телом для оценки.</p>}
        </div>
      </div>
    </>}
  </section>;
}
