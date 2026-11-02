export function mp4(options?: { brand?: string; seconds?: number }): { file: Uint8Array; sampleAt: number[] };
export function webm(options?: { durationMs?: number }): Uint8Array;
