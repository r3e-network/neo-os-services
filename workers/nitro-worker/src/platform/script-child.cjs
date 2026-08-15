const vm = require("node:vm");

function normalizeError(error) {
  if (error instanceof Error) {
    return { message: error.message, stack: error.stack };
  }
  return { message: String(error) };
}

// Deep-clone host values INTO the sandbox realm so the untrusted script can
// never reach a parent-realm prototype chain (e.g. data.constructor.constructor
// resolving to the host Function constructor). The clone is produced by the
// sandbox's own JSON.parse, so every resulting object/array inherits the
// sandbox realm's intrinsics rather than the host realm's. JSON also drops
// functions and other non-serializable carriers of host references.
function intoSandbox(sandboxParse, value) {
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    return undefined;
  }
  return sandboxParse(serialized);
}

// Build the helper API as functions that belong to the sandbox realm. The host
// base64 primitive (Buffer is unavailable inside a vanilla vm context) is passed
// as a closed-over argument to a sandbox-realm factory, never placed on the
// sandbox global, so the script cannot reach the host function object. The
// returned helper functions are sandbox-realm functions, so introspecting them
// (helpers.x.constructor) yields the sandbox's own — codegen-disabled —
// intrinsics rather than the host realm's, and the helpers only return
// primitive values.
function buildHelpers(sandbox) {
  const hostBase64Decode = (value) =>
    Buffer.from(
      String(value == null ? "" : value).replace(/-/g, "+").replace(/_/g, "/"),
      "base64",
    ).toString("utf8");
  const factory = vm.compileFunction(
    "return Object.freeze({" +
      "getCurrentTimestamp: () => Math.floor(Date.now() / 1000)," +
      "base64Decode: (value) => String(__hostBase64Decode(value))," +
      "});",
    ["__hostBase64Decode"],
    { parsingContext: sandbox },
  );
  return factory(hostBase64Decode);
}

async function run(workerData) {
  const { mode, script, entryPoint, input, data, context, timeoutMs } = workerData;

  if (mode === "oracle") {
    const sandbox = vm.createContext(
      { __result: undefined },
      { codeGeneration: { strings: false, wasm: false } },
    );
    const sandboxParse = vm.runInContext("JSON.parse", sandbox);
    sandbox.data = intoSandbox(sandboxParse, data);
    sandbox.context = intoSandbox(sandboxParse, context);
    sandbox.helpers = buildHelpers(sandbox);
    const compiled = new vm.Script(
      `${script}\nif (typeof process !== 'function') throw new Error('script must define process(data, context, helpers)');\n__result = process(data, context, helpers);`,
    );
    compiled.runInContext(sandbox, { timeout: timeoutMs });
    return await Promise.resolve(sandbox.__result);
  }

  const sandbox = vm.createContext(
    { __result: undefined },
    { codeGeneration: { strings: false, wasm: false } },
  );
  const sandboxParse = vm.runInContext("JSON.parse", sandbox);
  sandbox.input = intoSandbox(sandboxParse, input);
  sandbox.helpers = buildHelpers(sandbox);
  const compiled = new vm.Script(
    `${script}\nconst __target = typeof ${entryPoint} === 'function' ? ${entryPoint} : (typeof process === 'function' ? process : null);\nif (!__target) throw new Error('entry point not found');\n__result = __target(input, helpers);`,
  );
  compiled.runInContext(sandbox, { timeout: timeoutMs });
  return await Promise.resolve(sandbox.__result);
}

process.on("message", async (workerData) => {
  try {
    const result = await run(workerData);
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
