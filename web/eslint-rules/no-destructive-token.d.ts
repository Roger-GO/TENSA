import type { Rule } from 'eslint';

/**
 * Type declaration for the JS-authored `no-destructive-token` ESLint rule so
 * the guard test (`tests/unit/lint/no-destructive-token.test.ts`) can import it
 * under `strict` typecheck without an implicit-`any` error.
 */
declare const rule: Rule.RuleModule;
export default rule;
