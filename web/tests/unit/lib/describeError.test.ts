import { describe, expect, it } from 'vitest';
import { ProblemDetailsError } from '@/api/client';
import { describeError } from '@/lib/describeError';

function problem(fields: { detail?: string | null; title?: string; status?: number }) {
  return new ProblemDetailsError(
    {
      type: 'about:blank',
      title: fields.title ?? '',
      status: fields.status ?? 409,
      detail: fields.detail ?? null,
      instance: null,
    },
    null,
    '/api/x',
  );
}

describe('describeError', () => {
  it("gives the server's detail, then its title, then the status", () => {
    expect(describeError(problem({ detail: 'the file is open', title: 'Conflict' }))).toBe(
      'the file is open',
    );
    expect(describeError(problem({ title: 'Conflict' }))).toBe('Conflict');
  });

  it("gives an error's message, and anything else as text", () => {
    expect(describeError(new Error('network down'))).toBe('network down');
    expect(describeError('refused')).toBe('refused');
  });
});
