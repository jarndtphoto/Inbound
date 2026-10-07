// Test-only adapter. Callers install globalThis.fetch fixtures before invoking
// story aggregation; this module neither opens SQL nor changes production code.
export async function acquireFreeAdsb(request) {
  const receivedAt = Date.now();
  try {
    const response = await globalThis.fetch(request.url, {
      headers: { Accept: 'application/json' },
      signal: AbortSignal.timeout(request.timeoutMs),
    });
    if (!response.ok) return {
      data: null, receivedAt: null, cache: false,
      status: response.status === 403 ? '403' : response.status === 429 ? '429' : 'error',
    };
    return { data: await response.json(), receivedAt, status: 'ok', cache: false };
  } catch (error) {
    return { data: null, receivedAt: null, cache: false,
      status: /abort|timeout/i.test(`${error?.name} ${error?.message}`) ? 'timeout' : 'error' };
  }
}
