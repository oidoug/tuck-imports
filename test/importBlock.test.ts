import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import { findImportBlock, FindOptions, scriptStart } from '../src/importBlock';

function lineOf(text: string, offset: number): number {
  return text.slice(0, offset).split(/\r\n|\r|\n/).length - 1;
}

function lines(text: string, options?: FindOptions) {
  const block = findImportBlock(text, options);
  if (!block) return undefined;
  return { start: lineOf(text, block.start), end: lineOf(text, block.end), count: block.count };
}

const src = (...rows: string[]) => rows.join('\n');

test('groups consecutive imports', () => {
  const text = src(
    "import React from 'react';",
    "import { useState } from 'react';",
    "import type { Trip } from './types';",
    '',
    'export function App() {}',
  );
  assert.deepEqual(lines(text), { start: 0, end: 2, count: 3 });
});

test('skips header comments, shebang and directives', () => {
  const text = src(
    '#!/usr/bin/env node',
    '/**',
    ' * License header',
    ' */',
    "'use client';",
    '// @ts-check',
    "import a from 'a'",
    "import b from 'b'",
    'run()',
  );
  assert.deepEqual(lines(text), { start: 6, end: 7, count: 2 });
});

test('spans multi-line imports, blank lines and comments between imports', () => {
  const text = src(
    'import {',
    '  a,',
    '  b, // trailing',
    "} from 'x';",
    '',
    '// Local',
    "import * as utils from './utils';",
    "import './styles.css';",
    '',
    '// after the block',
    'const value = 1;',
  );
  assert.deepEqual(lines(text), { start: 0, end: 7, count: 3 });
});

test('handles every import form', () => {
  const text = src(
    "import def, { a as b, type C } from 'm1'",
    "import def2, * as ns from 'm2'",
    "import type Def from 'm3'",
    "import json from './data.json' with { type: 'json' }",
    "import legacy from './old.json' assert { type: 'json' }",
    "import fs = require('fs')",
    'import Alias = Some.Namespace.Thing',
    "import { 'string name' as alias } from 'm4'",
    "import from from 'm5'",
    "import defer * as lazy from 'm6'",
    "import a from 'a'; import b from 'b';",
    'foo()',
  );
  assert.deepEqual(lines(text), { start: 0, end: 10, count: 12 });
});

test('stops at dynamic import and import.meta', () => {
  assert.deepEqual(lines(src("import a from 'a'", "import('b')", "import c from 'c'")), { start: 0, end: 0, count: 1 });
  assert.deepEqual(lines(src("import a from 'a'", 'import.meta.url', "import c from 'c'")), { start: 0, end: 0, count: 1 });
  assert.equal(findImportBlock("const x = await import('x')"), undefined);
});

test('stops at the first non-import statement', () => {
  const text = src("import a from 'a'", "jest.mock('a')", "import b from 'b'");
  assert.deepEqual(lines(text), { start: 0, end: 0, count: 1 });
});

test('includes CommonJS require declarations', () => {
  const text = src(
    "'use strict';",
    "const fs = require('fs');",
    "const { join, resolve } = require('node:path')",
    "const pkg = require('./package.json'), other = require('other');",
    "var lib = require('lib').default;",
    "require('dotenv/config');",
    '',
    "const debug = require('debug')('app');",
  );
  assert.deepEqual(lines(text), { start: 1, end: 5, count: 5 });
  assert.equal(findImportBlock(text)!.startsWithImport, false);
  assert.equal(findImportBlock(text, { includeRequire: false }), undefined);
});

test('does not treat other declarations as imports', () => {
  assert.equal(findImportBlock("const fs = require"), undefined);
  assert.equal(findImportBlock("const a = b;\nimport x from 'x'"), undefined);
  assert.equal(findImportBlock("require('x').config()"), undefined);
});

test('incomplete import while typing does not swallow following code', () => {
  const text = src("import a from 'a'", 'import b', 'const c = d;');
  assert.deepEqual(lines(text), { start: 0, end: 0, count: 1 });
});

test('ignores tricky strings inside braces', () => {
  const text = src("import { '}' as x, y } from 'z'", "import w from 'w'", 'go()');
  assert.deepEqual(lines(text), { start: 0, end: 1, count: 2 });
});

test('works with CRLF line endings', () => {
  const text = "import a from 'a';\r\nimport b from 'b';\r\n\r\nexport {};\r\n";
  assert.deepEqual(lines(text), { start: 0, end: 1, count: 2 });
});

test('returns undefined for files without imports', () => {
  assert.equal(findImportBlock(''), undefined);
  assert.equal(findImportBlock('// just a comment'), undefined);
  assert.equal(findImportBlock('export const x = 1;'), undefined);
});

test('finds the script section of Vue, Svelte and Astro files', () => {
  const vue = src('<template><div /></template>', '<script setup lang="ts">', "import a from 'a'", "import b from 'b'", '</script>');
  assert.deepEqual(lines(vue, { from: scriptStart(vue, 'vue') }), { start: 2, end: 3, count: 2 });

  const astro = src('---', "import Layout from '../Layout.astro'", "import Card from '../Card.astro'", '---', '<Layout />');
  assert.deepEqual(lines(astro, { from: scriptStart(astro, 'astro') }), { start: 1, end: 2, count: 2 });

  assert.equal(scriptStart('<div />', 'svelte'), undefined);
  assert.equal(scriptStart('anything', 'typescript'), 0);
});
