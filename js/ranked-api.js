export const API_BASE = 'https://dota-chaos-ranked-api.finflow-eljke.workers.dev';
export const TOKEN_KEY = 'dcb-ranked-session';

export function sessionToken() {
  return localStorage.getItem(TOKEN_KEY) || '';
}

export async function rankedRequest(path, options = {}) {
  const headers = { ...(options.body ? { 'Content-Type': 'application/json' } : {}), ...(options.headers || {}) };
  const token = sessionToken();
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(`${API_BASE}${path}`, { cache: 'no-store', ...options, headers });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.error || `HTTP ${response.status}`);
    error.body = body;
    error.status = response.status;
    throw error;
  }
  return body;
}
