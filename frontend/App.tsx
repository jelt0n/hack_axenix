import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, Box, Braces, Check, ChevronDown,
  ChevronRight, CircleHelp, FileCode2, FolderOpen, GitBranch, Layers3,
  LoaderCircle, PanelLeftClose, Play, Upload, X, Terminal,
} from 'lucide-react';
import { api, ApiError } from './api';
import { exampleSource } from './example';
import MethodGraph from './MethodGraph';
import FileExplorer from './FileExplorer';
import { removeDraft } from './drafts';
import SourceView from './SourceView';
import CheckPanel from './CheckPanel';
import AnalysisPanel from './AnalysisPanel';
import ConstantBranchPanel from './ConstantBranchPanel';
import ExtractMethodPanel from './ExtractMethodPanel';
import useWorkingCopy from './useWorkingCopy';
import { sameMethod } from './methods';
import type { ExtractionPreview, AutomaticCheck, BranchPreview, AnalysisFinding, GraphNode, JavaMethod, MethodGraph as Graph, Project } from './types';
import '@xyflow/react/dist/style.css';
import './style.css';

export default function App() {
  const [project, setProject] = useState<Project | null>(null);
  const [methodId, setMethodId] = useState<string | null>(null);
  const [graph, setGraph] = useState<Graph | null>(null);
  const [selection, setSelection] = useState<GraphNode | null>(null);
  const [busy, setBusy] = useState(false);
  const [restoring, setRestoring] = useState(true);
  const [graphLoading, setGraphLoading] = useState(false);
  const [remoteChanged, setRemoteChanged] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const [graphOnly, setGraphOnly] = useState(false);
  const [help, setHelp] = useState(false);
  const [checksOpen, setChecksOpen] = useState(false);
  const [automaticCheck, setAutomaticCheck] = useState<AutomaticCheck | null>(null);
  const checkSequence = useRef(0);
  const input = useRef<HTMLInputElement>(null);
  const analysisTarget = useRef<AnalysisFinding | null>(null);
  const method = project?.methods.find(item => item.id === methodId) ?? null;
  const projectRef = useRef(project); projectRef.current = project;
  const methodRef = useRef(methodId); methodRef.current = methodId;
  function adoptProject(next: Project) {
    const previous = projectRef.current;
    if (!previous || next.id !== previous.id || next.revision < previous.revision) return;
    const selected = previous.methods.find(item => item.id === methodRef.current);
    const nextMethod = next.methods.find(item => sameMethod(item, selected));
    setMethodId(nextMethod?.id ?? next.methods.find(item => item.hasBody)?.id ?? next.methods[0]?.id ?? null);
    analysisTarget.current = null;
    projectRef.current = next; setRemoteChanged(false); setProject(next);
  }
  const editor = useWorkingCopy(project, adoptProject);
  const graphStale = !!project && (remoteChanged || !!editor.conflict || editor.dirty || project.revision !== project.graphRevision);

  function openProject(next: Project) {
    analysisTarget.current = null;
    setAutomaticCheck(null);
    sessionStorage.setItem(`file:${next.id}`, next.fileId);
    setProject(next);
    const remembered = sessionStorage.getItem(`method:${next.id}:${next.fileId}`);
    setMethodId(next.methods.find(item => item.id === remembered)?.id
      ?? next.methods.find(item => item.hasBody)?.id ?? next.methods[0]?.id ?? null);
    setSelection(null);
    setOriginal(false);
    setRemoteChanged(false);
  }

  useEffect(() => {
    let active = true;
    api.current().then(async next => {
      const fileId = sessionStorage.getItem(`file:${next.id}`);
      const restored = fileId && next.files.some(file => file.id === fileId) ? await api.project(next.id, fileId) : next;
      if (active) openProject(restored);
    }).catch(() => {})
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!project || !methodId) { setGraph(null); return; }
    let active = true;
    setGraphLoading(true);
    setGraph(null);
    setSelection(null);
    sessionStorage.setItem(`method:${project.id}:${project.fileId}`, methodId);
    api.graph(project.id, methodId, project.fileId).then(next => {
      const current = projectRef.current;
      if (!active || current?.id !== project.id || current?.fileId !== project.fileId) return;
      if (next.projectRevision >= current.revision) {
        setRemoteChanged(next.projectRevision !== current.revision || next.sourceRevision !== current.graphRevision);
      }
      if (next.sourceRevision === current.graphRevision) {
        setGraph(next);
        const target = analysisTarget.current;
        if (target?.methodId === next.methodId && !next.stale) {
          const block = next.nodes.find(node => node.id === target.nodeId);
          setSelection(block ? { ...block, range: target.range } : { id: '', kind: 'operation', code: '', range: target.range });
          analysisTarget.current = null;
        }
      }
    })
      .catch(async reason => {
        if (!active) return;
        if (reason instanceof ApiError && reason.status === 404) {
          try {
            const remote = await api.project(project.id, project.fileId);
            if (!active) return;
            if (remote.revision !== projectRef.current?.revision) { setRemoteChanged(true); return; }
          } catch { /* The original request error describes an expired or unavailable project. */ }
        }
        if (active) setError(String(reason.message));
      })
      .finally(() => { if (active) setGraphLoading(false); });
    return () => { active = false; };
  }, [project?.id, project?.fileId, project?.graphRevision, methodId]);

  async function importSource(filename: string, source: string) {
    setBusy(true); setError(null);
    try { openProject(await api.import(filename, source)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось загрузить файл'); }
    finally { setBusy(false); }
  }

  async function importFile(file: File) {
    if (!file.name.endsWith('.java')) { setError('Выберите файл с расширением .java'); return; }
    if (file.size > 256_000) { setError('Выберите Java-файл размером до 256 КБ'); return; }
    await importSource(file.name, await file.text());
  }

  function navigateFinding(finding: AnalysisFinding) {
    if (graphStale) return;
    setOriginal(false); setGraphOnly(false);
    if (methodId === finding.methodId && graph) {
      const block = graph.nodes.find(node => node.id === finding.nodeId);
      setSelection(block ? { ...block, range: finding.range } : { id: '', kind: 'operation', code: '', range: finding.range });
    } else {
      analysisTarget.current = finding;
      setMethodId(finding.methodId);
    }
  }

  async function applyTransformation(preview: BranchPreview | ExtractionPreview) {
    const changed = await editor.applyTransformation(preview);
    if (!changed) return;
    setChecksOpen(true);
    setAutomaticCheck({ projectId: changed.id, revision: changed.revision, sequence: ++checkSequence.current });
  }

  function exportSource() {
    if (!project) return;
    const anchor = document.createElement('a');
    const url = URL.createObjectURL(new Blob([editor.source], { type: 'text/plain;charset=utf-8' }));
    anchor.href = url;
    anchor.download = project.filename.split('/').pop()!;
    anchor.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function selectFile(fileId: string) {
    if (!project || editor.saving || (editor.dirty && !editor.localSaved)) return;
    setBusy(true); setError(null);
    try { openProject(await api.project(project.id, fileId)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось открыть файл'); }
    finally { setBusy(false); }
  }
  function changeFiles(next: Project) {
    for (const removed of project?.files.filter(file => !next.files.some(item => item.id === file.id)) ?? []) {
      try { removeDraft(next.id,removed.id); } catch { /* Deleted files cannot block project execution. */ }
    }
    if (next.fileId === project?.fileId) editor.acceptFileChange(next);
    else openProject(next);
  }

  const groups = new Map<string, JavaMethod[]>();
  for (const item of project?.methods ?? []) groups.set(item.owner, [...(groups.get(item.owner) ?? []), item]);

  return (
    <div className="app-shell">
      <input ref={input} type="file" accept=".java" aria-label="Загрузить Java-файл" className="visually-hidden"
        onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file); event.target.value = ''; }} />
      <header className="app-header">
        <a href="/" className="brand" aria-label="Java Blueprints — главная"><span className="brand-mark"><Braces size={23} /></span>
          <span>java<span className="brand-light">blueprints</span><span className="brand-beta">BETA</span></span></a>
        <div className="header-divider" /><span className="header-context">Визуальная среда программирования</span>
        <div className="header-right"><span className="session-status"><i />Временная сессия</span>
          <button className="icon-button help-button" aria-label="Как это работает" onClick={() => setHelp(true)}><CircleHelp size={19} /></button></div>
      </header>
      <div className="app-body">
        <aside className="sidebar">
          <div className="workspace-label"><span className="workspace-avatar">JB</span><div>Ваше рабочее пространство<small>Временный проект</small></div></div>
          <div className="sidebar-title">ОБОЗРЕВАТЕЛЬ <Layers3 size={14} /></div>
          <div className="project-folder"><ChevronDown size={14} /><FolderOpen size={16} />{project ? 'java-project' : 'Новый проект'}</div>
          {project ? <>
            <FileExplorer project={project} pendingChanges={editor.pendingFiles || editor.dirty} disabled={busy || editor.saving || (editor.dirty && !editor.localSaved)} onSelect={selectFile} onChange={changeFiles} />
            <div className="methods-label">МЕТОДЫ <span>{project.methods.length}</span></div>
            <nav className="methods" aria-label="Методы программы">{[...groups].map(([owner, methods]) => <div key={owner}>
              <div className="class-label"><Box size={12} />{owner || 'Без класса'}</div>
              {methods.map(item => <button key={item.id} className={`method-button ${item.id === methodId ? 'active' : ''}`}
                aria-pressed={item.id === methodId} onClick={() => { analysisTarget.current = null; setMethodId(item.id); }} title={item.signature}>
                <span className={`method-icon ${item.kind === 'constructor' ? 'constructor' : ''}`}>{item.kind === 'constructor' ? 'C' : 'ƒ'}</span>
                <span>{item.signature}</span>{item.id === methodId && <ChevronRight size={13} />}
              </button>)}
            </div>)}</nav>
            {project.methods.length === 0 && <p className="sidebar-empty">В файле нет методов. Объявления сохранены в коде.</p>}
          </> : <div className="sidebar-empty"><FileCode2 size={24} /><p>Файлы появятся здесь<br />после импорта Java</p></div>}
          <button className="sidebar-import" onClick={() => input.current?.click()} disabled={busy || (editor.dirty && !editor.localSaved)}><Upload size={14} />Загрузить .java</button>
          <div className="sidebar-bottom">
            <button onClick={() => setHelp(true)}>Как это работает <ArrowRight size={13} /></button></div>
        </aside>

        <main className="workspace">
          <div className="workspace-toolbar">
            <div className="breadcrumbs">Рабочая область <ChevronRight size={13} /><span>{project?.filename || 'Начало работы'}</span></div>
            <div className="toolbar-actions"><button className="button secondary" onClick={() => input.current?.click()} disabled={busy || (editor.dirty && !editor.localSaved)}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}Импорт Java</button>
              <button className="button secondary" aria-label="Экспорт Java" onClick={exportSource} disabled={!project || busy}><ArrowDownToLine size={15} />Экспорт Java</button>
              {project && <button className="button secondary" aria-label="Открыть консоль" onClick={() => setChecksOpen(true)}><Terminal size={15} />Консоль</button>}
              {project && <button className="button primary" aria-label="Проверить поведение" onClick={() => setChecksOpen(true)}><Play size={14} />Проверить</button>}</div>
          </div>

          {error && <div className="error-banner" role="alert"><span><strong>Не удалось выполнить действие.</strong> {error}</span>
            <button className="icon-button" aria-label="Закрыть ошибку" onClick={() => setError(null)}><X size={16} /></button></div>}

          {restoring ? <div className="welcome"><span className="spinner" /><p>Восстанавливаем рабочее пространство…</p></div>
            : !project ? <div className="welcome" onDragOver={event => event.preventDefault()} onDrop={event => {
              event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && !busy) void importFile(file);
            }}>
              <div className="welcome-art"><div className="art-code"><Braces size={29} /><span>Java</span></div><div className="art-connector" /><div className="art-graph"><GitBranch size={30} /></div></div>
              <div className="eyebrow">ОТ КОДА К ПОНИМАНИЮ</div><h1>Увидеть логику.<br /><span>Понять программу.</span></h1>
              <p className="welcome-description">Превратите Java-код в понятную схему.<br />Исследуйте методы, ветвления и путь выполнения.</p>
              <div className="welcome-actions"><button className="button primary large" disabled={busy || (editor.dirty && !editor.localSaved)} onClick={() => input.current?.click()}><Upload size={17} />Загрузить Java-файл</button>
                <button className="button secondary large" disabled={busy || (editor.dirty && !editor.localSaved)} onClick={() => void importSource('OrderCalculator.java', exampleSource)}>{busy ? <LoaderCircle size={17} className="spin" /> : <GitBranch size={17} />}Открыть пример</button></div>
              <div className="drop-note">или перетащите .java сюда <span>·</span> до 256 КБ</div>
              <div className="welcome-features"><span><Check size={14} />Без регистрации</span><span><Check size={14} />Исходник сохранён</span><span><Check size={14} />Экспорт в Java</span></div>
            </div> : <>
              <div className="project-heading"><div><div className="eyebrow">ВАША ПРОГРАММА, НАГЛЯДНО</div><h1>{project.filename}</h1>
                <p>Выберите метод и проследите, как выполняется код.</p></div>
                <div className="view-options"><span className={`model-status ${graphStale ? 'stale' : ''}`}><Check size={13} />{graphStale ? 'Граф устарел' : 'Модель построена'}</span>
                  <button className={`view-toggle ${graphOnly ? 'active' : ''}`} aria-label={graphOnly ? 'Показать код и граф' : 'Развернуть граф'} onClick={() => setGraphOnly(!graphOnly)}><PanelLeftClose size={16} /></button></div></div>
              <div className="editing-toolbar"><div role="status"><span>{editor.saving ? 'Сохраняем код и строим граф…' : editor.dirty ? editor.localSaved ? 'Черновик сохранён в браузере' : 'Черновик пока не сохранён' : `Код сохранён · ревизия ${project.revision}`}</span>
                <small>Граф: ревизия {project.graphRevision}</small></div>
                <button className="button primary" disabled={editor.saving || !!editor.conflict} onClick={() => void editor.rebuild()}>
                  {editor.saving ? <LoaderCircle size={14} className="spin" /> : <GitBranch size={14} />}Обновить граф</button></div>
              {editor.error && <div className="edit-error" role="alert">{editor.error}</div>}
              {remoteChanged && <div className="edit-error remote-change" role="alert">Проект обновлён в другой вкладке. Обновите страницу или сохраните свой текст через «Обновить граф».</div>}
              {editor.conflict && <div className="edit-conflict" role="alert"><p>Проект изменён в другой вкладке. Ваш текст сохранён локально. Выберите, какую версию использовать.</p>
                <button className="button secondary" onClick={editor.useServerCopy}>Загрузить серверную версию</button>
                <button className="button secondary" disabled={editor.saving} onClick={() => void editor.rebuild(editor.conflict!)}>Сохранить мой текст поверх серверного</button></div>}
              {!editor.dirty && project.diagnostics.length > 0 && <div className="edit-diagnostics" role="alert"><strong>Java содержит синтаксические ошибки. Код сохранён, показан предыдущий граф.</strong>
                {project.diagnostics.map((item, index) => <div key={index}>Строка {item.line}, столбец {item.column}: {item.message}</div>)}</div>}
              <div className={`editor-workspace ${graphOnly ? 'graph-only' : ''}`}>
                {!graphOnly && <SourceView key={`${project.id}:${project.fileId}`} project={project} method={method} selection={selection?.range ?? null} blocks={graphStale ? [] : graph?.nodes ?? []}
                  onSelect={setSelection} original={original} onOriginal={setOriginal} value={editor.source} onChange={editor.changeSource} stale={graphStale} dirty={editor.dirty} />}
                <MethodGraph graph={graph} method={method} selected={selection?.id ?? null} onSelect={setSelection} loading={graphLoading} stale={graphStale}
                  editDisabled={editor.saving || !!editor.conflict || original} onEdit={editor.editGraph} />
              </div>
              <div className="workspace-note"><span><i />{project.methods.length} методов · ревизия {project.revision}</span>
                <span>Исходная версия сохранена <Check size={12} /></span></div>
              <ConstantBranchPanel key={`constant:${project.id}:${project.fileId}`} project={project} graph={graph} selected={selection}
                disabled={graphStale || editor.saving || original || graphLoading}
                onApply={applyTransformation} onConflict={() => setRemoteChanged(true)} />
              <ExtractMethodPanel key={`extract:${project.id}:${project.fileId}`} project={project} graph={graph} selected={selection}
                disabled={graphStale || editor.saving || original || graphLoading}
                onApply={applyTransformation} onConflict={() => setRemoteChanged(true)} />
              <AnalysisPanel key={`AnalysisPanel:${project.id}:${project.fileId}`} project={project} pendingChanges={graphStale || editor.saving || editor.pendingFiles}
                onNavigate={navigateFinding} onConflict={() => setRemoteChanged(true)} />
              <CheckPanel project={project} open={checksOpen} onToggle={() => setChecksOpen(!checksOpen)} pendingChanges={remoteChanged || !!editor.conflict || editor.dirty || editor.saving || editor.pendingFiles} automaticCheck={automaticCheck} />
            </>}
          <footer className="app-footer"><span><GitBranch size={13} />Java ↔ граф</span><span>Исследуйте код. Сохраняйте смысл.</span><span>AXENIX HACKATHON <i>2026</i></span></footer>
        </main>
      </div>
      {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-label="Как это работает" onClick={event => event.stopPropagation()}>
        <button className="icon-button modal-close" aria-label="Закрыть справку" onClick={() => setHelp(false)}><X size={20} /></button>
        <div className="eyebrow">JAVA BLUEPRINTS</div><h2>От исходника к структуре</h2>
        <ol><li><strong>Загрузите .java</strong><p>Исходная версия сохраняется отдельно от сгенерированного кода.</p></li>
          <li><strong>Выберите метод</strong><p>Граф показывает ветвления, циклы, поддержанные switch и переходы управления. Пунктир обозначает повтор цикла. Неподдержанные формы показаны целиком с пояснением.</p></li>
          <li><strong>Изменяйте и проверяйте</strong><p>Выберите блок для правки, добавьте или переместите операцию в последовательности. Затем запустите проверку поведения. Экспорт сохраняет комментарии и оформление.</p></li></ol>
        <div className="help-note">В разделе «Проверка поведения» обе версии выполняются на одинаковых входах в отдельном исполнителе. Результат относится только к выбранным сценариям. Проекты временные и хранятся до 24 часов.</div>
        <button className="button primary" onClick={() => setHelp(false)}>Понятно <ArrowRight size={15} /></button>
      </section></div>}
    </div>
  );
}
