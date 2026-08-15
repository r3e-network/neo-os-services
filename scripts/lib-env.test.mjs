import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { parseDotEnv, readMergedDotEnvFiles } from './lib-env.mjs';

test('parseDotEnv strips matched surrounding quotes and trims whitespace', () => {
  const parsed = parseDotEnv(
    [
      'PLAIN=value',
      'DOUBLE="quoted value"',
      "SINGLE='quoted value'",
      'UNMATCHED="left-only',
      '  PADDED_KEY  =  padded value  ',
      'EMPTY=',
      'EMPTY_QUOTED=""',
      'WITH_EQUALS=a=b=c',
      'DIGIT_KEY_2024=ok',
      '# COMMENT=ignored',
      'NOEQUALS',
      '',
    ].join('\n')
  );

  assert.deepEqual(parsed, {
    PLAIN: 'value',
    DOUBLE: 'quoted value',
    SINGLE: 'quoted value',
    UNMATCHED: '"left-only',
    PADDED_KEY: 'padded value',
    EMPTY: '',
    EMPTY_QUOTED: '',
    WITH_EQUALS: 'a=b=c',
    DIGIT_KEY_2024: 'ok',
  });
});

test('parseDotEnv handles CRLF input', () => {
  assert.deepEqual(parseDotEnv('A=1\r\nB="2"\r\n'), { A: '1', B: '2' });
});

test('readMergedDotEnvFiles merges .env.local over .env and skips missing files', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-env-merge-'));
  const rootEnvPath = path.join(tempDir, '.env');
  const localEnvPath = path.join(tempDir, '.env.local');

  fs.writeFileSync(rootEnvPath, ['A=1', 'B=from-root', 'EMPTY='].join('\n') + '\n', 'utf8');
  fs.writeFileSync(localEnvPath, ['B=from-local', 'C=3'].join('\n') + '\n', 'utf8');

  const merged = await readMergedDotEnvFiles([
    rootEnvPath,
    path.join(tempDir, '.missing.env'),
    localEnvPath,
  ]);

  assert.deepEqual(merged, {
    A: '1',
    B: 'from-local',
    EMPTY: '',
    C: '3',
  });
});
