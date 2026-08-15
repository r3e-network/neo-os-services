(module
  (import "morpheus" "now_seconds" (func $now (result i32)))
  (memory (export "memory") 1)
  (global $heap (mut i32) (i32.const 1024))
  (global $result_len (mut i32) (i32.const 0))

  (func (export "alloc") (param $size i32) (result i32)
    (local $addr i32)
    global.get $heap
    local.set $addr
    global.get $heap
    local.get $size
    i32.add
    global.set $heap
    local.get $addr)

  (func (export "result_len") (result i32)
    global.get $result_len)

  (func (export "run") (param $ptr i32) (param $len i32) (result i32)
    i32.const 4
    global.set $result_len
    i32.const 2048
    i32.const 116
    i32.store8
    i32.const 2049
    i32.const 114
    i32.store8
    i32.const 2050
    i32.const 117
    i32.store8
    i32.const 2051
    i32.const 101
    i32.store8
    call $now
    drop
    i32.const 2048))
