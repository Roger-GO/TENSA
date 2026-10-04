/**
 * The case name an export file carries: the loaded case's file name without
 * its directory or extension (`ieee14.raw` gives `ieee14`), or `case` for a
 * session with no file behind it (a blank system). `<ExportMenu>` slugifies
 * whatever it gets, so this does not.
 */
import { useCaseStore } from '@/store/case';
import { stemOf } from '@/lib/paths';

export function useExportCaseName(): string {
  const primaryPath = useCaseStore((s) => s.selection?.primaryPath ?? null);
  return primaryPath ? stemOf(primaryPath) : 'case';
}
