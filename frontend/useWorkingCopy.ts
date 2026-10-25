import { useEffect, useRef, useState } from 'react';
import { api, ApiError } from './api';
import { loadDraft, storeDraft, hasDrafts, type Draft } from './drafts';
import type { ExtractionPreview, BranchPreview, GraphEdit, Project } from './types';

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
    const next = loadDraft(project);
    if (next.source === project.generatedSource) next.baseRevision = project.revision;
    else if (next.baseRevision !== project.revision) setConflict(project);
    setDraft(next);
  }, [project?.id, project?.fileId]);

  function remember(next: Draft, savedSource?: string) {
    try {
      storeDraft(next, savedSource);
      setLocalSaved(true);
    } catch {
      setLocalSaved(false);
      setError('Не удалось сохранить черновик в браузере. Сохраните код кнопкой «Обновить граф»; переключение файлов пока отключено.');
    }
  }

  function changeSource(source: string) {
    const state = current.current;
    if (!state.project) return;
    const next = { id: state.project.id, fileId: state.project.fileId, baseRevision: state.draft?.fileId === state.project.fileId ? state.draft.baseRevision : state.project.revision, source };
    current.current = { ...state, draft: next };
    setDraft(next);
    remember(next, state.project.generatedSource);
  }

  function beginOperation(id: string) {
    const fileId = current.current.project?.fileId;
    const token = Symbol(); operation.current = token;
    setSaving(true); setError(null);
    return () => operation.current === token && current.current.project?.id === id && current.current.project?.fileId === fileId;
  }

  function finishOperation(active: () => boolean) {
    if (active()) { operation.current = null; setSaving(false); }
  }

  async function showFailure(id: string, active: () => boolean, reason: unknown, fallback: string) {
    if (!active()) return;
    if (reason instanceof ApiError && reason.status === 409) {
      try {
        const remote = await api.project(id, current.current.project?.fileId);
        if (active()) setConflict(remote);
      } catch { /* Keep the local text and the original conflict message. */ }
    }
    if (active()) setError(reason instanceof Error ? reason.message : fallback);
  }

  async function rebuild(overwrite?: Project) {
    const state = current.current;
    if (!state.project || operation.current) return;
    const id = state.project.id;
    const snapshot = (state.draft?.fileId === state.project.fileId ? state.draft : null) ?? { id, fileId: state.project.fileId, source: state.project.generatedSource, baseRevision: state.project.revision };
    const active = beginOperation(id);
    try {
      const saved = await api.saveSource(id, overwrite?.revision ?? snapshot.baseRevision, snapshot.source, state.project.fileId);
      if (!active()) return;
      const latest = { ...(current.current.draft ?? snapshot), baseRevision: saved.revision };
      current.current = { ...current.current, project: saved, draft: latest };
      setDraft(latest); setConflict(null); remember(latest, saved.generatedSource);
      current.current.onUpdate(saved);
      const rebuilt = await api.rebuild(id, saved.revision, saved.fileId);
      if (active()) current.current.onUpdate(rebuilt);
    } catch (reason) {
      await showFailure(id, active, reason, 'Не удалось обновить граф');
    } finally {
      finishOperation(active);
    }
  }

  function useServerCopy() {
    if (!conflict || conflict.id !== current.current.project?.id) return;
    const next = { id: conflict.id, fileId: conflict.fileId, source: conflict.generatedSource, baseRevision: conflict.revision };
    current.current = { ...current.current, project: conflict, draft: next };
    setDraft(next); setConflict(null); setError(null);
    remember(next, conflict.generatedSource); onUpdate(conflict);
  }

  async function applySourceChange(change: (project: Project) => Promise<Project>) {
    const state = current.current;
    if (!state.project || operation.current || conflict) return;
    const id = state.project.id;
    const source = state.draft?.source ?? state.project.generatedSource;
    if (source !== state.project.generatedSource || state.project.revision !== state.project.graphRevision) return;
    const active = beginOperation(id);
    try {
      const next = await change(state.project);
      if (!active()) return;
      const latest = current.current.draft;
      if (latest && latest.source !== source) {
        setConflict(next);
        setError('Во время правки графа изменился текст. Черновик сохранён; выберите нужную версию.');
        current.current.onUpdate(next);
      } else {
        const draft = { id, fileId: next.fileId, source: next.generatedSource, baseRevision: next.revision };
        current.current = { ...current.current, project: next, draft };
        setDraft(draft); setConflict(null); remember(draft, next.generatedSource);
        current.current.onUpdate(next);
        return next;
      }
    } catch (reason) {
      await showFailure(id, active, reason, 'Не удалось изменить граф');
    } finally {
      finishOperation(active);
    }
  }

  async function editGraph(edit: GraphEdit) {
    await applySourceChange(current => api.editGraph(current.id, current.revision, edit, current.fileId));
  }

  async function applyTransformation(preview: BranchPreview | ExtractionPreview) {
    if (current.current.project?.id !== preview.projectId
        || current.current.project?.revision !== preview.sourceRevision || current.current.project?.fileId !== preview.fileId) return;
    return applySourceChange(() => 'nodeId' in preview ? api.applyBranch(preview) : api.applyExtraction(preview));
  }

  function acceptFileChange(next: Project) {
    const state = current.current;
    const updated = { id: next.id, fileId: next.fileId, source: state.draft?.source ?? next.generatedSource, baseRevision: next.revision };
    current.current = { ...state, project: next, draft: updated };
    setDraft(updated); remember(updated, next.generatedSource); state.onUpdate(next);
  }

  let pendingFiles = false;
  try {
    pendingFiles = !!project && hasDrafts(project);
  } catch { /* Current draft is still tracked in React state. */ }
  const source = draft?.id === project?.id && draft?.fileId === project?.fileId ? draft?.source ?? '' : project?.generatedSource ?? '';
  const dirty = !!project && source !== project.generatedSource;
  return { source, dirty, pendingFiles, acceptFileChange, saving, localSaved, error, conflict, changeSource, rebuild, useServerCopy, editGraph, applyTransformation };
}
