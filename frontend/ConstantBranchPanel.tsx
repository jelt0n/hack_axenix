import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { BranchPreview, GraphNode, MethodGraph, Project } from './types';

export default function ConstantBranchPanel({ project, graph, selected, disabled, onApply, onConflict }: {
  project: Project; graph: MethodGraph | null; selected: GraphNode | null; disabled: boolean;
  onApply: (preview: BranchPreview) => Promise<void>; onConflict: () => void;
}) {
  const [preview, setPreview] = useState<BranchPreview | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const selection = graph?.nodes.find(node => node.id === selected?.id);
  const identity = `${project.id}:${project.revision}:${graph?.methodId}:${selection?.id}:${disabled}`;
  const current = useRef(identity); current.current = identity;
  useEffect(() => { setPreview(null); setError(''); }, [identity]);
  const valid = preview?.projectId === project.id && preview.sourceRevision === project.revision
    && preview.methodId === graph?.methodId && preview.nodeId === selection?.id;

  async function prepare() {
    if (!graph || !selection || disabled) return;
    const key = current.current;
    setBusy(true); setError('');
    try {
      const next = await api.previewBranch(project.id, project.revision, graph.methodId, selection.id);
      if (current.current === key) setPreview(next);
    } catch (reason) {
      if (current.current === key) {
        setError(reason instanceof Error ? reason.message : 'Не удалось подготовить преобразование');
        if (reason instanceof ApiError && reason.status === 409) onConflict();
      }
    } finally { setBusy(false); }
  }

  return <section className="constant-branch-panel" aria-label="Упрощение константной ветки">
    <div className="analysis-heading"><div><strong>Упрощение константной ветки</strong>
      <p>Выберите условие if с буквальным true или false. Сначала покажем изменение.</p></div>
      <button className="button secondary" disabled={disabled || busy || !selection?.constantBranch}
        onClick={() => void prepare()}>{busy ? 'Готовим…' : 'Предпросмотр упрощения'}</button></div>
    {error && <p role="alert">{error}</p>}
    {preview && valid && !disabled && <div role="dialog" aria-label="Предпросмотр упрощения" className="branch-preview">
      <p>Выбранная ветка сохранится в отдельном блоке. После подтверждения запустится проверка на сценариях из раздела «Проверка поведения».</p>
      <div className="branch-preview-code"><div><h3>До</h3><pre aria-label="Код до упрощения">{preview.before}</pre></div>
        <div><h3>После</h3><pre aria-label="Код после упрощения">{preview.after}</pre></div></div>
      <p>Совпадение будет подтверждено только после компиляции и выполнения на выбранных входах.</p>
      <div className="graph-edit-actions"><button className="button primary" onClick={() => void onApply(preview)}>Применить и проверить</button>
        <button className="button secondary" onClick={() => setPreview(null)}>Отмена</button></div>
    </div>}
  </section>;
}
