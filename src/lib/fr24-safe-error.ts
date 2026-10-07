/** Deliberately excludes arbitrary response bodies, cookies and request headers. */
export async function safeFr24ErrorDetails(response: Response, token: string) {
  const clean = (value: unknown) => {
    if (typeof value !== "string") return null;
    return value.split(token || "\u0000").join("[redacted]")
      .replace(/Bearer\s+\S+/gi, "Bearer [redacted]")
      .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/gi, "[redacted]")
      .split("").map(character => character.charCodeAt(0) < 32 ? " " : character).join("").slice(0, 240);
  };
  const headers: Record<string, string> = {};
  for (const key of ["content-type", "retry-after", "x-request-id", "request-id"]) {
    const value = clean(response.headers.get(key));
    if (value) headers[key] = value;
  }
  let code: string | null = null, message: string | null = null;
  const reader = response.body?.getReader();
  if (reader) {
    const chunks: Uint8Array[] = []; let length = 0;
    try {
      while (length <= 4096) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length <= 4096) chunks.push(next.value);
      }
      if (length <= 4096) {
        const body = JSON.parse(new TextDecoder().decode(Uint8Array.from(chunks.flatMap(chunk => [...chunk]))));
        code = clean(body?.code ?? body?.error?.code);
        message = clean(body?.message ?? body?.error?.message);
      }
    } catch { /* Non-JSON errors have no safe structured diagnostic. */ }
    finally { await reader.cancel().catch(() => undefined); }
  }
  return { code, message, headers };
}
