/**
 * The case name an export file carries: the loaded case's file name without
 * its directory or extension (`ieee14.raw` gives `ieee14`), or `case` for a
 * session with no file behind it (a blank system). `<ExportMenu>` slugifies
 * whatever it gets, so this does not.
 */
import { useCaseStore } from '@/store/case';

/** Strip the directory and the extension from a workspace path. */
export function deriveCaseName(path: string): string {
  const base = path.split(/[\\/]/).pop() ?? path;
  const dot = base.lastIndexOf('.');
  return dot > 0 ? base.slice(0, dot) : base;
}

export function useExportCaseName(): string {
  const primaryPath = useCaseStore((s) => s.selection?.primaryPath ?? null);
  return primaryPath ? deriveCaseName(primaryPath) : 'case';
}
