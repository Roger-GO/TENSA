/**
 * The two controls a run is renamed with, shared by the legend chip and the
 * history row so the two behave alike.
 *
 * ``RenameRunButton`` is the pencil that starts a rename. ``RunRenameInput`` is
 * the text field: it takes focus with its text selected, Enter or clicking away
 * keeps the name, Escape drops what was typed, and an empty name puts the run's
 * default label back. The default label shows as the placeholder so an empty
 * field says what it will go back to.
 */
import { useEffect, useRef, useState } from 'react';
import { Input } from '@/components/ui/Input';
import { cn } from '@/lib/cn';

export interface RenameRunButtonProps {
  /** Accessible name; says which run, since a list of them has one pencil each. */
  'aria-label': string;
  /** Hover text; "Rename this run" when omitted. */
  title?: string;
  onClick: () => void;
  'data-testid'?: string;
  className?: string;
}

/** A small pencil button. Inline glyph, as the rest of the app does, in place of an icon library. */
export function RenameRunButton({
  'aria-label': ariaLabel,
  title = 'Rename this run',
  onClick,
  'data-testid': testId,
  className,
}: RenameRunButtonProps) {
  return (
    <button
      type="button"
      onClick={(e) => {
        // A chip's own click toggles the overlay; a pencil next to it must not.
        e.stopPropagation();
        onClick();
      }}
      title={title}
      aria-label={ariaLabel}
      data-testid={testId}
      className={cn(
        'text-muted-foreground hover:text-foreground hover:bg-muted/60 inline-flex shrink-0 items-center justify-center',
        'h-5 w-5 rounded-[var(--radius-sm)]',
        'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
        className,
      )}
    >
      <svg
        aria-hidden="true"
        viewBox="0 0 16 16"
        width="12"
        height="12"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      >
        <path d="M11 2.5 13.5 5 5.5 13 2 14 3 10.5Z" />
        <path d="M9.5 4 12 6.5" />
      </svg>
    </button>
  );
}

export interface RunRenameInputProps {
  /** The name to start from: the researcher's current name, or empty for a run still on its default. */
  initialValue: string;
  /** What an empty name falls back to, shown as the placeholder. */
  placeholder?: string;
  /** Called once with what was typed, on Enter or when focus leaves the field. */
  onCommit: (next: string) => void;
  /** Called once when Escape is pressed. */
  onCancel: () => void;
  'data-testid'?: string;
  'aria-label'?: string;
  /** Width class; ``w-32`` when omitted. */
  className?: string;
}

export function RunRenameInput({
  initialValue,
  placeholder,
  onCommit,
  onCancel,
  'data-testid': testId,
  'aria-label': ariaLabel = 'Rename run',
  className,
}: RunRenameInputProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter, Escape and the blur that removing the field can cause each finish
  // the edit; only the first of them counts.
  const doneRef = useRef(false);

  // Autofocus + select-all so the researcher can immediately retype.
  // Running this once on mount via a ref is simpler than wiring up
  // ``autoFocus`` (which Radix sometimes strips for a11y) plus a
  // separate select-on-focus handler.
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    el.focus();
    el.select();
  }, []);

  const commit = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCommit(value);
  };

  const cancel = () => {
    if (doneRef.current) return;
    doneRef.current = true;
    onCancel();
  };

  return (
    <Input
      ref={inputRef}
      value={value}
      onChange={setValue}
      onKeyDown={(e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          commit();
        } else if (e.key === 'Escape') {
          e.preventDefault();
          cancel();
        }
      }}
      onBlur={commit}
      placeholder={placeholder}
      // Lets a surrounding dialog tell that Escape belongs to this field.
      data-run-rename=""
      data-testid={testId}
      aria-label={ariaLabel}
      className={cn('!h-6 px-1.5 py-0 text-xs', className ?? 'w-32')}
    />
  );
}
