import { useEffect, useRef, useState } from 'react';
import { useEditElement } from '@/api/queries';
import { useSessionStore } from '@/store/session';
import { ProblemDetailsError } from '@/api/client';
import type { ParamValue, TopologyParamMeta } from '@/api/types';
import { cn } from '@/lib/cn';

/**
 * EditElementButton — pencil → input → save / cancel cycle for one
 * parameter row in the inspector's Properties tab.
 *
 * State machine:
 *
 * - idle (read-only) — pencil icon next to the value.
 * - editing — input replaces the value; Enter saves, Esc cancels.
 * - saving — input locks, spinner adjacent to it; mutation in flight.
 * - error — inline message above the input; user can retry or cancel.
 *
 * The `onUpdated` callback fires after a successful save with the
 * server-confirmed value, letting the parent re-render with the fresh
 * row data without waiting for the topology re-fetch.
 *
 * Bus-idx fields are deferred to Unit 6 (no structural-link edits in
 * v0.1.x); this component handles `string` / `number` / `bool` only.
 */
export interface EditElementButtonProps {
  model: string;
  idx: string;
  meta: TopologyParamMeta;
  value: ParamValue;
  /** Whether the surrounding state allows editing. */
  enabled: boolean;
  onUpdated?: (newValue: ParamValue) => void;
  className?: string;
}

export function EditElementButton({
  model,
  idx,
  meta,
  value,
  enabled,
  onUpdated,
  className,
}: EditElementButtonProps) {
  const sessionId = useSessionStore((s) => s.sessionId);
  const editMutation = useEditElement();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState<string>(String(value));
  const [error, setError] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  // Reset draft each time the underlying value changes (e.g., topology
  // refetch after another field's save).
  useEffect(() => {
    if (!editing) {
      setDraft(String(value));
      setError(null);
    }
  }, [value, editing]);

  useEffect(() => {
    if (editing) {
      inputRef.current?.focus();
      inputRef.current?.select();
    }
  }, [editing]);

  const cancel = () => {
    setEditing(false);
    setDraft(String(value));
    setError(null);
  };

  const submit = () => {
    if (!sessionId) return;
    let coerced: ParamValue;
    if (meta.kind === 'number') {
      const trimmed = draft.trim();
      const parsed = Number(trimmed);
      if (trimmed.length === 0 || !Number.isFinite(parsed)) {
        setError('Enter a finite number');
        return;
      }
      coerced = parsed;
    } else if (meta.kind === 'bool') {
      coerced = draft === 'true';
    } else {
      coerced = draft;
    }
    setError(null);
    editMutation.mutate(
      {
        sessionId,
        model,
        idx,
        params: { [meta.name]: coerced },
      },
      {
        onSuccess: (entry) => {
          const updated = entry.params?.[meta.name];
          setEditing(false);
          if (updated !== undefined) {
            onUpdated?.(updated);
            setDraft(String(updated));
          }
        },
        onError: (err) => {
          if (err instanceof ProblemDetailsError) {
            setError(err.detail ?? err.title ?? 'Edit rejected');
          } else {
            setError(err.message ?? 'Edit failed');
          }
        },
      },
    );
  };

  if (!enabled) {
    return (
      <span className={cn('text-foreground font-mono text-xs', className)}>
        {String(value)}
      </span>
    );
  }

  if (!editing) {
    return (
      <span className={cn('group flex items-center gap-1', className)}>
        <span className="text-foreground font-mono text-xs">{String(value)}</span>
        {meta.unit ? (
          <span className="text-muted-foreground text-[10px]">{meta.unit}</span>
        ) : null}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={`Edit ${meta.name}`}
          data-testid={`edit-${meta.name}`}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'inline-flex h-4 w-4 items-center justify-center rounded',
            'opacity-60 transition-opacity hover:opacity-100 group-hover:opacity-100 focus-visible:opacity-100',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="10"
            height="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M11 2 L14 5 L5 14 L2 14 L2 11 Z" />
          </svg>
        </button>
      </span>
    );
  }

  const saving = editMutation.isPending;

  return (
    <span
      className={cn('flex flex-col gap-0.5', className)}
      data-testid={`edit-input-${meta.name}`}
    >
      <span className="flex items-center gap-1">
        {meta.kind === 'bool' ? (
          <select
            ref={inputRef as unknown as React.RefObject<HTMLSelectElement>}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            disabled={saving}
            className="bg-background border-border h-6 rounded border px-1 font-mono text-xs"
          >
            <option value="true">true</option>
            <option value="false">false</option>
          </select>
        ) : (
          <input
            ref={inputRef}
            type={meta.kind === 'number' ? 'number' : 'text'}
            inputMode={meta.kind === 'number' ? 'decimal' : 'text'}
            value={draft}
            disabled={saving}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                submit();
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                cancel();
              }
            }}
            step="any"
            className="bg-background border-border h-6 w-20 rounded border px-1 font-mono text-xs"
          />
        )}
        {meta.unit ? (
          <span className="text-muted-foreground text-[10px]">{meta.unit}</span>
        ) : null}
        <button
          type="button"
          onClick={submit}
          disabled={saving}
          aria-label={`Save ${meta.name}`}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'inline-flex h-4 w-4 items-center justify-center rounded',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            'disabled:opacity-50',
          )}
        >
          {saving ? (
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              className="animate-spin"
            >
              <path d="M8 1.5 A6.5 6.5 0 1 1 1.5 8" />
            </svg>
          ) : (
            <svg
              aria-hidden="true"
              viewBox="0 0 16 16"
              width="10"
              height="10"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 8 L7 12 L13 4" />
            </svg>
          )}
        </button>
        <button
          type="button"
          onClick={cancel}
          disabled={saving}
          aria-label={`Cancel editing ${meta.name}`}
          className={cn(
            'text-muted-foreground hover:text-foreground',
            'inline-flex h-4 w-4 items-center justify-center rounded',
            'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
            'disabled:opacity-50',
          )}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 16 16"
            width="10"
            height="10"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          >
            <path d="M4 4 L12 12 M12 4 L4 12" />
          </svg>
        </button>
      </span>
      {error !== null ? (
        <span
          role="alert"
          data-testid={`edit-error-${meta.name}`}
          className="text-destructive text-[10px]"
        >
          {error}
        </span>
      ) : null}
    </span>
  );
}
