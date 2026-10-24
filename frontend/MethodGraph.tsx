import { useEffect, useMemo, useRef } from 'react';
import {
  Background, BackgroundVariant, Controls, Handle, MarkerType, Position,
  ReactFlow, ReactFlowProvider, useReactFlow, type Node, type NodeProps,
} from '@xyflow/react';
import { ArrowDownToLine, GitBranch, Maximize2 } from 'lucide-react';
import type { GraphEdit, GraphNode, JavaMethod, MethodGraph as Graph } from './types';
import GraphEditor from './GraphEditor';

type BlueprintNode = Node<{ block: GraphNode }, 'blueprint'>;
const labels: Record<GraphNode['kind'], string> = {
  entry: 'ВХОД', exit: 'ВЫХОД', condition: 'УСЛОВИЕ', operation: 'ОПЕРАЦИЯ',
  return: 'ВОЗВРАТ', opaque: 'КОНСТРУКЦИЯ',
};

function BlockNode({ data, selected }: NodeProps<BlueprintNode>) {
  const block = data.block;
  const terminal = block.kind === 'entry' || block.kind === 'exit';
  return (
    <div className={`blueprint-node ${block.kind} ${selected ? 'selected' : ''}`} title={block.code}>
      {block.kind !== 'entry' && <Handle type="target" position={Position.Top} />}
      <div className="node-label"><span className="node-dot" />{labels[block.kind]}
        {!terminal && <span className="node-line">L{block.range.startLine}</span>}
      </div>
      <div className="node-code">{block.code}</div>
      {block.kind !== 'exit' && <Handle type="source" position={Position.Bottom} />}
    </div>
  );
}
const nodeTypes = { blueprint: BlockNode };

function layout(graph: Graph, selected: string | null): BlueprintNode[] {
  const incoming = new Map(graph.nodes.map(node => [node.id, 0]));
  const rank = new Map(graph.nodes.map(node => [node.id, 0]));
  const outgoing = new Map<string, string[]>();
  for (const edge of graph.edges) {
    incoming.set(edge.target, (incoming.get(edge.target) ?? 0) + 1);
    outgoing.set(edge.source, [...(outgoing.get(edge.source) ?? []), edge.target]);
  }
  const queue = graph.nodes.filter(node => !incoming.get(node.id)).map(node => node.id);
  for (let i = 0; i < queue.length; i++) {
    const id = queue[i];
    for (const target of outgoing.get(id) ?? []) {
      rank.set(target, Math.max(rank.get(target) ?? 0, (rank.get(id) ?? 0) + 1));
      incoming.set(target, (incoming.get(target) ?? 1) - 1);
      if (!incoming.get(target)) queue.push(target);
    }
  }
  const rows = new Map<number, GraphNode[]>();
  for (const node of graph.nodes) {
    const row = rank.get(node.id) ?? 0;
    rows.set(row, [...(rows.get(row) ?? []), node]);
  }
  return [...rows.entries()].flatMap(([row, blocks]) => blocks
    .sort((a, b) => a.range.startLine - b.range.startLine || a.id.localeCompare(b.id))
    .map((block, index) => ({
      id: block.id, type: 'blueprint' as const, data: { block }, selected: block.id === selected,
      position: { x: (index - (blocks.length - 1) / 2) * 310, y: row * 128 },
    })));
}

function GraphCanvas({ graph, selected, onSelect }: {
  graph: Graph; selected: string | null; onSelect: (block: GraphNode) => void;
}) {
  const { fitView } = useReactFlow();
  const container = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!container.current) return;
    let frame = 0;
    const observer = new ResizeObserver(() => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => { void fitView({ padding: 0.2, maxZoom: 1 }); });
    });
    observer.observe(container.current);
    return () => { observer.disconnect(); cancelAnimationFrame(frame); };
  }, [fitView]);
  const nodes = useMemo(() => layout(graph, selected), [graph, selected]);
  const edges = useMemo(() => graph.edges.map(edge => ({
    ...edge, type: 'smoothstep', markerEnd: { type: MarkerType.ArrowClosed, width: 16, height: 16 },
    style: { stroke: edge.label === 'Да' ? '#d98e34' : '#9baab9', strokeWidth: 1.5 },
    labelStyle: { fill: '#667182', fontSize: 11, fontWeight: 600 },
    labelBgStyle: { fill: '#f6f8fa', fillOpacity: 1 }, labelBgPadding: [6, 4] as [number, number],
  })), [graph]);
  return (
    <div className="graph-canvas" data-testid="graph-canvas" ref={container}>
      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} nodesDraggable={false}
        nodesConnectable={false} edgesFocusable={false} onNodeClick={(_, node) => onSelect(node.data.block)}
        fitView fitViewOptions={{ padding: 0.2, maxZoom: 1 }} minZoom={0.2} maxZoom={1.7}>
        <Background variant={BackgroundVariant.Dots} gap={18} size={1} color="#ced6df" />
        <Controls showInteractive={false} position="bottom-left" />
      </ReactFlow>
      <button className="fit-button" aria-label="Вписать граф" onClick={() => void fitView({ padding: 0.2, duration: 250 })}>
        <Maximize2 size={15} /> Вписать
      </button>
      <div className="canvas-hint">Потяните фон, чтобы переместить граф</div>
    </div>
  );
}

export default function MethodGraph({ graph, method, selected, onSelect, loading, stale = false, editDisabled, onEdit }: {
  graph: Graph | null; method: JavaMethod | null; selected: string | null;
  onSelect: (block: GraphNode) => void; loading: boolean; stale?: boolean;
  editDisabled: boolean; onEdit: (edit: GraphEdit) => Promise<void>;
}) {
  return (
    <section className="graph-panel" aria-label="Граф метода">
      <div className="panel-heading">
        <div><GitBranch size={16} /><span>Граф метода</span><span className="small-tag">BLUEPRINT</span></div>
        <span className="panel-meta">{graph ? `${graph.nodes.length} блоков` : 'Схема выполнения'}</span>
      </div>
      <div className="graph-caption"><span>{method?.signature || 'Выберите метод'}</span>
        <span>{method?.owner || 'JAVA'}</span></div>
      {stale && <div className="graph-stale" role="status">Граф устарел. Обновите его по рабочему коду; переходы к строкам временно отключены.</div>}
      {loading ? <div className="panel-empty"><span className="spinner" />Строим граф…</div>
        : graph && graph.nodes.length > 0 ? <ReactFlowProvider key={graph.methodId}>
          <GraphCanvas graph={graph} selected={stale ? null : selected} onSelect={stale ? () => {} : onSelect} />
        </ReactFlowProvider>
        : <div className="panel-empty"><ArrowDownToLine size={28} />
          <strong>{stale ? 'Модель проекта изменилась' : method ? method.hasBody ? 'Граф недоступен' : 'У объявления нет тела' : 'Здесь появится структура метода'}</strong>
          <span>{stale ? 'Загрузите актуальную версию или разрешите конфликт сохранения.' : method ? 'Интерфейсы и абстрактные методы сохраняются в исходнике.' : 'Загрузите Java-файл или откройте пример.'}</span>
        </div>}
      {graph && graph.notices.length > 0 && <div className="graph-notice" role="note">{graph.notices[0]}</div>}
      {graph && !loading && <GraphEditor graph={graph} selected={graph.nodes.find(node => node.id === selected) ?? null}
        disabled={stale || editDisabled} onEdit={onEdit} />}
      <div className="graph-legend"><span><i className="legend-operation" />Операция</span>
        <span><i className="legend-condition" />Условие</span><span><i className="legend-return" />Возврат</span>
        <span className="legend-tip">Нажмите на блок → строка кода</span></div>
    </section>
  );
}
