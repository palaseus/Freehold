import type { NextRequest } from 'next/server';
import { copyAllowedProxyHeaders } from '@/lib/proxy-headers.mjs';
import { routeAllowed } from '@/lib/proxy-routes.mjs';
export const dynamic = 'force-dynamic';
async function readPost(request: NextRequest): Promise<ArrayBuffer | Response> {
  const limit = 16 * 1024;
  const reject = () => Response.json({ code: 'INPUT_TOO_LARGE' }, { status: 413, headers: { 'Cache-Control': 'no-store' } });
  if (Number(request.headers.get('content-length')) > limit) return reject();
  const reader = request.body?.getReader(); if (!reader) return new ArrayBuffer(0);
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read(); if (done) break;
      length += value.length;
      if (length > limit) { await reader.cancel(); return reject(); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  const body = new Uint8Array(length); let offset = 0;
  for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.length; }
  return body.buffer;
}
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const resource = path.join('/');
  if (!routeAllowed(request.method, resource)) {
    return Response.json({ code: 'ROUTE_NOT_AVAILABLE' }, { status: 404 });
  }
  const headers = copyAllowedProxyHeaders(request.headers);
  const url = new URL(`/${resource}`, process.env.API_ORIGIN ?? 'http://localhost:3001');
  url.search = request.nextUrl.search;
  try {
    const body = request.method === 'POST' ? await readPost(request) : undefined;
    if (body instanceof Response) return body;
    const upstream = await fetch(url, { method: request.method, headers, cache: 'no-store', redirect: 'manual',
      body, signal: AbortSignal.timeout(20000) });
    const outgoing = new Headers({ 'Cache-Control': 'no-store' });
    if (upstream.headers.get('content-type')) outgoing.set('content-type', upstream.headers.get('content-type')!);
    if (upstream.headers.get('content-disposition')) outgoing.set('content-disposition', upstream.headers.get('content-disposition')!);
    for (const cookie of upstream.headers.getSetCookie()) outgoing.append('set-cookie', cookie);
    return new Response(upstream.status === 204 ? null : await upstream.arrayBuffer(), { status: upstream.status, headers: outgoing });
  } catch {
    return Response.json({ code: 'API_UNAVAILABLE', message: 'The API could not confirm this request. Retry with the same Idempotency-Key.' }, { status: 503, headers: { 'Cache-Control': 'no-store' } });
  }
}
export const GET = proxy;
export const POST = proxy;
