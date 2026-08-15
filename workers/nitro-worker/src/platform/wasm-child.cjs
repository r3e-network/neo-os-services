function normalizeError(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

// SECURITY (S17): hard cap on the DECLARED initial linear memory of a
// user-supplied WASM module (independent of the JS heap limits).
const MAX_WASM_INITIAL_MEMORY_BYTES = 512 * 1024 * 1024;

function decodeBase64ToBuffer(value) {
  return Buffer.from(String(value || "").replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function looksJson(text) {
  const raw = String(text || "").trim();
  return raw.startsWith("{") || raw.startsWith("[") || raw === "true" || raw === "false" || raw === "null" || /^-?\d+(\.\d+)?$/.test(raw);
}

function parseResult(text) {
  const raw = String(text || "");
  if (!looksJson(raw)) return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

function ensureExport(fn, name) {
  if (typeof fn !== "function") {
    throw new Error(`wasm module must export ${name}`);
  }
}

async function run({ moduleBase64, entryPoint, input }) {
  const moduleBytes = decodeBase64ToBuffer(moduleBase64);
  const imports = {
    morpheus: {
      now_seconds: () => Math.floor(Date.now() / 1000),
      abort: (code) => {
        throw new Error(`wasm aborted with code ${code}`);
      },
    },
  };

  const { instance } = await WebAssembly.instantiate(moduleBytes, imports);
  const exports = instance.exports;
  if (!(exports.memory instanceof WebAssembly.Memory)) {
    throw new Error("wasm module must export memory");
  }
  // SECURITY (S17): WASM linear memory is not constrained by
  // --max-old-space-size; reject a module whose DECLARED initial memory is
  // excessive before any guest code runs. (Runtime growth is still bounded by
  // the child's own memory ceiling and the parent's size caps.)
  if (exports.memory.buffer.byteLength > MAX_WASM_INITIAL_MEMORY_BYTES) {
    throw new Error(
      `wasm module declares linear memory larger than ${MAX_WASM_INITIAL_MEMORY_BYTES} bytes`
    );
  }

  const alloc = exports.alloc;
  const dealloc = exports.dealloc;
  const runFn = exports[entryPoint];
  const resultLenFn = exports.result_len;
  ensureExport(alloc, "alloc");
  ensureExport(runFn, entryPoint);
  ensureExport(resultLenFn, "result_len");

  const inputBytes = Buffer.from(JSON.stringify(input ?? null), "utf8");
  const inputPtr = Number(alloc(inputBytes.length));
  const memory = new Uint8Array(exports.memory.buffer);
  memory.set(inputBytes, inputPtr);

  const resultPtr = Number(runFn(inputPtr, inputBytes.length));
  const resultLen = Number(resultLenFn());
  const resultBytes = Buffer.from(new Uint8Array(exports.memory.buffer, resultPtr, resultLen));

  if (typeof dealloc === "function") {
    try {
      dealloc(inputPtr, inputBytes.length);
      dealloc(resultPtr, resultLen);
    } catch {
      // ignore module-side free errors
    }
  }

  return parseResult(resultBytes.toString("utf8"));
}

process.on("message", async (payload) => {
  try {
    const result = await run(payload);
    if (typeof process.send === "function") {
      process.send({ ok: true, result });
    }
  } catch (error) {
    if (typeof process.send === "function") {
      process.send({ ok: false, error: normalizeError(error) });
    }
  } finally {
    process.exit(0);
  }
});
