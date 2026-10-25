import { api } from './api';
import useTransformationPreview from './useTransformationPreview';
import type { BranchPreview, GraphNode, MethodGraph, Project } from './types';

export default function ConstantBranchPanel({ project, graph, selected, disabled, onApply, onConflict }: {
  project: Project; graph: MethodGraph | null; selected: GraphNode | null; disabled: boolean;
  onApply: (preview: BranchPreview) => Promise<void>; onConflict: () => void;
}) {
  const selection = graph?.nodes.find(node => node.id === selected?.id);
  const identity = `${project.id}:${project.revision}:${graph?.methodId}:${selection?.id}:${disabled}`;
  const {preview,busy,error,prepare,cancel}=useTransformationPreview<BranchPreview>(identity,onConflict);
  const valid = preview?.projectId === project.id && preview.sourceRevision === project.revision
    && preview.methodId === graph?.methodId && preview.nodeId === selection?.id;

  return <section className="constant-branch-panel" aria-label="Упрощение константной ветки">
    <div className="analysis-heading"><div><strong>Упрощение константной ветки</strong>
      <p>Выберите условие if с буквальным true или false. Сначала покажем изменение.</p></div>
      <button className="button secondary" disabled={disabled || busy || !selection?.constantBranch}
        onClick={() => void prepare(() => api.previewBranch(project.id,project.revision,graph!.methodId,selection!.id,project.fileId))}>{busy ? 'Готовим…' : 'Предпросмотр упрощения'}</button></div>
    {error && <p role="alert">{error}</p>}
    {preview && valid && !disabled && <div role="dialog" aria-label="Предпросмотр упрощения" className="branch-preview">
      <p>Выбранная ветка сохранится в отдельном блоке. После подтверждения запустится проверка на сценариях из раздела «Проверка поведения».</p>
      <div className="branch-preview-code"><div><h3>До</h3><pre aria-label="Код до упрощения">{preview.before}</pre></div>
        <div><h3>После</h3><pre aria-label="Код после упрощения">{preview.after}</pre></div></div>
      <p>Совпадение будет подтверждено только после компиляции и выполнения на выбранных входах.</p>
      <div className="graph-edit-actions"><button className="button primary" onClick={() => void onApply(preview)}>Применить и проверить</button>
        <button className="button secondary" onClick={cancel}>Отмена</button></div>
    </div>}
  </section>;
}
