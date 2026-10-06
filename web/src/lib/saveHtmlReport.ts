/**
 * Save the HTML report and say how it went. The one path behind every control
 * that offers it (the Reports dialog's button, the Export menu, the command
 * palette), so they name the file and fail the same way.
 *
 * The code that gathers the results and writes the document is fetched here,
 * the first time a report is asked for, and is not part of the first load.
 */
import { describeError } from '@/lib/describeError';
import { toast } from '@/lib/toast';

export async function saveHtmlReport(): Promise<void> {
  try {
    const { exportHtmlReport } = await import('@/lib/exportHtmlReport');
    const filename = await exportHtmlReport();
    if (filename === null) {
      toast.warning('Nothing to report yet', {
        description: 'Run a power flow or a time-domain simulation first.',
      });
      return;
    }
    toast.success(`Exported ${filename}`);
  } catch (err) {
    toast.error('The report could not be saved', {
      description: describeError(err),
    });
  }
}
