import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * One-off foundation script: give each shared package a real build.
 *
 * Packages are consumed two ways:
 *   - in development, directly from `src` (fast, no watch/build step) — the
 *     `development` condition below resolves to source
 *   - in production, from `dist` (compiled JS + .d.ts)
 */
const packages = ['config', 'types', 'money', 'state-machines', 'validation'];

for (const name of packages) {
  const dir = join('packages', name);

  const pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'));
  const entryPoints = Object.keys(pkg.exports ?? { '.': './src/index.ts' });

  const exportsMap = {};
  for (const key of entryPoints) {
    const sub = key === '.' ? '' : `/${key.replace('./', '')}`;
    exportsMap[key] = {
      development: {
        types: `./src${sub}/index.ts`,
        import: `./src${sub}/index.ts`,
        default: `./src${sub}/index.ts`,
      },
      types: `./dist${sub}/index.d.ts`,
      import: `./dist${sub}/index.js`,
      default: `./dist${sub}/index.js`,
    };
  }

  pkg.main = './dist/index.js';
  pkg.types = './dist/index.d.ts';
  pkg.exports = exportsMap;
  pkg.files = ['dist', 'src'];
  pkg.scripts = {
    ...pkg.scripts,
    build: 'tsc -p tsconfig.build.json',
    clean: 'rm -rf dist tsconfig.build.tsbuildinfo',
  };
  writeFileSync(join(dir, 'package.json'), `${JSON.stringify(pkg, null, 2)}\n`);

  const tsconfigBuild = {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      outDir: 'dist',
      rootDir: 'src',
      noEmit: false,
      declaration: true,
      declarationMap: true,
      sourceMap: true,
      composite: false,
      paths: name === 'validation' ? { '@bidly/config': ['../config/src/index.ts'] } : {},
    },
    include: ['src/**/*.ts'],
    exclude: ['node_modules', 'dist', 'src/**/*.test.ts'],
  };
  writeFileSync(join(dir, 'tsconfig.build.json'), `${JSON.stringify(tsconfigBuild, null, 2)}\n`);

  console.log(`configured ${name}`);
}
