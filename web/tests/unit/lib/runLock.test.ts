/**
 * What the app says wherever a run has fixed the system: one sentence, with
 * the way out, what it keeps, and what it loses only when it would lose it.
 */
import { describe, expect, it } from 'vitest';
import {
  PFLOW_LOCKS_NOTE,
  RESET_RUN_KEEPS,
  RESET_RUN_LOSES,
  RUN_LOCK,
  runLockNotice,
} from '@/lib/runLock';

describe('runLockNotice', () => {
  it('says why, the way out and what the reset keeps', () => {
    expect(runLockNotice(false)).toBe(
      'A run has fixed the system. Reset run lets you edit again; the result stays in Analysis > Compare and in Run history.',
    );
    expect(runLockNotice(false)).toBe(`${RUN_LOCK} ${RESET_RUN_KEEPS}`);
  });

  it('says what the reset loses only while it would lose something', () => {
    expect(runLockNotice(false)).not.toContain('not saved yet');
    expect(runLockNotice(true)).toBe(`${RUN_LOCK} ${RESET_RUN_KEEPS} ${RESET_RUN_LOSES}`);
    // In exact terms: which edits, why, and how to keep them.
    expect(RESET_RUN_LOSES).toContain('added, changed or deleted since the case was opened');
    expect(RESET_RUN_LOSES).toContain('save the system first to keep them');
    // No place says the edits "are discarded" whether any would be.
    expect(runLockNotice(true)).not.toMatch(/discard/);
  });

  it('puts what the place offers besides the reset before the reset', () => {
    expect(runLockNotice(false, 'Edit mode changes controller values without a reset.')).toBe(
      `${RUN_LOCK} Edit mode changes controller values without a reset. ${RESET_RUN_KEEPS}`,
    );
    expect(runLockNotice(false, '')).toBe(runLockNotice(false));
  });

  it('says of a power flow that it has just fixed the system, and that the result is kept', () => {
    expect(PFLOW_LOCKS_NOTE).toMatch(/^The run has fixed the system:/);
    expect(PFLOW_LOCKS_NOTE).toContain('until Reset run, which keeps this result');
  });
});
