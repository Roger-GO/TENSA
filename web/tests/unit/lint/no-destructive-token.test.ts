/**
 * Unit 10 (v3.1): guard test for the `andes/no-destructive-token` ESLint rule.
 *
 * The theme defines a `danger` color token but NOT a `destructive` one, so any
 * `(bg|text|border|ring|outline)-destructive` utility silently NO-OPs. This
 * rule (and this test) lock in the destructive→danger sweep so it can never
 * regress.
 *
 * We drive ESLint's RuleTester directly so the assertions exercise the exact
 * rule object that `eslint.config.js` registers.
 */
import { RuleTester } from 'eslint';
import { describe, it } from 'vitest';
// The rule is authored as an ESM default export (matching the flat-config
// import in eslint.config.js).
import rule from '../../../eslint-rules/no-destructive-token.js';

// `run` declares a suite with a test per case, through these. It is called
// while the file is collected, in a `describe` and never in an `it`: a suite
// declared inside a test is never collected, so its cases would not run.
RuleTester.describe = describe;
RuleTester.it = it;
RuleTester.itOnly = it.only;

const ruleTester = new RuleTester({
  languageOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
  },
});

describe('andes/no-destructive-token', () => {
  describe('flags a className containing bg-destructive', () => {
    ruleTester.run('no-destructive-token', rule, {
      valid: [],
      invalid: [
        {
          code: 'const c = "bg-destructive text-white";',
          errors: [{ messageId: 'noDestructive' }],
        },
      ],
    });
  });

  describe('flags every dead utility prefix and the foreground variant', () => {
    ruleTester.run('no-destructive-token', rule, {
      valid: [],
      invalid: [
        { code: 'const c = "text-destructive";', errors: [{ messageId: 'noDestructive' }] },
        { code: 'const c = "border-destructive";', errors: [{ messageId: 'noDestructive' }] },
        { code: 'const c = "ring-destructive";', errors: [{ messageId: 'noDestructive' }] },
        { code: 'const c = "outline-destructive";', errors: [{ messageId: 'noDestructive' }] },
        {
          code: 'const c = "text-destructive-foreground";',
          errors: [{ messageId: 'noDestructive' }],
        },
        {
          // Template literal (conditional className composition).
          code: 'const c = `px-2 ${x} bg-destructive`;',
          errors: [{ messageId: 'noDestructive' }],
        },
      ],
    });
  });

  describe('allows bg-danger and other danger utilities', () => {
    ruleTester.run('no-destructive-token', rule, {
      valid: [
        { code: 'const c = "bg-danger text-danger-foreground";' },
        { code: 'const c = "border-danger ring-danger";' },
        { code: 'const c = `px-2 ${x} bg-danger`;' },
      ],
      invalid: [],
    });
  });

  describe('does not false-positive on the word "destructive" in comments or identifiers', () => {
    ruleTester.run('no-destructive-token', rule, {
      valid: [
        // Doc-comment that legitimately names the rule.
        { code: '// NEVER use destructive — it no-ops; use danger.\nconst c = "bg-danger";' },
        // Block comment.
        { code: '/* the destructive→danger sweep is Unit 10 */\nconst c = "text-danger";' },
        // Identifier named destructive (not a className token).
        { code: 'const isDestructiveAction = true; void isDestructiveAction;' },
        // A plain prose string that merely contains the word, not a class list.
        { code: 'const msg = "This action is destructive and cannot be undone.";' },
      ],
      invalid: [],
    });
  });
});
