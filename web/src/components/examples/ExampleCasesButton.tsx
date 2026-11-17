import { useExampleCasesStore } from '@/store/exampleCases';
import { cn } from '@/lib/cn';

/**
 * ExampleCasesButton. Opens the Example cases dialog: ready-made power systems to add to
 * the workspace and open. It sits in the Workspace group of the Project tab, beside the
 * button that adds files of the user's own.
 */
export interface ExampleCasesButtonProps {
  className?: string;
}

export function ExampleCasesButton({ className }: ExampleCasesButtonProps) {
  const openDialog = useExampleCasesStore((s) => s.openDialog);
  return (
    <button
      type="button"
      data-testid="example-cases-open"
      onClick={openDialog}
      title="Ready-made power systems to add to the workspace and open, with their sources, citations and licences."
      className={cn(
        'border-border text-primary rounded-[var(--radius-sm)] border px-2 py-0.5',
        'text-[11px] font-medium',
        'hover:bg-muted transition-colors duration-[var(--duration-fast)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        className,
      )}
    >
      Example cases…
    </button>
  );
}
