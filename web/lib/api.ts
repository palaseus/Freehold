export class ApiError extends Error {
  constructor(public status: number, public body: unknown) { super(errorCode(body)); }
}
export function errorCode(body: unknown): string {
  if (body && typeof body === 'object') {
    const record = body as Record<string, unknown>;
    const code = record.code ?? (typeof record.error === 'string' && /^[A-Z0-9_]+$/.test(record.error) ? record.error : record.message ?? record.error);
    if (Array.isArray(code)) return code.join(' · ');
    if (typeof code === 'string') return code;
  }
  return 'UNCONFIRMED_RESPONSE';
}
export async function api<T>(path: string, options: RequestInit = {}): Promise<T> {
  let response: Response;
  try { response = await fetch(`/api${path}`, { ...options, cache: 'no-store', credentials: 'same-origin' }); }
  catch (error) { if (error instanceof DOMException && error.name === 'AbortError') throw error; throw new ApiError(0, { code: 'NETWORK_UNAVAILABLE' }); }
  const body = response.status === 204 ? null : await response.json().catch(() => ({ code: 'INVALID_API_RESPONSE' }));
  if (!response.ok) {
    if (response.status === 401 && !path.includes('/login')) window.dispatchEvent(new Event('freehold:expired'));
    throw new ApiError(response.status, body);
  }
  return body as T;
}
export function post<T>(path: string, body: unknown, csrf?: string, key?: string) {
  return api<T>(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(csrf ? { 'X-CSRF-Token': csrf } : {}), ...(key ? { 'Idempotency-Key': key } : {}) }, body: JSON.stringify(body) });
}
