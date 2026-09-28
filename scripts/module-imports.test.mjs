// Static import resolution for every tracked ES module. Nothing is imported or
// evaluated: the files are parsed and their relative specifiers resolved.
//
// Why: three scripts/ops mainnet tools imported ./lib-*.mjs from one directory
// too deep and failed with ERR_MODULE_NOT_FOUND before running any code
// (fix-mainnet-morpheus-runtime.mjs since 4d2d136; 10cb54c then edited it
// without noticing), scripts/archive/backup-system-state.mjs had the same
// defect, and scripts/check-network-config.mjs imported a ./lib-utils.mjs that
// never existed inside a try/catch that swallowed the error. ESLint does not
// resolve imports, and none of these files is loaded by a test, so nothing
// noticed. This test checks, for ES modules only:
//   - every relative static import, re-export and literal dynamic import()
//     names a file that exists (ES modules require the exact path), and
//   - every named or default binding imported from another tracked ES module
//     is exported by it (following `export * from` chains).
// Bare package specifiers are out of scope: several deploy packages install
// their own dependencies outside the root workspace.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import test from 'node:test';

const root = path.resolve(import.meta.dirname, '..');
const require = createRequire(import.meta.url);
const { parse } = require('@typescript-eslint/parser');

// baselines/ is the frozen, sha256-pinned JS parity baseline and vendor/ is
// third-party source; both are kept byte-for-byte and are not run in place.
const EXCLUDED_PREFIXES = ['baselines/', 'vendor/'];

const packageTypeCache = new Map();
function nearestPackageType(absoluteDir) {
  if (packageTypeCache.has(absoluteDir)) return packageTypeCache.get(absoluteDir);
  const manifest = path.join(absoluteDir, 'package.json');
  let type;
  if (fs.existsSync(manifest)) type = JSON.parse(fs.readFileSync(manifest, 'utf8')).type;
  else if (absoluteDir === root) type = undefined;
  else type = nearestPackageType(path.dirname(absoluteDir));
  packageTypeCache.set(absoluteDir, type ?? 'commonjs');
  return type ?? 'commonjs';
}

function isEsModule(absolutePath) {
  if (absolutePath.endsWith('.mjs')) return true;
  if (absolutePath.endsWith('.js'))
    return nearestPackageType(path.dirname(absolutePath)) === 'module';
  return false;
}

const astCache = new Map();
function astOf(absolutePath) {
  if (!astCache.has(absolutePath)) {
    astCache.set(
      absolutePath,
      parse(fs.readFileSync(absolutePath, 'utf8'), {
        sourceType: 'module',
        ecmaVersion: 'latest',
        loc: true,
        range: false,
      })
    );
  }
  return astCache.get(absolutePath);
}

function nameOf(node) {
  return node.type === 'Literal' ? String(node.value) : node.name;
}

function walk(node, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node);
  for (const [key, value] of Object.entries(node)) {
    if (key === 'parent') continue;
    if (Array.isArray(value)) for (const child of value) walk(child, visit);
    else if (value && typeof value.type === 'string') walk(value, visit);
  }
}

function bindingNames(pattern, names) {
  if (!pattern) return names;
  if (pattern.type === 'Identifier') names.push(pattern.name);
  else if (pattern.type === 'ObjectPattern')
    for (const property of pattern.properties)
      bindingNames(property.type === 'RestElement' ? property.argument : property.value, names);
  else if (pattern.type === 'ArrayPattern')
    for (const element of pattern.elements) bindingNames(element, names);
  else if (pattern.type === 'AssignmentPattern') bindingNames(pattern.left, names);
  else if (pattern.type === 'RestElement') bindingNames(pattern.argument, names);
  return names;
}

function resolveRelative(fromFile, specifier) {
  if (!specifier.startsWith('./') && !specifier.startsWith('../')) return null;
  return path.resolve(path.dirname(fromFile), specifier);
}

// Exported binding names of a tracked ES module, or null when the set cannot be
// known statically (a re-export from a package or a non-ES module).
const exportCache = new Map();
function exportsOf(absolutePath, visiting = new Set()) {
  if (exportCache.has(absolutePath)) return exportCache.get(absolutePath);
  if (visiting.has(absolutePath)) return new Set();
  visiting.add(absolutePath);
  let names = new Set();
  for (const node of astOf(absolutePath).body) {
    if (node.type === 'ExportDefaultDeclaration') names.add('default');
    if (node.type === 'ExportNamedDeclaration') {
      const declaration = node.declaration;
      if (declaration?.type === 'VariableDeclaration')
        for (const declarator of declaration.declarations)
          for (const name of bindingNames(declarator.id, [])) names.add(name);
      else if (declaration?.id) names.add(declaration.id.name);
      for (const specifier of node.specifiers) names.add(nameOf(specifier.exported));
    }
    if (node.type === 'ExportAllDeclaration') {
      if (node.exported) {
        names.add(nameOf(node.exported));
        continue;
      }
      const target = resolveRelative(absolutePath, String(node.source.value));
      const inner =
        target && fs.existsSync(target) && isEsModule(target) ? exportsOf(target, visiting) : null;
      if (!inner) {
        names = null;
        break;
      }
      for (const name of inner) if (name !== 'default') names.add(name);
    }
  }
  exportCache.set(absolutePath, names);
  return names;
}

function trackedEsModules() {
  return execFileSync('git', ['ls-files', '-z', '--', '*.mjs', '*.js'], {
    cwd: root,
    encoding: 'utf8',
  })
    .split('\0')
    .filter(Boolean)
    .filter((file) => !EXCLUDED_PREFIXES.some((prefix) => file.startsWith(prefix)))
    .filter((file) => isEsModule(path.join(root, file)));
}

function collectImports(file) {
  const absolutePath = path.join(root, file);
  const imports = [];
  walk(astOf(absolutePath), (node) => {
    const isStatic =
      node.type === 'ImportDeclaration' ||
      node.type === 'ExportAllDeclaration' ||
      (node.type === 'ExportNamedDeclaration' && node.source);
    if (isStatic) {
      const names =
        node.type === 'ImportDeclaration'
          ? node.specifiers
              .filter((specifier) => specifier.type !== 'ImportNamespaceSpecifier')
              .map((specifier) =>
                specifier.type === 'ImportDefaultSpecifier' ? 'default' : nameOf(specifier.imported)
              )
          : node.type === 'ExportNamedDeclaration'
            ? node.specifiers.map((specifier) => nameOf(specifier.local))
            : [];
      imports.push({ specifier: String(node.source.value), line: node.loc.start.line, names });
    }
    if (node.type === 'ImportExpression' && node.source.type === 'Literal')
      imports.push({ specifier: String(node.source.value), line: node.loc.start.line, names: [] });
  });
  return imports.map((entry) => ({
    ...entry,
    file,
    target: resolveRelative(absolutePath, entry.specifier),
  }));
}

const modules = trackedEsModules();
const relativeImports = modules.flatMap(collectImports).filter((entry) => entry.target);

test('the scan covers the repository ES modules', () => {
  // Guards against a vacuous pass: a broken file listing or package-type
  // lookup would otherwise report zero problems.
  assert.ok(modules.includes('scripts/ops/fix-mainnet-morpheus-runtime.mjs'));
  assert.ok(modules.length > 400, `only ${modules.length} ES modules found`);
  assert.ok(relativeImports.length > 800, `only ${relativeImports.length} relative imports found`);
});

test('every relative import in a tracked ES module resolves to a file', () => {
  const missing = relativeImports
    .filter(({ target }) => !fs.existsSync(target) || !fs.statSync(target).isFile())
    .map(({ file, line, specifier }) => `${file}:${line} imports ${specifier}`);
  assert.deepEqual(missing, [], `unresolvable imports:\n${missing.join('\n')}`);
});

test('every binding imported from a tracked ES module is exported by it', () => {
  const unexported = [];
  for (const { file, line, specifier, names, target } of relativeImports) {
    if (!names.length || !fs.existsSync(target) || !isEsModule(target)) continue;
    const exported = exportsOf(target);
    if (!exported) continue;
    for (const name of names)
      if (!exported.has(name))
        unexported.push(`${file}:${line} imports '${name}' from ${specifier}`);
  }
  assert.deepEqual(
    unexported,
    [],
    `imports of names the target does not export:\n${unexported.join('\n')}`
  );
});
