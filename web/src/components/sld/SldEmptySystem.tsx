import { Button } from '@/components/ui/button';
import { useCaseStore } from '@/store/case';
import { iconForModel } from '@/icons/iec60617/manifest';
import { cn } from '@/lib/cn';

/**
 * SldEmptySystem — centered empty-state shown when a session has been
 * loaded (or blank-created) but the topology has no buses yet.
 *
 * The CTA opens the AddElementPanel pre-filled with kind='Bus' so the
 * user lands directly on the Bus form instead of the kind picker.
 */
export interface SldEmptySystemProps {
  className?: string;
}

export function SldEmptySystem({ className }: SldEmptySystemProps) {
  const openAddPanel = useCaseStore((s) => s.openAddPanel);
  return (
    <div
      role="status"
      data-testid="sld-empty-system"
      className={cn(
        'flex h-full w-full flex-col items-center justify-center gap-4 p-8',
        'text-center',
        className,
      )}
    >
      <img
        src={iconForModel('Bus')}
        alt=""
        aria-hidden="true"
        className="h-16 w-32 object-contain opacity-30"
      />
      <div className="flex flex-col gap-1">
        <h2 className="text-foreground text-base font-semibold">Add your first bus</h2>
        <p className="text-muted-foreground max-w-sm text-sm">
          New systems start empty. Add a Bus to anchor the topology, then
          generators, loads, and lines branch off from there.
        </p>
      </div>
      <Button
        type="button"
        variant="primary"
        size="md"
        onClick={() => openAddPanel('Bus')}
        data-testid="sld-empty-add-bus"
      >
        Add a Bus
      </Button>
    </div>
  );
}
