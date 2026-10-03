/**
 * `userNameProblem` mirrors the server's `user_name_problem`
 * (server/src/tensa/security/names.py). The cases below are the same corpus
 * the server tests use, so the two stay in step.
 */
import { describe, expect, it } from 'vitest';
import { userNameProblem } from '@/lib/fileName';

describe('userNameProblem', () => {
  it.each(['snap1', 'a.b.c', 'Kundur_v2', 'x'.repeat(64), '9lives', 'a-b', 'console', 'com10'])(
    'accepts %s',
    (name) => {
      expect(userNameProblem(name)).toBeNull();
    },
  );

  it.each([
    '',
    '.hidden',
    '-lead',
    '_lead',
    '../up',
    'a/b',
    'a\\b',
    'with space',
    'x'.repeat(65),
    'snap\n',
    'name\0null',
    'naïve',
  ])('rejects the shape of %j', (name) => {
    expect(userNameProblem(name)).toMatch(/1-64 chars/);
  });

  it('rejects a trailing dot, which Windows strips', () => {
    expect(userNameProblem('snap.')).toMatch(/end with a dot/);
  });

  it.each(['con', 'CON', 'nul', 'Aux', 'prn', 'com1', 'COM9', 'com0', 'lpt1', 'LPT9', 'lpt0'])(
    'rejects the device name %s',
    (name) => {
      expect(userNameProblem(name)).toMatch(/reserved Windows device name/);
    },
  );

  it.each(['con.v2', 'nul.backup.1', 'aux.xlsx', 'COM1.raw'])(
    'rejects %s: the device name is the part before the first dot',
    (name) => {
      expect(userNameProblem(name)).toMatch(/reserved Windows device name/);
    },
  );

  it('names the device in the message', () => {
    expect(userNameProblem('aux.v2')).toContain('"aux"');
  });
});
