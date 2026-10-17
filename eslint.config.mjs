// @ts-check
/**
 * ESLint, flat config — `pnpm lint`.
 *
 * The brief for 0.2.0 asked for "angular-eslint + typescript-eslint,
 * `strict-type-checked`". That is what `extends` below is, and the reason it is
 * worth the noise in a library like this one is specific rather than generic: the
 * risky code here is the code that lies about a value's shape. `CacheEntry`
 * narrows a generic from signal state, `errors.ts` duck-types a class that is not
 * an `Error`, `key.ts` hashes `unknown` recursively, and the tests reach into
 * private fields on purpose. Every one of those is a place where a cast that
 * compiles today can be wrong tomorrow, and `strict-type-checked` is the only
 * configuration that reads the casts rather than the syntax.
 *
 * Two decisions worth stating:
 *
 * 1. **Type-aware linting is on** (`projectService`), because the rules that catch
 *    anything here are the ones that need types. It costs a few seconds and it is
 *    the point.
 * 2. **No `eslint-plugin-prettier`.** Prettier is a separate command
 *    (`pnpm format:check`, wired into `pnpm verify`), and `eslint-config-prettier`
 *    only switches off rules that would fight it. Routing formatting through
 *    ESLint makes every formatting change show up as a lint error and doubles the
 *    runtime for nothing.
 *
 * No rule is disabled globally. Where a file genuinely needs to break one, the
 * exception is a one-line `// eslint-disable-next-line` with a reason, so the
 * exception is visible at the point it applies.
 */
import eslint from '@eslint/js';
import prettier from 'eslint-config-prettier';
import angular from 'angular-eslint';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  {
    name: 'ng-signal-request/ignores',
    ignores: ['dist/**', 'coverage/**', '.angular/**', 'node_modules/**'],
  },
  {
    name: 'ng-signal-request/typescript',
    files: ['**/*.ts'],
    extends: [
      eslint.configs.recommended,
      ...tseslint.configs.strictTypeChecked,
      ...angular.configs.tsRecommended,
      prettier,
    ],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    processor: angular.processInlineTemplates,
    rules: {
      // A type-only import written without `import type` survives into the emitted
      // JavaScript in some bundler configurations, and this package ships as ESM
      // with `sideEffects: false`. `inline-type-imports` matches the style the code
      // already uses (`import { type Signal, inject }`).
      '@typescript-eslint/consistent-type-imports': [
        'error',
        { fixStyle: 'inline-type-imports', prefer: 'type-imports' },
      ],
      // `_`-prefixed parameters are deliberate holes: `(_, next) => next` in a
      // structural-sharing callback, `(_key, value) => …` in a comparator.
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrors: 'all' },
      ],
      // Narrowed, not switched off. Interpolating a number, a boolean or a bigint is
      // never the bug this rule exists to catch — `${status}` in an error message is
      // clearer than `String(status)`. What it keeps catching is the real hazard:
      // `object`, `unknown` and `any` rendering as `[object Object]`.
      '@typescript-eslint/restrict-template-expressions': [
        'error',
        { allowNumber: true, allowBoolean: true },
      ],
      // The shorthand arrow whose body is a void call — `onClick={() => count.set(0)}`
      // — is this library's idiom, and the rule offers this option for exactly it. The
      // non-shorthand form (`(x) => void f(x)` in a value position, which really does
      // read as a returned value) stays an error.
      '@typescript-eslint/no-confusing-void-expression': ['error', { ignoreArrowShorthand: true }],
    },
  },
  {
    name: 'ng-signal-request/tests',
    files: ['**/*.spec.ts'],
    rules: {
      // A spec asserts on state it has just written, so `!` *is* the assertion:
      // `cache().peek<User[]>(key)!.data()`. Rewriting each one as a runtime guard
      // would make the test assert about the guard instead of the behaviour.
      '@typescript-eslint/no-non-null-assertion': 'off',
      // Specs hand `any` around on purpose — `vi.fn()` spies, `structuredClone`
      // fixtures, casts to reach a private field. Every one of these stays an error in
      // the code that ships.
      '@typescript-eslint/no-unsafe-assignment': 'off',
      '@typescript-eslint/no-unsafe-member-access': 'off',
      '@typescript-eslint/no-unsafe-call': 'off',
      '@typescript-eslint/no-unsafe-return': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      // A type test writes the type argument or the cast because that *is* the subject:
      // `createRequest<User[], Query>(…)` proves the overload still accepts two
      // arguments. Removing them, as these rules suggest, would delete the assertion.
      '@typescript-eslint/no-unnecessary-type-assertion': 'off',
      '@typescript-eslint/no-unnecessary-type-arguments': 'off',
      '@typescript-eslint/no-unnecessary-type-parameters': 'off',
      // `void` is the marker this API uses for "no params declared" (`TParams = void`),
      // and the type tests name it to pin that down.
      '@typescript-eslint/no-invalid-void-type': 'off',
      // `async () => {}` with nothing to await is how a test says "this callback is
      // allowed to be asynchronous", and `void promise` is how it says "deliberately
      // not awaited". Both are signals, not mistakes.
      '@typescript-eslint/require-await': 'off',
      '@typescript-eslint/no-meaningless-void-operator': 'off',
      // Type-level references are not calls: `expectTypeOf(handle.run)` names a method
      // rather than invoking it, so there is no `this` to lose.
      '@typescript-eslint/unbound-method': 'off',
      // A test throws a string to prove the library normalizes a non-`Error` throw.
      '@typescript-eslint/only-throw-error': 'off',
    },
  },
  {
    name: 'ng-signal-request/templates',
    files: ['**/*.html'],
    extends: [...angular.configs.templateRecommended, ...angular.configs.templateAccessibility],
    rules: {},
  },
);
