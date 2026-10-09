import { useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { Popover, PopoverContent, PopoverTrigger } from './popover';
import { cn } from '@/lib/cn';

/**
 * A text held to the room it has, with the rest of it one press away.
 *
 * The rows over the diagram and over a table give a hint one or two lines:
 * a row that grew with its text would move what is under it each time the
 * hint changes. A hint that does not fit was cut with an ellipsis, and the
 * part that was cut was most often the one that says what to do. The whole
 * text was in the `title`, which a touch screen, a screenshot and anything
 * that reads the page do not get.
 *
 * `ClampedText` keeps the row as high as it was and puts a **More** button
 * after a text that is cut, which opens the whole of it. Whether it is cut
 * is measured (the box scrolls further than it shows), and measured again
 * when the row changes size. With `more`, the text is a summary of several
 * lines, and the button is there whether or not the summary fits.
 */
export interface ClampedTextProps {
  /** What is shown in the row. */
  text: string;
  /** What comes before the text, in the same paragraph (a heading in bold). */
  lead?: ReactNode;
  /**
   * The lines the button opens. Left out: the text itself, and the button
   * only while the text is cut.
   */
  more?: readonly string[];
  /** The classes of the paragraph, which hold it to its lines (`line-clamp-2`, `truncate`). */
  className?: string;
  /** The classes of the row the paragraph and the button stand in. */
  rowClassName?: string;
  testId?: string;
  /** What the button is called for a reader of the page: `More about moving a device`. */
  moreLabel?: string;
  role?: 'status';
  /** Further attributes of the paragraph (`data-hint`, `aria-live`). */
  attributes?: Readonly<Record<string, string | undefined>>;
}

export function ClampedText({
  text,
  lead,
  more,
  className,
  rowClassName,
  testId,
  moreLabel,
  role,
  attributes,
}: ClampedTextProps) {
  const ref = useRef<HTMLParagraphElement>(null);
  const [cut, setCut] = useState(false);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el === null) return;
    const measure = () =>
      setCut(el.scrollHeight > el.clientHeight + 1 || el.scrollWidth > el.clientWidth + 1);
    measure();
    if (typeof ResizeObserver === 'undefined') return;
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [text]);
  const lines = more ?? [text];
  const offered = more !== undefined || cut;
  return (
    <div className={cn('flex min-w-0 flex-1 items-start gap-1.5', rowClassName)}>
      <p
        ref={ref}
        role={role}
        data-testid={testId}
        data-cut={cut ? 'true' : undefined}
        title={lines.join(' ')}
        className={cn('min-w-0 flex-1', className)}
        {...attributes}
      >
        {lead}
        {text}
      </p>
      {offered ? (
        <Popover>
          <PopoverTrigger asChild>
            <button
              type="button"
              data-testid={testId ? `${testId}-more` : undefined}
              aria-label={moreLabel ?? 'Show the whole text'}
              className={cn(
                'text-primary shrink-0 rounded px-1 text-[11px] leading-[16px] font-medium underline',
                'underline-offset-2 hover:no-underline',
                'focus-visible:ring-2 focus-visible:ring-[var(--color-ring)] focus-visible:outline-none',
              )}
            >
              More
            </button>
          </PopoverTrigger>
          <PopoverContent
            align="start"
            data-testid={testId ? `${testId}-full` : undefined}
            className="w-96 max-w-[90vw] p-3"
          >
            {lines.length === 1 ? (
              <p className="text-foreground text-xs leading-snug">{lines[0]}</p>
            ) : (
              <ul className="text-foreground flex list-disc flex-col gap-1 pl-4 text-xs leading-snug">
                {lines.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            )}
          </PopoverContent>
        </Popover>
      ) : null}
    </div>
  );
}
