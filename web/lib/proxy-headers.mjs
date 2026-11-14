const forwardedHeaders = ['cookie', 'origin', 'content-type', 'x-csrf-token', 'idempotency-key'];

export function copyAllowedProxyHeaders(requestHeaders) {
  const headers = new Headers();
  for (const name of forwardedHeaders) {
    const value = requestHeaders.get(name);
    if (value) headers.set(name, value);
  }
  return headers;
}
