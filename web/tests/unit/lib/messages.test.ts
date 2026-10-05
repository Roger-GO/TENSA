/**
 * The pure helpers behind the Messages tab: labels, the clock time, the filter, the
 * counts and the text Copy puts on the clipboard.
 */
import { describe, expect, it } from 'vitest';
import type { MessageLevel, PflowSettings, SessionMessage } from '@/api/types';
import {
  countByLevel,
  filterWords,
  formatMessageTime,
  matchesWords,
  messagesToText,
  sourceLabel,
  unheldQLimitCount,
  unheldQLimitText,
  visibleMessages,
} from '@/lib/messages';
import { collectViolations } from '@/lib/violations';
import { LIMITS_TOPOLOGY, limitsPflow } from '../helpers/limitsCase';

function message(overrides: Partial<SessionMessage> & { seq: number }): SessionMessage {
  return {
    time: 1_700_000_000,
    level: 'info',
    logger: 'andes.routines.pflow',
    source: 'run_pflow',
    text: 'a message',
    repeat: 1,
    ...overrides,
  };
}

const ALL: Record<MessageLevel, boolean> = { info: true, warning: true, error: true };

describe('sourceLabel', () => {
  it('names the commands the worker reports in plain words', () => {
    expect(sourceLabel('load_case')).toBe('Load case');
    expect(sourceLabel('run_pflow')).toBe('Power flow');
    expect(sourceLabel('run_tds')).toBe('Time domain');
  });

  it('spells out a command it does not know instead of hiding it', () => {
    expect(sourceLabel('run_new_thing')).toBe('run new thing');
  });

  it('is empty for a message logged between commands', () => {
    expect(sourceLabel('')).toBe('');
  });
});

describe('formatMessageTime', () => {
  it('reads as hours, minutes and seconds of the viewer’s day, padded', () => {
    const at = new Date(2026, 9, 5, 4, 7, 9).getTime() / 1000;
    expect(formatMessageTime(at)).toBe('04:07:09');
  });
});

describe('countByLevel', () => {
  it('counts each level and zero for one that is absent', () => {
    const counts = countByLevel([
      message({ seq: 1, level: 'info' }),
      message({ seq: 2, level: 'warning' }),
      message({ seq: 3, level: 'warning' }),
    ]);
    expect(counts).toEqual({ info: 1, warning: 2, error: 0 });
  });
});

describe('the filter', () => {
  it('splits what is typed into lower-case words and drops the blanks', () => {
    expect(filterWords('  Power   FLOW ')).toEqual(['power', 'flow']);
    expect(filterWords('')).toEqual([]);
  });

  it('keeps a message that has every word, whatever their order or case', () => {
    const m = message({ seq: 1, text: 'Power flow failed after 25 iterations' });
    expect(matchesWords(m, filterWords('FAILED iterations'))).toBe(true);
    expect(matchesWords(m, filterWords('failed converged'))).toBe(false);
  });

  it('also looks in the command and the ANDES module of the message', () => {
    const m = message({ seq: 1, text: 'x', source: 'run_tds', logger: 'andes.models.timer' });
    expect(matchesWords(m, filterWords('time domain'))).toBe(true);
    expect(matchesWords(m, filterWords('run_tds'))).toBe(true);
    expect(matchesWords(m, filterWords('timer'))).toBe(true);
  });

  it('keeps everything when nothing is typed', () => {
    expect(matchesWords(message({ seq: 1 }), [])).toBe(true);
  });
});

describe('visibleMessages', () => {
  const messages = [
    message({ seq: 1, level: 'info', text: 'Parsing input file' }),
    message({ seq: 2, level: 'warning', text: 'limiter not adjusted' }),
    message({ seq: 3, level: 'error', text: 'Power flow failed' }),
  ];

  it('lists the levels that are on, in the order the messages came', () => {
    const shown = { info: false, warning: true, error: true };
    expect(visibleMessages(messages, shown, '').map((m) => m.seq)).toEqual([2, 3]);
    expect(visibleMessages(messages, ALL, '').map((m) => m.seq)).toEqual([1, 2, 3]);
    expect(visibleMessages(messages, { ...ALL, error: false }, '').map((m) => m.seq)).toEqual([
      1, 2,
    ]);
  });

  it('applies the filter on top of the levels', () => {
    expect(visibleMessages(messages, ALL, 'failed').map((m) => m.seq)).toEqual([3]);
    expect(
      visibleMessages(messages, { info: false, warning: true, error: false }, 'failed'),
    ).toEqual([]);
  });
});

describe('messagesToText', () => {
  it('writes one block per message: time, level, command, then the text', () => {
    const at = new Date(2026, 9, 5, 14, 3, 2).getTime() / 1000;
    const text = messagesToText([
      message({ seq: 1, time: at, level: 'error', text: 'Power flow failed after 3 iterations' }),
      message({ seq: 2, time: at, level: 'warning', source: '', text: 'between commands' }),
    ]);
    expect(text.split('\n')).toEqual([
      '14:03:02  ERROR  Power flow  Power flow failed after 3 iterations',
      '14:03:02  WARNING  between commands',
    ]);
  });

  it('keeps the lines of a table and says how often a message repeated', () => {
    const at = new Date(2026, 9, 5, 14, 3, 2).getTime() / 1000;
    const text = messagesToText([
      message({ seq: 1, time: at, level: 'warning', text: 'limits\n| Idx |\n| 3 |', repeat: 4 }),
    ]);
    expect(text).toBe('14:03:02  WARNING  Power flow  limits\n| Idx |\n| 3 | (x4)');
  });

  it('is empty for no messages', () => {
    expect(messagesToText([])).toBe('');
  });
});

describe('unheldQLimitCount', () => {
  const settings = (enforce_q_limits: boolean): PflowSettings => ({
    tolerance: 1e-6,
    max_iterations: 25,
    flat_start: false,
    enforce_q_limits,
  });
  // One generator past its qmax (PV 1) and one on its qmax (Slack 2, a warning).
  const report = collectViolations(limitsPflow(), LIMITS_TOPOLOGY);

  it('counts the generators past a limit when the power flow did not enforce Q limits', () => {
    expect(unheldQLimitCount(settings(false), report)).toBe(1);
  });

  it('leaves out a generator that is only on its limit', () => {
    const onLimit = collectViolations(
      limitsPflow({
        generator_outputs: { '2': { p: 10, q: 15, v: 0.95, bus: 2, q_min: -50, q_max: 15 } },
      }),
      LIMITS_TOPOLOGY,
    );
    expect(onLimit?.items.some((v) => v.kind === 'generator-q')).toBe(true);
    expect(unheldQLimitCount(settings(false), onLimit)).toBe(0);
  });

  it('is zero when the run enforced Q limits, since the generators past one were held', () => {
    expect(unheldQLimitCount(settings(true), report)).toBe(0);
  });

  it('is zero when the run settings or the report are not known', () => {
    expect(unheldQLimitCount(null, report)).toBe(0);
    expect(unheldQLimitCount(undefined, report)).toBe(0);
    expect(unheldQLimitCount(settings(false), null)).toBe(0);
  });
});

describe('unheldQLimitText', () => {
  it('says why no warning names the generators, and how to get one', () => {
    const text = unheldQLimitText(2);
    expect(text).toContain('2 generators are past a reactive limit');
    expect(text).toContain('did not enforce Q limits');
    expect(text).toContain('they were not held');
    expect(text).toContain('no warning names them');
    expect(text).toContain('each generator held at a limit is named here');
  });

  it('is in the singular for one generator', () => {
    const text = unheldQLimitText(1);
    expect(text).toContain('1 generator is past a reactive limit');
    expect(text).toContain('it was not held');
    expect(text).toContain('no warning names it');
  });
});
