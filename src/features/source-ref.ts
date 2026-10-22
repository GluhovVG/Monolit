import type { UploadMeta } from './workspace';

/** Ссылка на источник цифры: тип загрузки + номер сделки (для ТКП) или имя файла (для файлов подразделений). */
export type SourceRef = { kind: UploadMeta['kind']; b24?: number | null; fileName?: string };

export function findUpload(uploads: readonly UploadMeta[], ref: SourceRef): UploadMeta | undefined {
  if (ref.fileName) return uploads.find(u => u.fileName === ref.fileName && u.kind === ref.kind);
  if (ref.kind === 'tkp') return ref.b24 !== null && ref.b24 !== undefined ? uploads.find(u => u.kind === 'tkp' && u.department === String(ref.b24)) : undefined;
  return uploads.find(u => u.kind === ref.kind);
}
