import type { AnalysisReport, CheckJob, MethodGraph, Project, Scenario } from './types';

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
  analyze: (id: string, revision: number) => request<AnalysisReport>(
    `/api/projects/${encodeURIComponent(id)}/analysis`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }),
    },
  ),
  current: () => request<Project>('/api/projects/current'),
  project: (id: string) => request<Project>(`/api/projects/${encodeURIComponent(id)}`),
  saveSource: (id: string, revision: number, source: string) => request<Project>(
    `/api/projects/${encodeURIComponent(id)}/source`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision, source }),
    },
  ),
  rebuild: (id: string, revision: number) => request<Project>(
    `/api/projects/${encodeURIComponent(id)}/rebuild`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ revision }),
    },
  ),
  import: (filename: string, source: string) => request<Project>('/api/projects', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ filename, source }),
  }),
  graph: (projectId: string, methodId: string) => request<MethodGraph>(
    `/api/projects/${encodeURIComponent(projectId)}/methods/${encodeURIComponent(methodId)}/graph`,
  ),
  createCheck: (project: Project, scenarios: Scenario[], mainClass: string) => request<CheckJob>(
    `/api/projects/${encodeURIComponent(project.id)}/checks`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ revision: project.revision, scenarios, mainClass }),
    },
  ),
  check: (id: string) => request<CheckJob>(`/api/checks/${encodeURIComponent(id)}`),
  latestCheck: (projectId: string) => request<CheckJob>(`/api/projects/${encodeURIComponent(projectId)}/checks/latest`),
  runner: () => request<{ available: boolean }>('/api/runner'),
};
