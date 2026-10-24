import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import type { Project } from './types';

type Draft = { id: string; source: string; baseRevision: number };
const key = (id: string) => `java-draft:${id}`;

function recover(project: Project): Draft {
  try {
    const saved = JSON.parse(sessionStorage.getItem(key(project.id)) || 'null');
    if (saved && typeof saved.source === 'string' && Number.isInteger(saved.baseRevision)) {
      return { id: project.id, source: saved.source, baseRevision: saved.baseRevision };
    }
  } catch { /* The server copy remains available when local storage is unavailable. */ }
  return { id: project.id, source: project.generatedSource, baseRevision: project.revision };
}

export default function useWorkingCopy(project: Project | null, onUpdate: (next: Project) => void) {
  const [draft, setDraft] = useState<Draft | null>(null);
  const [saving, setSaving] = useState(false);
  const [localSaved, setLocalSaved] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [conflict, setConflict] = useState<Project | null>(null);
  const current = useRef({ project, draft, onUpdate });
  current.current = { project, draft, onUpdate };
  const operation = useRef<symbol | null>(null);

  useEffect(() => {
    operation.current = null;
    setSaving(false); setError(null); setConflict(null);
    setLocalSaved(true);
    if (!project) { setDraft(null); return; }
    const next = recover(project);
    if (next.source === project.generatedSource) next.baseRevision = project.revision;
    else if (next.baseRevision !== project.revision) setConflict(project);
    setDraft(next);
  }, [project?.id]);

  function remember(next: Draft, savedSource?: string) {
    try {
      if (next.source === savedSource) sessionStorage.removeItem(key(next.id));
      else sessionStorage.setItem(key(next.id), JSON.stringify(next));
      setLocalSaved(true);
    } catch {
      setLocalSaved(false);
      setError('Не удалось сохранить черновик в браузере. Сохраните код кнопкой «Обновить граф».');
    }
  }

  function changeSource(source: string) {
    const state = current.current;
    if (!state.project) return;
    const next = { id: state.project.id, baseRevision: state.draft?.baseRevision ?? state.project.revision, source };
    current.current = { ...state, draft: next };
    setDraft(next);
    remember(next, state.project.generatedSource);
  }

  async function rebuild(overwrite?: Project) {
    const state = current.current;
    if (!state.project || operation.current) return;
    const id = state.project.id;
    const snapshot = state.draft ?? { id, source: state.project.generatedSource, baseRevision: state.project.revision };
    const token = Symbol(); operation.current = token;
    const active = () => operation.current === token && current.current.project?.id === id;
    setSaving(true); setError(null);
    try {
      const saved = await api.saveSource(id, overwrite?.revision ?? snapshot.baseRevision, snapshot.source);
      if (!active()) return;
      const latest = { ...(current.current.draft ?? snapshot), baseRevision: saved.revision };
      current.current = { ...current.current, project: saved, draft: latest };
      setDraft(latest); setConflict(null); remember(latest, saved.generatedSource);
      current.current.onUpdate(saved);
      const rebuilt = await api.rebuild(id, saved.revision);
      if (active()) current.current.onUpdate(rebuilt);
    } catch (reason) {
      if (!active()) return;
      if (reason instanceof ApiError && reason.status === 409) {
        try {
          const remote = await api.project(id);
          if (active()) setConflict(remote);
        } catch { /* Keep the local text and original conflict message. */ }
      }
      if (active()) setError(reason instanceof Error ? reason.message : 'Не удалось обновить граф');
    } finally {
      if (active()) { operation.current = null; setSaving(false); }
    }
  }

  function useServerCopy() {
    if (!conflict || conflict.id !== current.current.project?.id) return;
    const next = { id: conflict.id, source: conflict.generatedSource, baseRevision: conflict.revision };
    current.current = { ...current.current, project: conflict, draft: next };
    setDraft(next); setConflict(null); setError(null);
    remember(next, conflict.generatedSource); onUpdate(conflict);
  }

  const source = draft?.id === project?.id ? draft?.source ?? '' : project?.generatedSource ?? '';
  const dirty = !!project && source !== project.generatedSource;
  return { source, dirty, saving, localSaved, error, conflict, changeSource, rebuild, useServerCopy };
}
