// Which attachments a provider can actually read. Pure logic (no Node APIs) so the UI shares it.
import type { Attachment, AttachmentKind, ProviderProfile } from './types';

export type Reason = 'no-vision' | 'image-format' | 'legacy-office' | 'no-audio' | 'no-video' | 'binary' | 'scanned-pdf';

export interface Readability {
  ok: boolean;
  /** How the agent gets at the content. */
  via?: 'native' | 'extracted-text' | 'folder';
  reason?: Reason;
}

export function readability(a: Pick<Attachment, 'kind' | 'companion'>, profile: ProviderProfile | undefined): Readability {
  const p = profile ?? {};
  const kind: AttachmentKind = a.kind ?? 'binary';
  switch (kind) {
    case 'text':
      return { ok: true, via: 'native' };
    case 'image':
      return p.vision === false ? { ok: false, reason: 'no-vision' } : { ok: true, via: 'native' };
    case 'image-other':
      return { ok: false, reason: 'image-format' };
    case 'pdf':
      if (p.pdf) return { ok: true, via: 'native' };
      if (a.companion?.note?.startsWith('scanned')) return p.vision === false ? { ok: false, reason: 'scanned-pdf' } : { ok: true, via: 'native' };
      return { ok: true, via: 'extracted-text' };
    case 'office':
    case 'notebook':
      return { ok: true, via: 'extracted-text' };
    case 'archive':
      return { ok: true, via: 'folder' };
    case 'legacy-office':
      return { ok: false, reason: 'legacy-office' };
    case 'audio':
      return p.audio ? { ok: true, via: 'native' } : { ok: false, reason: 'no-audio' };
    case 'video':
      return p.video ? { ok: true, via: 'native' } : { ok: false, reason: 'no-video' };
    default:
      return { ok: false, reason: 'binary' };
  }
}

/** A provider's profile narrowed to what one model reads (its input types, when known). */
export function profileForInputs(profile: ProviderProfile | undefined, inputs: string[] | undefined): ProviderProfile | undefined {
  if (!inputs) return profile;
  return { ...profile, vision: inputs.includes('image'), pdf: inputs.includes('pdf') || undefined, audio: inputs.includes('audio'), video: inputs.includes('video') };
}

/** English explanation used inside prompts. */
export const REASON_EN: Record<Reason, string> = {
  'no-vision': 'you cannot view images',
  'image-format': 'this image format (e.g. HEIC/TIFF) is not supported; ask for PNG or JPG',
  'legacy-office': 'old binary Office format; ask for .docx/.xlsx/.pptx or PDF',
  'no-audio': 'you cannot process audio',
  'no-video': 'you cannot process video',
  binary: 'it is a binary file with no readable text',
  'scanned-pdf': 'it is a scanned PDF without a text layer and you cannot view images',
};
