import { useEffect, useState } from 'react';
import type { GraphAction, GraphEdit, GraphNode, MethodGraph } from './types';

export default function GraphEditor({ graph, selected, disabled, onEdit }: {
  graph: MethodGraph; selected: GraphNode | null; disabled: boolean;
  onEdit: (edit: GraphEdit) => Promise<void>;
}) {
  const containers = graph.containers ?? [];
  const [code, setCode] = useState('');
  const [adding, setAdding] = useState(false);
  const [newCode, setNewCode] = useState('');
  const [containerId, setContainerId] = useState('');
  const [index, setIndex] = useState(0);
  useEffect(() => { setCode(selected?.code ?? ''); }, [selected?.id, selected?.code]);
  const container = containers.find(item => item.id === containerId);
  const selectedContainer = containers.find(item => item.id === selected?.containerId);
  const position = selected?.index;
  const movable = !!selected?.editable && !!selectedContainer && position !== undefined;
  const submit = (edit: GraphAction) => void onEdit({ ...edit, methodId: graph.methodId });

  function startAdding() {
    const target = selectedContainer ?? containers[0];
    setContainerId(target?.id ?? '');
    setIndex(selectedContainer && position !== undefined ? position + 1 : target?.size ?? 0);
    setNewCode(''); setAdding(true);
  }

  return <div className="graph-edit-tools" aria-label="Редактирование рабочей версии через граф">
    <div className="graph-edit-heading"><strong>Правка рабочей версии</strong>
      <button className="button secondary" disabled={disabled || !containers.length} onClick={startAdding}>Добавить операцию</button>
    </div>
    {disabled && <p className="graph-edit-note">Для правки нужен актуальный граф рабочей версии без несохранённого текста.</p>}
    <fieldset disabled={disabled}>
      {selected?.editable ? <>
        <label>Код блока<textarea aria-label="Код блока" rows={3} value={code} onChange={e => setCode(e.target.value)} /></label>
        <div className="graph-edit-actions">
          <button className="button primary" disabled={!code.trim() || code === selected.code}
            onClick={() => submit({ action: 'replace', nodeId: selected.id, code })}>Применить правку</button>
          {movable && <>
            <button className="button secondary" disabled={position === 0}
              onClick={() => submit({ action: 'move', nodeId: selected.id, containerId: selectedContainer!.id, index: position! - 1 })}>Переместить выше</button>
            <button className="button secondary" disabled={position! >= selectedContainer!.size - 1}
              onClick={() => submit({ action: 'move', nodeId: selected.id, containerId: selectedContainer!.id, index: position! + 2 })}>Переместить ниже</button>
            <button className="button secondary" onClick={() => submit({ action: 'delete', nodeId: selected.id })}>Удалить операцию</button>
          </>}
        </div>
      </> : <p className="graph-edit-note">Выберите операцию или условие для правки. Связи графа строятся автоматически.</p>}
      {adding && <div className="graph-add-form">
        <label>Последовательность вставки<select aria-label="Последовательность вставки" value={containerId} onChange={e => {
          setContainerId(e.target.value); setIndex(containers.find(item => item.id === e.target.value)?.size ?? 0);
        }}>{containers.map(item => <option key={item.id} value={item.id}>{item.label}</option>)}</select></label>
        <label>Позиция вставки<select aria-label="Позиция вставки" value={index} onChange={e => setIndex(Number(e.target.value))}>
          {Array.from({ length: (container?.size ?? 0) + 1 }, (_, i) => <option key={i} value={i}>{i + 1}{i === container?.size ? ' · в конец' : ''}</option>)}
        </select></label>
        <label>Новая операция<textarea aria-label="Новая операция" rows={2} value={newCode} onChange={e => setNewCode(e.target.value)} placeholder="System.out.println(value);" /></label>
        <div className="graph-edit-actions"><button className="button primary" disabled={!newCode.trim() || !container}
          onClick={() => submit({ action: 'insert', code: newCode, containerId, index })}>Подтвердить добавление</button>
          <button className="button secondary" onClick={() => setAdding(false)}>Отмена</button></div>
      </div>}
    </fieldset>
  </div>;
}
