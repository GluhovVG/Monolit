import { createContext, useContext, type ReactNode } from 'react';
import { api } from '@appdeploy/client';
import type { UploadMeta } from './workspace';
import { findUpload, type SourceRef } from './source-ref';

/** Открытие файла-источника по двойному щелчку на цифре. */
export type { SourceRef } from './source-ref';

type Opener = (ref: SourceRef) => void;
const SourceContext = createContext<Opener>(() => undefined);

export function SourceProvider({ uploads, children }: { uploads: UploadMeta[]; children?: ReactNode }) {
  const open: Opener = ref => {
    const upload = findUpload(uploads, ref);
    if (!upload) {
      window.alert('Файл-источник не загружен.');
      return;
    }
    if (upload.sourceUrl) {
      window.open(upload.sourceUrl, '_blank', 'noopener');
      return;
    }
    // The window is opened right away (inside the click) so the browser does not block it.
    const win = window.open('', '_blank');
    api.get('/api/uploads/' + encodeURIComponent(upload.id) + '/file')
      .then(res => {
        const url = String((res.data as { url?: string }).url ?? '');
        if (!url) throw new Error('Ссылка на файл не получена.');
        if (win) win.location.href = url;
        else window.location.href = url;
      })
      .catch((cause: unknown) => {
        win?.close();
        window.alert(cause instanceof Error && cause.message ? cause.message : 'Не удалось открыть файл.');
      });
  };
  return <SourceContext.Provider value={open}>{children}</SourceContext.Provider>;
}

/** Props for a table cell: double click opens the source file. */
export function useSource() {
  const open = useContext<Opener>(SourceContext);
  return (ref: SourceRef | null | undefined, className?: string) => (ref
    ? { onDoubleClick: () => open(ref), title: 'Двойной щелчок — открыть файл-источник', className: ['src-cell', className].filter(Boolean).join(' ') }
    : { className });
}
