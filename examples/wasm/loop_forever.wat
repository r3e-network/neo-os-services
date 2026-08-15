(module
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))

  (func (export "alloc") (param $size i32) (result i32)
    global.get $heap)

  (func (export "result_len") (result i32)
    i32.const 0)

  (func (export "run") (param $ptr i32) (param $len i32) (result i32)
    (loop $again
      br $again
    )
    i32.const 0))
