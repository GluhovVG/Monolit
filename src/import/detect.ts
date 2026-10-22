import { isDepartmentFileName } from './department';
import { productionKind } from './production';
import { isRatesWorkbook } from './rates';
import { isReferenceWorkbook } from './reference';
import { isTkpWorkbook } from './tkp';
import type { Workbook } from './sheet';

export type FileKind = 'reference' | 'rates' | 'prod_own' | 'prod_ext' | 'department' | 'tkp' | 'unknown';

export const FILE_KIND_LABELS: Record<FileKind, string> = {
  reference: 'Справочник «Номера заказов»',
  rates: 'Расценки',
  prod_own: 'Выпуск СЗ по месяцам',
  prod_ext: 'Выпуск сторонних цехов',
  department: 'Закрытые сделки подразделения',
  tkp: 'Расчёт ТКП (план МК)',
  unknown: 'Не распознан',
};

/** Content wins over the file name, except department files which are identified by name. */
export function detectFileKind(book: Workbook): FileKind {
  const prod = productionKind(book);
  if (prod === 'own') return 'prod_own';
  if (prod === 'external') return 'prod_ext';
  if (isReferenceWorkbook(book)) return 'reference';
  if (isRatesWorkbook(book)) return 'rates';
  if (isTkpWorkbook(book)) return 'tkp';
  if (isDepartmentFileName(book.fileName)) return 'department';
  return 'unknown';
}
