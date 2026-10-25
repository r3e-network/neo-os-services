use super::decrypt_aes256_cbc;
use aes::cipher::{generic_array::GenericArray, BlockEncrypt, KeyInit};
use std::alloc::{GlobalAlloc, Layout, System};
use std::cell::RefCell;

const CEK: [u8; 32] = [0x42; 32];
const IV: [u8; 16] = [0x24; 16];
const FILL_BYTE: u8 = 0xa5;
const MAX_CAPTURE_SIZE: usize = 64;
const CAPTURE_CAPACITY: usize = 8;

#[global_allocator]
static ALLOCATOR: DeallocationCapturer = DeallocationCapturer;

struct DeallocationCapturer;

struct Capture {
    active: bool,
    allocation_size: usize,
    allocations: Vec<usize>,
    deallocations: Vec<Deallocation>,
}

impl Capture {
    const fn new() -> Self {
        Self {
            active: false,
            allocation_size: 0,
            allocations: Vec::new(),
            deallocations: Vec::new(),
        }
    }
}

#[derive(Debug)]
struct Deallocation {
    ptr: usize,
    size: usize,
    bytes: [u8; MAX_CAPTURE_SIZE],
}

impl Deallocation {
    fn bytes(&self) -> &[u8] {
        &self.bytes[..self.size]
    }
}

thread_local! {
    static CAPTURE: RefCell<Capture> = const { RefCell::new(Capture::new()) };
}

// SAFETY: every allocation is delegated to System. Captured bytes are copied
// only from live, fully initialized allocations before System.dealloc.
unsafe impl GlobalAlloc for DeallocationCapturer {
    unsafe fn alloc(&self, layout: Layout) -> *mut u8 {
        // SAFETY: the caller upholds GlobalAlloc's layout requirements.
        let ptr = unsafe { System.alloc(layout) };
        if ptr.is_null() || layout.size() == 0 || layout.size() > MAX_CAPTURE_SIZE {
            return ptr;
        }

        let _ = CAPTURE.try_with(|cell| {
            if let Ok(mut capture) = cell.try_borrow_mut() {
                if capture.active
                    && capture.allocation_size == layout.size()
                    && capture.allocations.len() < capture.allocations.capacity()
                {
                    // SAFETY: ptr is a live allocation of layout.size() bytes.
                    // Initializing the whole allocation makes a later dealloc
                    // snapshot valid even when spare Vec capacity is present.
                    unsafe { std::ptr::write_bytes(ptr, FILL_BYTE, layout.size()) };
                    capture.allocations.push(ptr as usize);
                }
            }
        });
        ptr
    }

    unsafe fn dealloc(&self, ptr: *mut u8, layout: Layout) {
        let _ = CAPTURE.try_with(|cell| {
            if let Ok(mut capture) = cell.try_borrow_mut() {
                if let Some(index) = capture
                    .allocations
                    .iter()
                    .position(|&candidate| candidate == ptr as usize)
                {
                    capture.allocations.swap_remove(index);
                    if capture.active
                        && layout.size() <= MAX_CAPTURE_SIZE
                        && capture.deallocations.len() < capture.deallocations.capacity()
                    {
                        let mut bytes = [0u8; MAX_CAPTURE_SIZE];
                        // SAFETY: this allocator initialized all bytes when it
                        // tracked ptr, and the allocation remains live here.
                        unsafe {
                            std::ptr::copy_nonoverlapping(ptr, bytes.as_mut_ptr(), layout.size());
                        }
                        capture.deallocations.push(Deallocation {
                            ptr: ptr as usize,
                            size: layout.size(),
                            bytes,
                        });
                    }
                }
            }
        });
        // SAFETY: ptr and layout are the original allocation's values, as
        // required by the GlobalAlloc caller contract.
        unsafe { System.dealloc(ptr, layout) };
    }
}

fn start_capture(allocation_size: usize) {
    assert!(allocation_size <= MAX_CAPTURE_SIZE);
    CAPTURE.with(|cell| {
        let mut capture = cell.borrow_mut();
        assert!(!capture.active);
        capture.allocations.clear();
        capture.deallocations.clear();
        capture.allocations.reserve(CAPTURE_CAPACITY);
        capture.deallocations.reserve(CAPTURE_CAPACITY);
        capture.allocation_size = allocation_size;
        capture.active = true;
    });
}

fn finish_capture() -> Vec<Deallocation> {
    CAPTURE.with(|cell| {
        let mut capture = cell.borrow_mut();
        capture.active = false;
        capture.allocation_size = 0;
        std::mem::take(&mut capture.deallocations)
    })
}

fn encrypt_cbc(padded_plaintext: &[u8]) -> (Vec<u8>, Vec<u8>) {
    assert_eq!(padded_plaintext.len() % 16, 0);
    let cipher = aes::Aes256::new_from_slice(&CEK).unwrap();
    let mut previous = IV;
    let mut ciphertext = Vec::with_capacity(padded_plaintext.len());
    for chunk in padded_plaintext.as_chunks::<16>().0 {
        let mut block = GenericArray::clone_from_slice(chunk);
        for (byte, previous_byte) in block.iter_mut().zip(previous.iter()) {
            *byte ^= previous_byte;
        }
        cipher.encrypt_block(&mut block);
        ciphertext.extend_from_slice(&block);
        previous.copy_from_slice(&block);
    }

    let mut params = vec![0x04, 0x10];
    params.extend_from_slice(&IV);
    (ciphertext, params)
}

#[test]
fn cbc_success_zeroizes_the_returned_heap_allocation() {
    let expected = vec![0x5a; 37];
    let mut padded = expected.clone();
    padded.resize(48, 11);
    let (ciphertext, params) = encrypt_cbc(&padded);

    start_capture(ciphertext.len());
    let plaintext = decrypt_aes256_cbc(&CEK, &params, &ciphertext).unwrap();
    let returned_ptr = plaintext.as_ptr() as usize;
    let returned_capacity = plaintext.capacity();
    let plaintext_matches = plaintext.as_slice() == expected;
    drop(plaintext);
    let deallocations = finish_capture();

    assert!(plaintext_matches);
    assert_eq!(returned_capacity, ciphertext.len());
    assert_eq!(deallocations.len(), 1, "{deallocations:#?}");
    assert_eq!(deallocations[0].ptr, returned_ptr);
    assert!(
        deallocations[0].bytes().iter().all(|&byte| byte == 0),
        "plaintext allocation was not cleared: {:02x?}",
        deallocations[0].bytes()
    );
}

#[test]
fn cbc_padding_error_zeroizes_the_intermediate_heap_allocation() {
    let mut padded = vec![0x6b; 48];
    padded[45] = 2;
    padded[46] = 3;
    padded[47] = 3;
    let (ciphertext, params) = encrypt_cbc(&padded);

    start_capture(ciphertext.len());
    let error = decrypt_aes256_cbc(&CEK, &params, &ciphertext).unwrap_err();
    let deallocations = finish_capture();

    assert_eq!(error, "cms: invalid PKCS#7 padding bytes");
    assert_eq!(deallocations.len(), 1, "{deallocations:#?}");
    assert!(
        deallocations[0].bytes().iter().all(|&byte| byte == 0),
        "padding-error allocation was not cleared: {:02x?}",
        deallocations[0].bytes()
    );
}

#[test]
fn cbc_stack_block_is_managed_by_zeroizing() {
    let source = include_str!("../cms.rs");
    assert!(source.contains("let mut buf = Zeroizing::new(GenericArray::clone_from_slice(chunk));"));
}
