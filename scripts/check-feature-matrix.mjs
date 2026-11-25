#!/usr/bin/env node
// Checks that docs/FEATURE-MATRIX.md only cites files and tests that exist:
//  - every backticked path exists, written in full from the repository root (no bare names);
//  - every «test name» exists in the test file cited before it, and is not skipped;
//  - «(N pruebas)» after a test file matches the number of tests it declares;
//  - every row marked «implementada» cites at least one test file.
// Usage: node scripts/check-feature-matrix.mjs [--root <dir>] [--matrix <file>] [--sample <n> --seed <n>]
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import ts from 'typescript';

const REPOSITORY = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STATES = new Set(['implementada', 'parcial', 'falta']);
const PATH_TOKEN = /^[\w.\-/]+\.(ts|js|mjs|cjs|sh|yml|yaml|json|md)$|^[\w.\-/]+\/\*?$/;
const TEST_FILE = /(\.|-)spec\.ts$/;
const TEST_CALLS = new Set(['it', 'test']);
const SUITE_CALLS = new Set(['describe']);
const SKIPPED_CALLS = new Set(['xit', 'xtest', 'xdescribe']);

function argument(name) {
  const index = process.argv.indexOf(name);
  return index === -1 ? undefined : process.argv[index + 1];
}

/** Title text of a test call: a string literal, or a template turned into a pattern. */
function titleOf(node) {
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    return { text: node.text, pattern: null };
  if (ts.isTemplateExpression(node)) {
    const escape = (part) => part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    let pattern = escape(node.head.text);
    for (const span of node.templateSpans) pattern += '.+' + escape(span.literal.text);
    return { text: null, pattern: new RegExp(`^${pattern}$`) };
  }
  return null;
}

/**
 * Describes the callee of a test call: its base name (it, test, describe, describeDocker…) and
 * whether it is statically skipped (.skip, xit, xdescribe). `.each(...)` is looked through.
 */
function calleeOf(expression) {
  let node = expression;
  let skipped = false;
  if (ts.isCallExpression(node)) node = node.expression; // it.each(table)(title, fn)
  while (ts.isPropertyAccessExpression(node)) {
    const member = node.name.text;
    if (member === 'skip' || member === 'todo') skipped = true;
    node = node.expression;
    if (ts.isCallExpression(node)) node = node.expression;
  }
  if (!ts.isIdentifier(node)) return null;
  const name = node.text;
  if (SKIPPED_CALLS.has(name))
    return { kind: name === 'xdescribe' ? 'suite' : 'test', skipped: true };
  if (TEST_CALLS.has(name)) return { kind: 'test', skipped };
  if (SUITE_CALLS.has(name)) return { kind: 'suite', skipped };
  // Conditional suites such as `describeDocker` (describe or describe.skip by environment).
  if (/describe/i.test(name)) return { kind: 'suite', skipped, conditional: true };
  return null;
}

const testCache = new Map();
/** Every test and suite title declared in a file, with its line and skip state. */
function testsIn(file) {
  if (testCache.has(file)) return testCache.get(file);
  const source = ts.createSourceFile(
    file,
    readFileSync(file, 'utf8'),
    ts.ScriptTarget.Latest,
    true,
  );
  const entries = [];
  const visit = (node, skipped) => {
    let inner = skipped;
    if (ts.isCallExpression(node) && node.arguments.length >= 2) {
      const callee = calleeOf(node.expression);
      const title = callee && titleOf(node.arguments[0]);
      if (callee && title) {
        inner = skipped || callee.skipped;
        entries.push({
          ...title,
          kind: callee.kind,
          skipped: inner,
          conditional: Boolean(callee.conditional),
          line: source.getLineAndCharacterOfPosition(node.getStart()).line + 1,
        });
      }
    }
    ts.forEachChild(node, (child) => visit(child, inner));
  };
  visit(source, false);
  testCache.set(file, entries);
  return entries;
}

function matches(entry, cited) {
  const prefix = cited.endsWith('…') ? cited.slice(0, -1) : null;
  if (entry.text !== null)
    return prefix !== null ? entry.text.startsWith(prefix) : entry.text === cited;
  return prefix === null && entry.pattern.test(cited);
}

function existsPath(root, token) {
  const path = join(root, token.replace(/\/\*?$/, ''));
  if (!existsSync(path)) return false;
  if (token.endsWith('/') || token.endsWith('/*'))
    return statSync(path).isDirectory() && readdirSync(path).length > 0;
  return statSync(path).isFile();
}

/** Splits the test column into ordered tokens: paths, «names» and «(N pruebas)» counts. */
function testTokens(cell) {
  const tokens = [];
  const pattern = /`([^`]+)`(?:\s*\((\d+) pruebas\))?|«([^»]+)»/g;
  for (const match of cell.matchAll(pattern)) {
    if (match[3] !== undefined) tokens.push({ kind: 'name', value: match[3] });
    else tokens.push({ kind: 'code', value: match[1], count: match[2] && Number(match[2]) });
  }
  return tokens;
}

export function checkMatrix(markdown, root = REPOSITORY) {
  const errors = [];
  const rows = [];
  for (const line of markdown.split('\n')) {
    if (!/^\| [A-Z]{2}-\d+ /.test(line)) continue;
    const cells = line
      .trim()
      .replace(/^\||\|$/g, '')
      .split(' | ')
      .map((cell) => cell.trim());
    const [id, , state, , , testCell] = cells;
    if (cells.length !== 7) {
      errors.push(`${id}: expected 7 columns, found ${cells.length}`);
      continue;
    }
    if (!STATES.has(state)) errors.push(`${id}: unknown state «${state}»`);
    for (const cell of cells)
      for (const [, token] of cell.matchAll(/`([^`]+)`/g))
        if (PATH_TOKEN.test(token) && !token.includes(' ') && !existsPath(root, token))
          errors.push(
            `${id}: path not found (write it in full from the repository root): ${token}`,
          );

    const cited = [];
    let current = null;
    for (const token of testTokens(testCell)) {
      if (token.kind === 'code') {
        if (!TEST_FILE.test(token.value)) {
          current = null;
          continue;
        }
        const file = join(root, token.value);
        if (!existsSync(file)) {
          current = null;
          continue; // already reported as a missing path
        }
        current = { file: token.value, absolute: file, names: [] };
        cited.push(current);
        const tests = testsIn(file).filter((entry) => entry.kind === 'test');
        if (tests.length === 0) errors.push(`${id}: ${token.value} declares no tests`);
        if (tests.length > 0 && tests.every((entry) => entry.skipped))
          errors.push(`${id}: every test of ${token.value} is skipped`);
        if (token.count !== undefined) {
          const active = tests.filter((entry) => !entry.skipped).length;
          if (active !== token.count)
            errors.push(`${id}: ${token.value} says ${token.count} pruebas but declares ${active}`);
        }
        continue;
      }
      if (!current) {
        errors.push(`${id}: «${token.value}» is not preceded by a test file`);
        continue;
      }
      const found = testsIn(current.absolute).filter((entry) => matches(entry, token.value));
      if (found.length === 0) errors.push(`${id}: «${token.value}» not found in ${current.file}`);
      else if (found.every((entry) => entry.skipped))
        errors.push(`${id}: «${token.value}» is skipped in ${current.file}`);
      else current.names.push({ name: token.value, line: found.find((e) => !e.skipped).line });
    }
    if (state === 'implementada' && cited.length === 0)
      errors.push(`${id}: marked «implementada» without citing a test file`);
    rows.push({ id, state, cited });
  }
  if (rows.length === 0) errors.push('no matrix rows found');
  return { errors, rows };
}

/** Deterministic sample (mulberry32) so a reviewer can repeat it with the same seed. */
function sample(rows, size, seed) {
  let state = seed >>> 0;
  const random = () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const pool = rows.filter((row) => row.cited.length > 0);
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, size).sort((a, b) => a.id.localeCompare(b.id));
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const root = resolve(argument('--root') ?? REPOSITORY);
  const matrixPath = resolve(argument('--matrix') ?? join(root, 'docs/FEATURE-MATRIX.md'));
  const { errors, rows } = checkMatrix(readFileSync(matrixPath, 'utf8'), root);
  const size = argument('--sample');
  if (size) {
    const seed = Number(argument('--seed') ?? 1);
    console.log(`Sample of ${size} rows, seed ${seed}:`);
    for (const row of sample(rows, Number(size), seed)) {
      const first = row.cited.find((test) => test.names.length > 0) ?? row.cited[0];
      const where = first.names[0] ? `${first.file}:${first.names[0].line}` : first.file;
      console.log(`${row.id}\t${row.state}\t${where}\t${first.names[0]?.name ?? '(file)'}`);
    }
  }
  if (errors.length > 0) {
    console.error(`Feature matrix check failed (${errors.length}):`);
    for (const error of errors) console.error(`- ${error}`);
    process.exit(1);
  }
  const tests = rows.reduce((total, row) => total + row.cited.length, 0);
  console.log(`Feature matrix OK: ${rows.length} rows, ${tests} cited test files.`);
}
