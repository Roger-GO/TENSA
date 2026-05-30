import { useState, type DragEvent, type HTMLAttributes, type ReactNode } from 'react';
import { cn } from '@/lib/cn';
import { COMPONENT_DND_MIME } from '@/components/shell/ComponentLibrary';

/**
 * ComponentDropZone — wraps an empty-canvas surface so a Component
 * Library tile dragged onto it is actually accepted.
 *
 * The loaded canvas (`SldCanvasInner`) has always handled drops, but the
 * two EMPTY states did not: the "No case loaded" placeholder and
 * `SldEmptySystem` ("Add your first bus") rendered plain `<div>`s with no
 * drop handlers — so the gesture the UI advertises ("drag a component
 * onto the canvas to start a blank system") was a silent no-op. This
 * component closes that gap and adds the drag-over affordance (a dashed
 * ring + tint) that was missing everywhere, so the canvas visibly reads
 * as a drop target.
 *
 * `onDropComponent` receives the dropped kind and the drop's raw client
 * coordinates. The empty states have no React Flow viewport, so there is
 * no flow-space transform here; callers either seed a position hint or
 * ignore the coordinates (a Bus's canvas position is the only
 * user-controllable one, and even that is just a hint).
 */
export interface ComponentDropZoneProps
  extends Omit<HTMLAttributes<HTMLDivElement>, 'onDrop' | 'onDragOver' | 'onDragLeave'> {
  onDropComponent: (kind: string, clientX: number, clientY: number) => void;
  className?: string;
  children?: ReactNode;
}

/** True when the active drag carries a Component Library payload. */
function dragHasComponent(e: DragEvent): boolean {
  // `getData()` is unreadable during dragenter/dragover (browser
  // security only exposes it on `drop`), so gate on the type list.
  return Array.from(e.dataTransfer.types).includes(COMPONENT_DND_MIME);
}

export function ComponentDropZone({
  onDropComponent,
  className,
  children,
  ...rest
}: ComponentDropZoneProps) {
  const [isOver, setIsOver] = useState(false);

  return (
    <div
      {...rest}
      data-drop-active={isOver ? '' : undefined}
      onDragOver={(e) => {
        // Ignore non-component drags (files, text, images) so the
        // browser keeps its default behaviour for them.
        if (!dragHasComponent(e)) return;
        // preventDefault marks this a valid drop target — without it the
        // browser shows "no-drop" and `onDrop` never fires.
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
        if (!isOver) setIsOver(true);
      }}
      onDragLeave={(e) => {
        // Re-entering a child fires dragleave on the parent; ignore it so
        // the highlight doesn't flicker. Only clear when the pointer
        // actually leaves the zone subtree.
        if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
        setIsOver(false);
      }}
      onDrop={(e) => {
        setIsOver(false);
        const kind = e.dataTransfer.getData(COMPONENT_DND_MIME);
        if (!kind) return; // not our payload — let the browser handle it
        e.preventDefault();
        onDropComponent(kind, e.clientX, e.clientY);
      }}
      className={cn(
        'relative transition-colors',
        isOver &&
          'bg-[color-mix(in_oklch,var(--color-ring)_6%,transparent)] outline-2 outline-offset-[-2px] outline-dashed outline-[var(--color-ring)]',
        className,
      )}
    >
      {children}
    </div>
  );
}
