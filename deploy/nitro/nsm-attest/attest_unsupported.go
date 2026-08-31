//go:build !linux

package main

// Non-Linux stand-in for the NSM session.
//
// github.com/hf/nsm talks to /dev/nsm through Linux-only ioctl syscalls, so the
// real implementation lives in attest_linux.go. Without this file the whole
// module - including the CMS/KMS decrypt logic in cms.go and its tests - fails to
// compile on any other OS, which reads as a broken repo rather than as a
// missing enclave.
//
// This stub is fail-closed on purpose. It has no way to produce a document and
// does not try: an attestation document is the root of trust for KMS key release,
// so a build outside a Nitro enclave must refuse rather than ever return
// something that could be mistaken for one.

func attest(nonce, userData, publicKey []byte) []byte {
	fail("NSM attestation is only available inside a Linux AWS Nitro enclave")
	return nil
}
