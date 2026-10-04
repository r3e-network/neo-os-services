import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { loadNamedEnvFiles, parseDotEnv, readMergedDotEnvFiles } from './lib-env.mjs';

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

test('loadNamedEnvFiles lets a later file win over an earlier one and the real environment win over both', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-env-named-'));
  const keys = ['NAMED_ENV_TEST_A', 'NAMED_ENV_TEST_B', 'NAMED_ENV_TEST_C', 'NAMED_ENV_TEST_D'];
  const saved = Object.fromEntries(keys.map((key) => [key, process.env[key]]));
  try {
    const first = path.join(tempDir, 'first.env');
    const second = path.join(tempDir, 'second.env');
    fs.writeFileSync(first, 'NAMED_ENV_TEST_A=a1\nNAMED_ENV_TEST_B=b1\nNAMED_ENV_TEST_C=c1\n');
    fs.writeFileSync(second, 'NAMED_ENV_TEST_B=b2\nNAMED_ENV_TEST_C=c2\nNAMED_ENV_TEST_D=d2\n');
    for (const key of keys) delete process.env[key];
    process.env.NAMED_ENV_TEST_C = 'from-the-environment';

    await loadNamedEnvFiles([first, second]);

    assert.equal(process.env.NAMED_ENV_TEST_A, 'a1');
    assert.equal(process.env.NAMED_ENV_TEST_B, 'b2');
    assert.equal(process.env.NAMED_ENV_TEST_C, 'from-the-environment');
    assert.equal(process.env.NAMED_ENV_TEST_D, 'd2');
  } finally {
    for (const key of keys) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});

test('loadNamedEnvFiles refuses a file that does not exist and loads nothing implicitly', async () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'morpheus-env-named-'));
  try {
    await assert.rejects(
      loadNamedEnvFiles([path.join(tempDir, 'missing.env')]),
      /--env-file .*missing\.env does not exist/
    );
    await assert.rejects(
      loadNamedEnvFiles([path.join(tempDir, 'missing.env')], '--custom'),
      /--custom .*missing\.env does not exist/
    );
    // no names, no loading: a .env in the working directory is not looked at
    await loadNamedEnvFiles([]);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
});
