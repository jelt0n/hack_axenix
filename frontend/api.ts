import type { ExtractionSelection, ExtractionPreview, BranchPreview, AnalysisReport, CheckJob, GraphEdit, MethodGraph, Project, Scenario } from './types';

const fileUrl = (url: string, fileId?: string) => fileId ? `${url}?fileId=${encodeURIComponent(fileId)}` : url;

type FailureDetail = string | { message?: string; errors?: { message: string; line: number }[] }
  | { msg: string }[];

async function request<T>(url: string, options?: RequestInit): Promise<T> {
  const response = await fetch(url, { credentials: 'same-origin', ...options });
  if (!response.ok) {
    const data = await response.json().catch(() => ({ detail: 'Сервис недоступен. Попробуйте ещё раз.' }));
    const detail = data.detail as FailureDetail;
    if (typeof detail === 'string') throw new ApiError(detail, response.status);
    if (Array.isArray(detail)) throw new Error(detail.map(item => item.msg).join('. '));
    const first = detail.errors?.[0];
    throw new Error(first ? `Строка ${first.line}: ${first.message}` : detail.message || 'Не удалось разобрать файл');
  }
  return response.json() as Promise<T>;
}

export class ApiError extends Error {
  constructor(message: string, public status: number) { super(message); }
}

export const api = {
  addFile: (project: Project, path: string, source: string) => request<Project>(`/api/projects/${encodeURIComponent(project.id)}/files`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({revision:project.revision,path,source}),
  }),
  renameFile: (project: Project, path: string) => request<Project>(`/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(project.fileId)}`, {
    method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({revision:project.revision,path}),
  }),
  deleteFile: (project: Project) => request<Project>(`/api/projects/${encodeURIComponent(project.id)}/files/${encodeURIComponent(project.fileId)}?revision=${project.revision}`, {method:'DELETE'}),

  previewExtraction: (id: string, revision: number, selection: ExtractionSelection, fileId?: string) => request<ExtractionPreview>(
    fileUrl(`/api/projects/${encodeURIComponent(id)}/transformations/extract-method/preview`, fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision, ...selection }),
    },
  ),
  applyExtraction: (preview: ExtractionPreview) => request<Project>(
    fileUrl(`/api/projects/${encodeURIComponent(preview.projectId)}/transformations/extract-method/apply`, preview.fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: preview.sourceRevision, methodId: preview.methodId,
        startIndex: preview.startIndex, endIndex: preview.endIndex, methodName: preview.methodName, previewHash: preview.previewHash }),
    },
  ),
  previewBranch: (id: string, revision: number, methodId: string, nodeId: string, fileId?: string) => request<BranchPreview>(
    fileUrl(`/api/projects/${encodeURIComponent(id)}/transformations/constant-branch/preview`, fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, methodId, nodeId }),
    },
  ),
  applyBranch: (preview: BranchPreview) => request<Project>(
    fileUrl(`/api/projects/${encodeURIComponent(preview.projectId)}/transformations/constant-branch/apply`, preview.fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: preview.sourceRevision, methodId: preview.methodId,
        nodeId: preview.nodeId, previewHash: preview.previewHash }),
    },
  ),
  analyze: (id: string, revision: number, fileId?: string) => request<AnalysisReport>(
    fileUrl(`/api/projects/${encodeURIComponent(id)}/analysis`, fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }),
    },
  ),
  current: () => request<Project>('/api/projects/current'),
  project: (id: string, fileId?: string) => request<Project>(fileUrl(`/api/projects/${encodeURIComponent(id)}`, fileId)),
  saveSource: (id: string, revision: number, source: string, fileId?: string) => request<Project>(
    fileUrl(`/api/projects/${encodeURIComponent(id)}/source`, fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, source }),
    },
  ),
  rebuild: (id: string, revision: number, fileId?: string) => request<Project>(
    fileUrl(`/api/projects/${encodeURIComponent(id)}/rebuild`, fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }),
    },
  ),
  editGraph: (id: string, revision: number, edit: GraphEdit, fileId?: string) => request<Project>(
    fileUrl(`/api/projects/${encodeURIComponent(id)}/graph-edits`, fileId), {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...edit, revision }),
    },
  ),
  import: (filename: string, source: string) => request<Project>('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, source }),
  }),
  graph: (projectId: string, methodId: string, fileId?: string) => request<MethodGraph>(
    fileUrl(`/api/projects/${encodeURIComponent(projectId)}/methods/${encodeURIComponent(methodId)}/graph`, fileId),
  ),
  createCheck: (project: Project, scenarios: Scenario[], mainClass: string, originalMainClass?: string) => request<CheckJob>(
    `/api/projects/${encodeURIComponent(project.id)}/checks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: project.revision, scenarios, mainClass, ...(originalMainClass ? {originalMainClass} : {}) }),
    },
  ),
  check: (id: string) => request<CheckJob>(`/api/checks/${encodeURIComponent(id)}`),
  latestCheck: (projectId: string) => request<CheckJob>(`/api/projects/${encodeURIComponent(projectId)}/checks/latest`),
  runner: () => request<{ available: boolean }>('/api/runner'),
};
