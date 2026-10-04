import { cn } from '@/lib/cn';
import { PflowOptionsForm } from './PflowOptionsForm';
import { PflowSummary } from './PflowSummary';

/**
 * PflowPanel: the Analysis tab's "PF" sub-tab. The options of the next power
 * flow on one side and the system summary of the last one on the other, as the
 * TDS sub-tab holds its run configuration beside its status. The two stack when
 * the drawer is narrow.
 */

export interface PflowPanelProps {
  className?: string;
}

export function PflowPanel({ className }: PflowPanelProps) {
  return (
    <div
      data-testid="pflow-panel"
      className={cn(
        'flex min-h-0 flex-1 flex-wrap content-start gap-x-8 gap-y-5 overflow-auto p-3',
        className,
      )}
    >
      <PflowOptionsForm className="w-[34rem] max-w-full shrink-0" />
      <PflowSummary className="min-w-72 flex-1" />
    </div>
  );
}
