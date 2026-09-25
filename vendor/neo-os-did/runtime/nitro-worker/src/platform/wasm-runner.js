import path from 'node:path';
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { env, measureSerializedSizeBytes, resolveMaxBytes, trimString } from './core.js';
import {
  isChildProcessPermissionModelEnabled,
  validateChildProcessPermissions,
} from './permission-guard.js';

const childPath = fileURLToPath(new URL('./wasm-child.cjs', import.meta.url));

function resolveMaxResultBytes() {
  return resolveMaxBytes(env('WASM_CHILD_MAX_RESULT_BYTES'), 64 * 1024, 1024);
}

function normalizeError(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

function buildPermissionExecArgv(scriptPath) {
  validateChildProcessPermissions();

  // Permission model is on by default; only the MORPHEUS_ALLOW_UNSANDBOXED_CHILDREN
  // dev override disables it, and never under NODE_ENV=production (fail closed).
  if (!isChildProcessPermissionModelEnabled()) return [];

  const allowFsRead = new Set(
    trimString(env('SCRIPT_CHILD_ALLOW_FS_READ') || path.dirname(scriptPath))
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
  );

  const args = ['--permission'];
  for (const entry of allowFsRead) {
    args.push(`--allow-fs-read=${entry}`);
  }

  const allowFsWrite = trimString(env('SCRIPT_CHILD_ALLOW_FS_WRITE'));
  for (const entry of allowFsWrite
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean)) {
    args.push(`--allow-fs-write=${entry}`);
  }
  if (trimString(env('SCRIPT_CHILD_ALLOW_NET'))) {
    args.push(`--allow-net=${trimString(env('SCRIPT_CHILD_ALLOW_NET'))}`);
  }
  if (['1', 'true', 'yes'].includes(trimString(env('SCRIPT_CHILD_ALLOW_WORKER')).toLowerCase())) {
    args.push('--allow-worker');
  }
  // SECURITY: --allow-child-process lets the child spawn unrestricted grandchildren,
  // effectively escaping the permission model. Honour the opt-in ONLY outside
  // production; in production the flag is forcibly ignored (fail-closed).
  if (
    trimString(env('NODE_ENV')).toLowerCase() !== 'production' &&
    ['1', 'true', 'yes'].includes(trimString(env('SCRIPT_CHILD_ALLOW_CHILD_PROCESS')).toLowerCase())
  ) {
    args.push('--allow-child-process');
  }
  return args;
}

export async function runWasmWithTimeout({
  mode,
  moduleBase64,
  entryPoint = 'run',
  input,
  timeoutMs,
}) {
  const maxOldGenerationSizeMb = Math.max(Number(env('WASM_CHILD_MAX_OLD_SPACE_MB') || 64), 16);
  const maxYoungGenerationSizeMb = Math.max(Number(env('WASM_CHILD_MAX_YOUNG_SPACE_MB') || 16), 4);
  const stackSizeMb = Math.max(Number(env('WASM_CHILD_STACK_SIZE_MB') || 4), 1);
  const stackSizeKb = Math.max(stackSizeMb * 1024, 1024);

  return await new Promise((resolve, reject) => {
    const child = fork(childPath, {
      silent: true,
      env: {
        PATH: process.env.PATH || '',
        TZ: process.env.TZ || 'UTC',
      },
      execArgv: [
        '--disable-proto=throw',
        '--frozen-intrinsics',
        `--max-old-space-size=${maxOldGenerationSizeMb}`,
        `--max-semi-space-size=${maxYoungGenerationSizeMb}`,
        `--stack-size=${stackSizeKb}`,
        ...buildPermissionExecArgv(childPath),
      ],
    });

    let finished = false;
    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      child.kill('SIGKILL');
      reject(new Error(`wasm execution timed out after ${timeoutMs}ms`));
    }, timeoutMs + 50);

    child.once('message', (message) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      if (message?.ok) {
        const maxResultBytes = resolveMaxResultBytes();
        const size = measureSerializedSizeBytes(message.result);
        if (size > maxResultBytes) {
          reject(new Error(`wasm result exceeds max size of ${maxResultBytes} bytes`));
          return;
        }
        resolve(message.result);
      } else {
        reject(new Error(message?.error?.message || 'wasm execution failed'));
      }
    });

    child.once('error', (error) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      child.kill('SIGKILL');
      reject(new Error(normalizeError(error).message));
    });

    child.once('exit', (code, signal) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      if (code !== 0) {
        reject(
          new Error(
            `wasm worker exited with code ${code ?? 'unknown'}${signal ? ` (${signal})` : ''}`
          )
        );
      }
    });

    child.send({ mode, moduleBase64, entryPoint, input, timeoutMs });
  });
}
