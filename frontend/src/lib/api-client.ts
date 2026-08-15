const BASE_URL = process.env.NEXT_PUBLIC_API_URL || '/api';
export const API_URL = BASE_URL;

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: { 'Content-Type': 'application/json', ...options?.headers },
    credentials: 'include',
    ...options,
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    const e = new Error(err.message || `Request failed: ${res.status}`) as Error & { status?: number };
    e.status = res.status;
    throw e;
  }
  if (res.status === 204) return undefined as T;
  return res.json();
}

/**
 * Stream SSE events from a POST endpoint.
 * Returns an async generator that yields parsed JSON events.
 */
export async function* streamSSE(url: string, body: unknown, signal?: AbortSignal): AsyncGenerator<any> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
    credentials: 'include',
    signal,
  });

  if (!res.ok) {
    const err = await res.json().catch(() => ({ message: res.statusText }));
    throw new Error(err.message || `Request failed: ${res.status}`);
  }
  if (!res.body) throw new Error('No response body');

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split('\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (line.startsWith('data: ')) {
        try {
          yield JSON.parse(line.slice(6));
        } catch {
          // Skip malformed SSE frames
        }
      }
    }
  }
}

export const api = {
  groups: {
    list: () => request<any[]>('/groups'),
    get: (id: string) => request<any>(`/groups/${id}`),
    create: (data: { name: string; description?: string }) => request<any>('/groups', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: { name?: string; description?: string }) => request<any>(`/groups/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/groups/${id}`, { method: 'DELETE' }),
    addMember: (groupId: string, userId: string) => request<any>(`/groups/${groupId}/members`, { method: 'POST', body: JSON.stringify({ userId }) }),
    removeMember: (groupId: string, userId: string) => request<void>(`/groups/${groupId}/members/${userId}`, { method: 'DELETE' }),
  },

  flows: {
    list: (params?: { limit?: number; offset?: number; search?: string; sort?: string; is_subflow?: boolean; trigger_type?: string; group_id?: string }) => {
      const q = new URLSearchParams();
      if (params?.limit) q.set('limit', String(params.limit));
      if (params?.offset) q.set('offset', String(params.offset));
      if (params?.search) q.set('search', params.search);
      if (params?.sort) q.set('sort', params.sort);
      if (params?.is_subflow !== undefined) q.set('is_subflow', String(params.is_subflow));
      if (params?.trigger_type) q.set('trigger_type', params.trigger_type);
      if (params?.group_id) q.set('group_id', params.group_id);
      const qs = q.toString() ? `?${q.toString()}` : '';
      return request<{ data: any[]; total: number }>(`/flows${qs}`);
    },
    get: (id: string) => request<any>(`/flows/${id}`),
    checkName: (name: string, excludeId?: string) =>
      request<{ available: boolean }>(`/flows/check-name?name=${encodeURIComponent(name)}${excludeId ? `&exclude=${encodeURIComponent(excludeId)}` : ''}`),
    create: (data: { id?: string; name: string; description?: string; nodes?: any[]; edges?: any[]; group_id?: string | null }) =>
      request<any>('/flows', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) =>
      request<any>(`/flows/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/flows/${id}`, { method: 'DELETE' }),
    execute: async (id: string, input?: Record<string, unknown>, signal?: AbortSignal, envOverrides?: Record<string, string | { type: string; value: string }>) => {
      const res = await fetch(`${BASE_URL}/flows/${id}/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'include',
        body: JSON.stringify({ input, envOverrides }),
        signal,
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ message: res.statusText }));
        throw new Error(err.message || `Request failed: ${res.status}`);
      }
      // Consume first SSE event to confirm execution started, then cancel
      const reader = res.body?.getReader();
      if (reader) {
        const decoder = new TextDecoder();
        let buffer = '';
        const start = Date.now();
        while (Date.now() - start < 10000) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          if (buffer.includes('\n\n') || buffer.includes('execution')) break;
        }
        reader.cancel();
      }
    },
    executeStream: (id: string, input?: Record<string, unknown>, signal?: AbortSignal, envOverrides?: Record<string, string | { type: string; value: string }>) =>
      streamSSE(`${BASE_URL}/flows/${id}/execute`, { input, envOverrides }, signal),
  },
  catalog: {
    list: () => request<any[]>('/catalog'),
  },
  llmEndpoints: {
    list: (params?: { groupId?: string }) => {
      const q = params?.groupId ? `?group_id=${encodeURIComponent(params.groupId)}` : '';
      return request<any[]>(`/llm-endpoints${q}`);
    },
    get: (id: string) => request<any>(`/llm-endpoints/${id}`),
    create: (data: any) => request<any>('/llm-endpoints', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<any>(`/llm-endpoints/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/llm-endpoints/${id}`, { method: 'DELETE' }),
  },
  mcpServers: {
    list: (params?: { groupId?: string }) => {
      const q = params?.groupId ? `?group_id=${encodeURIComponent(params.groupId)}` : '';
      return request<any[]>(`/mcp-servers${q}`);
    },
    get: (id: string) => request<any>(`/mcp-servers/${id}`),
    create: (data: any) => request<any>('/mcp-servers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<any>(`/mcp-servers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/mcp-servers/${id}`, { method: 'DELETE' }),
    refreshTools: (id: string) => request<any>(`/mcp-servers/${id}/refresh`, { method: 'POST' }),
  },
  embeddingProviders: {
    list: (params?: { groupId?: string }) => {
      const q = params?.groupId ? `?group_id=${encodeURIComponent(params.groupId)}` : '';
      return request<any[]>(`/embedding-providers${q}`);
    },
    create: (data: any) => request<any>('/embedding-providers', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<any>(`/embedding-providers/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/embedding-providers/${id}`, { method: 'DELETE' }),
  },
  vectorStores: {
    list: (params?: { groupId?: string }) => {
      const q = params?.groupId ? `?group_id=${encodeURIComponent(params.groupId)}` : '';
      return request<any[]>(`/vector-stores${q}`);
    },
    create: (data: any) => request<any>('/vector-stores', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<any>(`/vector-stores/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/vector-stores/${id}`, { method: 'DELETE' }),
    refresh: (id: string) => request<any>(`/vector-stores/${id}/refresh`, { method: 'POST' }),
  },
  secretVaults: {
    list: (params?: { groupId?: string }) => request<any[]>('/secret-vaults' + (params?.groupId ? `?group_id=${encodeURIComponent(params.groupId)}` : '')),
    get: (id: string) => request<any>(`/secret-vaults/${id}`),
    create: (data: any) => request<any>('/secret-vaults', { method: 'POST', body: JSON.stringify(data) }),
    update: (id: string, data: any) => request<any>(`/secret-vaults/${id}`, { method: 'PUT', body: JSON.stringify(data) }),
    delete: (id: string) => request<void>(`/secret-vaults/${id}`, { method: 'DELETE' }),
    test: (id: string) => request<any>(`/secret-vaults/${id}/test`, { method: 'POST' }),
  },
  auth: {
    profile: () => request<any>('/auth/profile'),
    updateProfile: (data: { name?: string; email?: string }) =>
      request<any>('/auth/profile', { method: 'PUT', body: JSON.stringify(data) }),
    changePassword: (data: { currentPassword: string; newPassword: string }) =>
      request<any>('/auth/password', { method: 'PUT', body: JSON.stringify(data) }),
  },
};
