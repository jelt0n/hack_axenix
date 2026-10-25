import { useRef, useState } from 'react';
import { FileCode2, FilePlus2, Pencil, Trash2, Upload, FolderOpen, ChevronDown, ChevronRight } from 'lucide-react';
import { api } from './api';
import type { Project } from './types';

export default function FileExplorer({ project, disabled, pendingChanges, onSelect, onChange }: {
  project: Project; disabled: boolean; pendingChanges: boolean; onSelect: (fileId: string) => Promise<void>; onChange: (project: Project) => void;
}) {
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [action, setAction] = useState<'create' | 'rename' | 'delete' | null>(null);
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const upload = useRef<HTMLInputElement>(null);
  const locked = disabled || busy;
  async function perform(load: () => Promise<Project>) {
    setBusy(true); setError('');
    try { onChange(await load()); setAction(null); }
    catch (reason) { setError(reason instanceof Error ? reason.message : 'Не удалось изменить файлы'); }
    finally { setBusy(false); }
  }
  function createSource() {
    const pieces = path.split('/');
    const name = pieces.pop()?.replace(/\.java$/, '') ?? '';
    return (pieces.length ? `package ${pieces.join('.')};\n\n` : '') + `public class ${name} {\n\n}\n`;
  }
  function directory(prefix: string, depth = 0): React.ReactNode {
    const children = new Set(project.files.filter(file => file.path.startsWith(prefix)).map(file => file.path.slice(prefix.length).split('/')[0]));
    return [...children].sort().map(name => {
      const path = prefix + name;
      const file = project.files.find(item => item.path === path);
      return file ? <button key={path} className={`file-row ${file.id === project.fileId ? 'active' : ''}`} disabled={locked}
        style={{paddingLeft:12 + Math.min(depth,4)*12}} aria-label={`Открыть файл ${file.path}`}
        aria-pressed={file.id === project.fileId} title={file.path}
        onClick={() => { if (file.id !== project.fileId) void onSelect(file.id); }}>
        <FileCode2 size={15}/><span>{name}</span>{file.stale && <span title="Обновите граф">●</span>}
      </button> : <div key={path}>
        <button className="folder-row" aria-label={`Папка ${path}`} aria-expanded={!collapsed.has(path)} style={{paddingLeft:12 + Math.min(depth,4)*12}}
          onClick={() => setCollapsed(items => { const next=new Set(items); if(next.has(path)) next.delete(path); else next.add(path); return next; })}>
          {collapsed.has(path) ? <ChevronRight size={14}/> : <ChevronDown size={14}/>}<FolderOpen size={15}/>{name}
        </button>
        {!collapsed.has(path) && directory(path+'/',depth+1)}
      </div>;
    });
  }
  return <section className="file-explorer" aria-label="Файлы проекта">
    <div className="explorer-actions">
      <button className="icon-button" disabled={locked} aria-label="Создать Java-файл" title="Создать Java-файл"
        onClick={() => { setPath(''); setError(''); setAction('create'); }}><FilePlus2 size={17} /></button>
      <button className="icon-button" disabled={locked} aria-label="Добавить Java-файл" title="Добавить существующий Java-файл"
        onClick={() => upload.current?.click()}><Upload size={17} /></button>
      <button className="icon-button" disabled={locked} aria-label="Переименовать файл" title="Переименовать выбранный файл"
        onClick={() => { setPath(project.filename); setError(''); setAction('rename'); }}><Pencil size={16} /></button>
      <button className="icon-button" disabled={locked || project.files.length === 1} aria-label="Удалить файл" title="Удалить выбранный файл"
        onClick={() => { setError(''); setAction('delete'); }}><Trash2 size={16} /></button>
    </div>
    <input ref={upload} className="visually-hidden" type="file" accept=".java" aria-label="Добавить файл в проект"
      onChange={event => {
        const file = event.target.files?.[0]; event.target.value = '';
        if (file) void perform(async () => {
          if (file.size > 256000) throw new Error('Лимит файла — 256000 байт UTF-8.');
          return api.addFile(project, file.name, await file.text());
        });
      }} />
    <nav aria-label="Проводник Java">{directory('')}</nav>
    {action && <form className="explorer-form" onSubmit={event => {
      event.preventDefault();
      void perform(() => action === 'create' ? api.addFile(project, path, createSource())
        : action === 'rename' ? api.renameFile(project, path) : api.deleteFile(project));
    }}>
      {action === 'delete' ? <p>Удалить {project.filename} из рабочей версии? Исходная версия сохранится.</p>
        : <label>{action === 'create' ? 'Путь нового файла' : 'Новое имя файла'}
          <input autoFocus aria-label="Путь Java-файла" value={path} maxLength={240} placeholder="demo/Price.java"
            onChange={event => setPath(event.target.value)} disabled={locked} required /></label>}
      <div><button className="button primary" disabled={locked} type="submit">{action === 'delete' ? 'Подтвердить удаление' : 'Сохранить файл'}</button>
        <button className="button secondary" disabled={locked} type="button" onClick={() => setAction(null)}>Отмена</button></div>
    </form>}
    {error && <p className="explorer-error" role="alert">{error}</p>}
    {pendingChanges ? <p className="project-download">Сохраните черновики файлов для экспорта ZIP.</p> : <a className="project-download" href={`/api/projects/${encodeURIComponent(project.id)}/export.zip`}>Скачать проект ZIP</a>}
  </section>;
}
