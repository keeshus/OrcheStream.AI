import type { APIRequestContext } from '@playwright/test';

export const E2E_USER = {
  name: 'E2E Test User',
  email: 'e2e@test.local',
  password: 'Test1234!',
};

const API_URL = process.env.E2E_API_URL || 'http://localhost:3001/api';
let flowCounter = Date.now();

export function uniqueFlowName(prefix: string): string {
  return `${prefix}-${++flowCounter}`;
}

export async function registerUser(request: APIRequestContext, user: { name: string; email: string; password: string }) {
  const res = await request.post(`${API_URL}/auth/register`, { data: user });
  return res;
}

export async function createFlow(request: APIRequestContext, flow: { name: string; description?: string; nodes?: any[]; edges?: any[]; group_id?: string | null; envVars?: any[] }) {
  const res = await request.post(`${API_URL}/flows`, { data: flow });
  return res;
}

export async function deleteFlow(request: APIRequestContext, id: string) {
  return request.delete(`${API_URL}/flows/${id}`);
}
