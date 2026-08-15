# WASM Examples

These are tiny reference modules for the Morpheus WASM runtime.

Expected exports:

- `memory`
- `alloc(size: i32) -> i32`
- `run(ptr: i32, len: i32) -> i32`
- `result_len() -> i32`
- optional `dealloc(ptr: i32, len: i32)`

Input:

- The worker serializes the input JSON to UTF-8 bytes.
- The module receives `(ptr, len)` to that byte range in linear memory.

Output:

- `run` returns a pointer to UTF-8 JSON or UTF-8 text.
- `result_len` returns the byte length of the output.

Suggested toolchain:

```bash
wat2wasm echo_true.wat -o echo_true.wasm
base64 < echo_true.wasm
```
