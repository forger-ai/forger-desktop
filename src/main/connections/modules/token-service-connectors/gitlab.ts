import type { TokenConnectorActionDefinition } from '../token-connector';
import { arraySchema, clean, fail, json, moduleFrom, objectSchema, record, req, reqNum, schema, secret } from './helpers';
const base = (s: Record<string, string>) => (clean(s.base_url) || 'https://gitlab.com').replace(/\/+$/, '').replace(/\/api\/v4$/i, '') + '/api/v4';
const api = (s: Record<string, string>, path: string, init: RequestInit = {}) =>
  json(`${base(s)}${path}`, { ...init, headers: { 'PRIVATE-TOKEN': s.api_token, ...(init.headers ?? {}) } }, 'gitlab');
const project = (input: Record<string, unknown>) => req(input, 'projectId', 'gitlab_project_required');
const listAction = (id: string, name: string, path: (input: Record<string, unknown>) => string | null, key: string): TokenConnectorActionDefinition => ({
  id, name, description: `${name} de GitLab.`, risk: 'medium',
  inputSchema: schema({ projectId: { type: 'string' }, state: { type: 'string' }, limit: { type: 'number' } }), outputSchema: arraySchema(key),
  run: async ({ input, secrets }) => {
    const suffix = path(input); if (!suffix) return fail('gitlab_project_required');
    const qs = new URLSearchParams({ per_page: String(input.limit ?? 25) }); if (clean(input.state)) qs.set('state', clean(input.state));
    const data = await api(secrets, `${suffix}?${qs.toString()}`);
    return { success: true, data: { [key]: Array.isArray(data) ? data : [] } };
  },
});
const issuePath = (input: Record<string, unknown>) => {
  const id = clean(input.projectId); return id ? `/projects/${encodeURIComponent(id)}/issues` : null;
};
const mrPath = (input: Record<string, unknown>) => {
  const id = clean(input.projectId); return id ? `/projects/${encodeURIComponent(id)}/merge_requests` : null;
};
const pipePath = (input: Record<string, unknown>) => {
  const id = clean(input.projectId); return id ? `/projects/${encodeURIComponent(id)}/pipelines` : null;
};
const actions: TokenConnectorActionDefinition[] = [
  listAction('gitlab.list_projects', 'Listar proyectos', () => '/projects', 'projects'),
  listAction('gitlab.list_issues', 'Listar issues', issuePath, 'issues'),
  listAction('gitlab.list_merge_requests', 'Listar merge requests', mrPath, 'mergeRequests'),
  listAction('gitlab.list_pipelines', 'Listar pipelines', pipePath, 'pipelines'),
  {
    id: 'gitlab.get_project', name: 'Leer proyecto', description: 'Obtiene un proyecto.', risk: 'medium',
    inputSchema: schema({ projectId: { type: 'string' } }, ['projectId']), outputSchema: objectSchema('project'),
    run: async ({ input, secrets }) => { const id = project(input); return typeof id === 'string' ? { success: true, data: { project: await api(secrets, `/projects/${encodeURIComponent(id)}`) } } : id; },
  },
  {
    id: 'gitlab.get_issue', name: 'Leer issue', description: 'Obtiene un issue.', risk: 'medium',
    inputSchema: schema({ projectId: { type: 'string' }, issueIid: { type: 'number' } }, ['projectId', 'issueIid']), outputSchema: objectSchema('issue'),
    run: async ({ input, secrets }) => {
      const id = project(input); const iid = reqNum(input, 'issueIid', 'gitlab_issue_required');
      if (typeof id !== 'string') return id; if (typeof iid !== 'number') return iid;
      return { success: true, data: { issue: await api(secrets, `/projects/${encodeURIComponent(id)}/issues/${iid}`) } };
    },
  },
  {
    id: 'gitlab.create_issue', name: 'Crear issue', description: 'Crea un issue.', risk: 'high',
    inputSchema: schema({ projectId: { type: 'string' }, title: { type: 'string' }, description: { type: 'string' } }, ['projectId', 'title']), outputSchema: objectSchema('issue'),
    run: async ({ input, secrets }) => {
      const id = project(input); const title = req(input, 'title', 'gitlab_title_required');
      if (typeof id !== 'string') return id; if (typeof title !== 'string') return title;
      const issue = await api(secrets, `/projects/${encodeURIComponent(id)}/issues`, { method: 'POST', body: JSON.stringify({ title, description: clean(input.description) }) });
      return { success: true, userMessage: 'Issue creado en GitLab.', data: { issue } };
    },
  },
  {
    id: 'gitlab.update_issue', name: 'Actualizar issue', description: 'Actualiza un issue.', risk: 'high',
    inputSchema: schema({ projectId: { type: 'string' }, issueIid: { type: 'number' }, title: { type: 'string' }, stateEvent: { type: 'string' } }, ['projectId', 'issueIid']), outputSchema: objectSchema('issue'),
    run: async ({ input, secrets }) => {
      const id = project(input); const iid = reqNum(input, 'issueIid', 'gitlab_issue_required');
      if (typeof id !== 'string') return id; if (typeof iid !== 'number') return iid;
      const issue = await api(secrets, `/projects/${encodeURIComponent(id)}/issues/${iid}`, { method: 'PUT', body: JSON.stringify({ title: clean(input.title) || undefined, state_event: clean(input.stateEvent) || undefined }) });
      return { success: true, data: { issue } };
    },
  },
  {
    id: 'gitlab.create_issue_note', name: 'Comentar issue', description: 'Comenta un issue.', risk: 'high',
    inputSchema: schema({ projectId: { type: 'string' }, issueIid: { type: 'number' }, body: { type: 'string' } }, ['projectId', 'issueIid', 'body']), outputSchema: objectSchema('note'),
    run: async ({ input, secrets }) => {
      const id = project(input); const iid = reqNum(input, 'issueIid', 'gitlab_issue_required'); const body = req(input, 'body', 'gitlab_body_required');
      if (typeof id !== 'string') return id; if (typeof iid !== 'number') return iid; if (typeof body !== 'string') return body;
      return { success: true, data: { note: await api(secrets, `/projects/${encodeURIComponent(id)}/issues/${iid}/notes`, { method: 'POST', body: JSON.stringify({ body }) }) } };
    },
  },
  {
    id: 'gitlab.get_merge_request', name: 'Leer merge request', description: 'Obtiene un MR.', risk: 'medium',
    inputSchema: schema({ projectId: { type: 'string' }, mergeRequestIid: { type: 'number' } }, ['projectId', 'mergeRequestIid']), outputSchema: objectSchema('mergeRequest'),
    run: async ({ input, secrets }) => {
      const id = project(input); const iid = reqNum(input, 'mergeRequestIid', 'gitlab_mr_required');
      if (typeof id !== 'string') return id; if (typeof iid !== 'number') return iid;
      return { success: true, data: { mergeRequest: await api(secrets, `/projects/${encodeURIComponent(id)}/merge_requests/${iid}`) } };
    },
  },
  {
    id: 'gitlab.create_merge_request_note', name: 'Comentar merge request', description: 'Comenta un MR.', risk: 'high',
    inputSchema: schema({ projectId: { type: 'string' }, mergeRequestIid: { type: 'number' }, body: { type: 'string' } }, ['projectId', 'mergeRequestIid', 'body']), outputSchema: objectSchema('note'),
    run: async ({ input, secrets }) => {
      const id = project(input); const iid = reqNum(input, 'mergeRequestIid', 'gitlab_mr_required'); const body = req(input, 'body', 'gitlab_body_required');
      if (typeof id !== 'string') return id; if (typeof iid !== 'number') return iid; if (typeof body !== 'string') return body;
      return { success: true, data: { note: await api(secrets, `/projects/${encodeURIComponent(id)}/merge_requests/${iid}/notes`, { method: 'POST', body: JSON.stringify({ body }) }) } };
    },
  },
];
export const gitlabToolModule = moduleFrom({
  id: 'gitlab', name: 'GitLab', description: 'Lee proyectos, issues, merge requests y pipelines de GitLab.',
  secrets: [secret('api_token', 'Access token de GitLab', 'Personal, project o group access token.'), secret('base_url', 'URL base de GitLab', 'Usa https://gitlab.com si se deja vacio.', false)],
  validate: async (secrets) => { const user = record(await api(secrets, '/user')); return { ok: true, data: { subject: String(user.id ?? ''), email: clean(user.email), username: clean(user.username) } }; },
  actions,
});
