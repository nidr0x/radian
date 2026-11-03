export type TextReadResult =
  | { ok: true; value: string }
  | { ok: false; reason: 'too-large' | 'invalid-body' };

export type JsonReadResult =
  | { ok: true; value: Record<string, unknown> }
  | { ok: false; reason: 'too-large' | 'invalid-json' };

export const readSmallText = async (request: Request, maxBytes = 16_384): Promise<TextReadResult> => {
  const declaredLength = Number(request.headers.get('Content-Length'));
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) return { ok: false, reason: 'too-large' };
  const reader = request.body?.getReader();
  if (!reader) return { ok: false, reason: 'invalid-body' };

  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => {});
        return { ok: false, reason: 'too-large' };
      }
      text += decoder.decode(part.value, { stream: true });
    }
    text += decoder.decode();
    return { ok: true, value: text };
  } catch {
    return { ok: false, reason: 'invalid-body' };
  }
};

export const readSmallJson = async (request: Request, maxBytes = 16_384): Promise<JsonReadResult> => {
  const text = await readSmallText(request, maxBytes);
  if (!text.ok) return { ok: false, reason: text.reason === 'too-large' ? 'too-large' : 'invalid-json' };
  try {
    const value: unknown = JSON.parse(text.value);
    return typeof value === 'object' && value !== null ? { ok: true, value: value as Record<string, unknown> } : { ok: false, reason: 'invalid-json' };
  } catch {
    return { ok: false, reason: 'invalid-json' };
  }
};
