import { isRecord } from '../auth';

export type JsonReadResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'too-large' | 'invalid-json' };

export const readSmallJson = async (request: Request, maxBytes = 16_384): Promise<JsonReadResult> => {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { ok: false, reason: 'too-large' };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: 'invalid-json' };

  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const part = await reader.read();
    if (part.done) break;
    size += part.value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return { ok: false, reason: 'too-large' };
    }
    text += decoder.decode(part.value, { stream: true });
  }
  text += decoder.decode();
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? { ok: true, value } : { ok: false, reason: 'invalid-json' };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
};
