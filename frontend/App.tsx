import { useEffect, useRef, useState } from 'react';
import {
  ArrowDownToLine, ArrowRight, BookOpen, Box, Braces, Check, ChevronDown,
  ChevronRight, CircleHelp, FileCode2, FolderOpen, GitBranch, Layers3,
  LoaderCircle, PanelLeftClose, Upload, X,
} from 'lucide-react';
import { api } from './api';
import { exampleSource } from './example';
import MethodGraph from './MethodGraph';
import SourceView from './SourceView';
import type { GraphNode, JavaMethod, MethodGraph as Graph, Project } from './types';
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
  const [error, setError] = useState<string | null>(null);
  const [original, setOriginal] = useState(false);
  const [graphOnly, setGraphOnly] = useState(false);
  const [help, setHelp] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const method = project?.methods.find(item => item.id === methodId) ?? null;

  function openProject(next: Project) {
    setProject(next);
    const remembered = sessionStorage.getItem(`method:${next.id}`);
    setMethodId(next.methods.find(item => item.id === remembered)?.id
      ?? next.methods.find(item => item.hasBody)?.id ?? next.methods[0]?.id ?? null);
    setSelection(null);
    setOriginal(false);
  }

  useEffect(() => {
    let active = true;
    api.current().then(next => { if (active) openProject(next); }).catch(() => {})
      .finally(() => { if (active) setRestoring(false); });
    return () => { active = false; };
  }, []);

  useEffect(() => {
    if (!project || !methodId) { setGraph(null); return; }
    let active = true;
    setGraphLoading(true);
    setGraph(null);
    setSelection(null);
    sessionStorage.setItem(`method:${project.id}`, methodId);
    api.graph(project.id, methodId).then(next => { if (active) setGraph(next); })
      .catch(reason => { if (active) setError(String(reason.message)); })
      .finally(() => { if (active) setGraphLoading(false); });
    return () => { active = false; };
  }, [project, methodId]);

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

  function exportSource() {
    if (!project) return;
    const anchor = document.createElement('a');
    anchor.href = `/api/projects/${encodeURIComponent(project.id)}/export`;
    anchor.download = project.filename;
    anchor.click();
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
            <div className="file-row"><FileCode2 size={15} /><span>{project.filename}</span><span className="file-badge">J</span></div>
            <div className="methods-label">МЕТОДЫ <span>{project.methods.length}</span></div>
            <nav className="methods" aria-label="Методы программы">{[...groups].map(([owner, methods]) => <div key={owner}>
              <div className="class-label"><Box size={12} />{owner || 'Без класса'}</div>
              {methods.map(item => <button key={item.id} className={`method-button ${item.id === methodId ? 'active' : ''}`}
                aria-pressed={item.id === methodId} onClick={() => setMethodId(item.id)} title={item.signature}>
                <span className={`method-icon ${item.kind === 'constructor' ? 'constructor' : ''}`}>{item.kind === 'constructor' ? 'C' : 'ƒ'}</span>
                <span>{item.signature}</span>{item.id === methodId && <ChevronRight size={13} />}
              </button>)}
            </div>)}</nav>
            {project.methods.length === 0 && <p className="sidebar-empty">В файле нет методов. Объявления сохранены в коде.</p>}
          </> : <div className="sidebar-empty"><FileCode2 size={24} /><p>Файлы появятся здесь<br />после импорта Java</p></div>}
          <button className="sidebar-import" onClick={() => input.current?.click()} disabled={busy}><Upload size={14} />Загрузить .java</button>
          <div className="sidebar-bottom"><BookOpen size={17} /><strong>Код, который можно понять</strong><p>Исследуйте структуру метода, сохраняя Java перед глазами.</p>
            <button onClick={() => setHelp(true)}>Как это работает <ArrowRight size={13} /></button></div>
        </aside>

        <main className="workspace">
          <div className="workspace-toolbar">
            <div className="breadcrumbs">Рабочая область <ChevronRight size={13} /><span>{project?.filename || 'Начало работы'}</span></div>
            <div className="toolbar-actions"><button className="button secondary" onClick={() => input.current?.click()} disabled={busy}>
              {busy ? <LoaderCircle size={15} className="spin" /> : <Upload size={15} />}Импорт Java</button>
              <button className="button primary" aria-label="Экспорт Java" onClick={exportSource} disabled={!project || busy}><ArrowDownToLine size={15} />Экспорт Java</button></div>
          </div>

          {error && <div className="error-banner" role="alert"><span><strong>Не удалось загрузить файл.</strong> {error}</span>
            <button className="icon-button" aria-label="Закрыть ошибку" onClick={() => setError(null)}><X size={16} /></button></div>}

          {restoring ? <div className="welcome"><span className="spinner" /><p>Восстанавливаем рабочее пространство…</p></div>
            : !project ? <div className="welcome" onDragOver={event => event.preventDefault()} onDrop={event => {
              event.preventDefault(); const file = event.dataTransfer.files[0]; if (file && !busy) void importFile(file);
            }}>
              <div className="welcome-art"><div className="art-code"><Braces size={29} /><span>Java</span></div><div className="art-connector" /><div className="art-graph"><GitBranch size={30} /></div></div>
              <div className="eyebrow">ОТ КОДА К ПОНИМАНИЮ</div><h1>Увидеть логику.<br /><span>Понять программу.</span></h1>
              <p className="welcome-description">Превратите Java-код в понятную схему.<br />Исследуйте методы, ветвления и путь выполнения.</p>
              <div className="welcome-actions"><button className="button primary large" disabled={busy} onClick={() => input.current?.click()}><Upload size={17} />Загрузить Java-файл</button>
                <button className="button secondary large" disabled={busy} onClick={() => void importSource('OrderCalculator.java', exampleSource)}>{busy ? <LoaderCircle size={17} className="spin" /> : <GitBranch size={17} />}Открыть пример</button></div>
              <div className="drop-note">или перетащите .java сюда <span>·</span> до 256 КБ</div>
              <div className="welcome-features"><span><Check size={14} />Без регистрации</span><span><Check size={14} />Исходник сохранён</span><span><Check size={14} />Экспорт в Java</span></div>
            </div> : <>
              <div className="project-heading"><div><div className="eyebrow">ВАША ПРОГРАММА, НАГЛЯДНО</div><h1>{project.filename}</h1>
                <p>Выберите метод и проследите, как выполняется код.</p></div>
                <div className="view-options"><span className="model-status"><Check size={13} />Модель построена</span>
                  <button className={`view-toggle ${graphOnly ? 'active' : ''}`} aria-label={graphOnly ? 'Показать код и граф' : 'Развернуть граф'} onClick={() => setGraphOnly(!graphOnly)}><PanelLeftClose size={16} /></button></div></div>
              <div className={`editor-workspace ${graphOnly ? 'graph-only' : ''}`}>
                {!graphOnly && <SourceView project={project} method={method} selection={selection?.range ?? null} blocks={graph?.nodes ?? []}
                  onSelect={setSelection} original={original} onOriginal={setOriginal} />}
                <MethodGraph graph={graph} method={method} selected={selection?.id ?? null} onSelect={setSelection} loading={graphLoading} />
              </div>
              <div className="workspace-note"><span><i />{project.methods.length} методов · ревизия {project.revision}</span>
                <span>Исходная версия сохранена <Check size={12} /></span></div>
            </>}
          <footer className="app-footer"><span><GitBranch size={13} />Java ↔ граф</span><span>Исследуйте код. Сохраняйте смысл.</span><span>AXENIX HACKATHON <i>2026</i></span></footer>
        </main>
      </div>
      {help && <div className="modal-backdrop" onClick={() => setHelp(false)}><section className="help-modal" role="dialog" aria-modal="true" aria-label="Как это работает" onClick={event => event.stopPropagation()}>
        <button className="icon-button modal-close" aria-label="Закрыть справку" onClick={() => setHelp(false)}><X size={20} /></button>
        <div className="eyebrow">JAVA BLUEPRINTS</div><h2>От исходника к структуре</h2>
        <ol><li><strong>Загрузите .java</strong><p>Исходная версия сохраняется отдельно от сгенерированного кода.</p></li>
          <li><strong>Выберите метод</strong><p>Граф показывает последовательности и if/else. Остальные конструкции пока отображаются целыми блоками с пояснением.</p></li>
          <li><strong>Исследуйте и скачайте</strong><p>Нажмите на блок, чтобы найти строку кода. Экспорт сохраняет комментарии и оформление.</p></li></ol>
        <div className="help-note">На этом этапе программа разбирается, но не запускается. Совпадение поведения ещё не проверялось. Проекты временные и хранятся до 24 часов.</div>
        <button className="button primary" onClick={() => setHelp(false)}>Понятно <ArrowRight size={15} /></button>
      </section></div>}
    </div>
  );
}
