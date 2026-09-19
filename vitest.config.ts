import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));

/**
 * Shared Vitest configuration.
 *
 * Tests live next to the code they cover (`*.test.ts`). A package with no
 * tests yet is not a failure: `passWithNoTests` keeps the pipeline green while
 * a surface is still being built.
 *
 * `BIDLY_TEST_SCOPE` lets a workspace run only its own tests. Set by each
 * package's `test:unit` script to its own directory; turbo runs packages in
 * parallel and unscoped runs re-executed the whole monorepo suite in every
 * workspace, colliding on the shared integration database.
 */
const scope = process.env.BIDLY_TEST_SCOPE;
const include = scope
  ? [`${scope.replace(/^\.\//, '')}/**/*.test.ts`]
  : ['packages/**/src/**/*.test.ts', 'apps/**/src/**/*.test.ts'];

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    root,
    include,
    exclude: ['**/node_modules/**', '**/dist/**', '**/.next/**'],
    passWithNoTests: true,
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
});
