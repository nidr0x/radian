export interface Mp4Inspection {
  brand: string;
  durationSec: number | null;
  width: number;
  height: number;
  codec: string | null;
  handlers: string[];
}

export interface WebmInspection {
  durationSec: number | null;
  width: number;
  height: number;
  codec: string | null;
}

export function sniffKind(bytes: Uint8Array): { mime: string; kind: string; category: string; input?: boolean } | null;
export function inspectMp4(bytes: Uint8Array): Mp4Inspection | null;
export function inspectWebm(bytes: Uint8Array): WebmInspection | null;
