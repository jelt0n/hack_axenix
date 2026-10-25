import type { Project } from './types';

export type Draft = { id: string; fileId: string; source: string; baseRevision: number };
const key = (id: string, fileId: string) => `java-draft:${id}:${fileId}`;
const legacyKey = (id: string) => `java-draft:${id}`;

export function loadDraft(project: Project): Draft {
  try {
    const legacy = project.fileId.startsWith('file-') ? sessionStorage.getItem(legacyKey(project.id)) : null;
    const saved = JSON.parse(sessionStorage.getItem(key(project.id, project.fileId)) || legacy || 'null');
    if (saved && typeof saved.source === 'string' && Number.isInteger(saved.baseRevision)) {
      return { id: project.id, fileId: project.fileId, source: saved.source, baseRevision: saved.baseRevision };
    }
  } catch { /* A server copy remains available when storage is unavailable. */ }
  return { id: project.id, fileId: project.fileId, source: project.generatedSource, baseRevision: project.revision };
}

export function removeDraft(id: string, fileId: string) {
  sessionStorage.removeItem(key(id,fileId));
  if (fileId.startsWith('file-')) sessionStorage.removeItem(legacyKey(id));
}

export function storeDraft(draft: Draft, savedSource?: string) {
  if(draft.source === savedSource) removeDraft(draft.id,draft.fileId);
  else {
    sessionStorage.setItem(key(draft.id,draft.fileId),JSON.stringify(draft));
    if(draft.fileId.startsWith('file-')) sessionStorage.removeItem(legacyKey(draft.id));
  }
}

export function hasDrafts(project: Project): boolean {
  return project.files.some(file => sessionStorage.getItem(key(project.id,file.id)) !== null
    || (file.id.startsWith('file-') && sessionStorage.getItem(legacyKey(project.id)) !== null));
}
