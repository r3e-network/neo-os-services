//go:build linux

package main

// Attestation against the AWS Nitro Security Module.
//
// This file is the only place the tool touches /dev/nsm, so it is the only part
// that is Linux-only: github.com/hf/nsm issues raw ioctl calls that do not
// compile anywhere else. Keeping the boundary here means the CMS/KMS decrypt path
// in cms.go, and its tests, still build and run on a developer's machine.

import (
	"fmt"

	"github.com/hf/nsm"
	"github.com/hf/nsm/request"
)

// attest opens /dev/nsm and returns a fresh attestation document bound to the
// supplied fields. It calls fail() (which exits) on any error.
func attest(nonce, userData, publicKey []byte) []byte {
	sess, err := nsm.OpenDefaultSession()
	if err != nil {
		fail(fmt.Sprintf("open /dev/nsm: %v (not running inside a Nitro enclave?)", err))
	}
	defer sess.Close()

	res, err := sess.Send(&request.Attestation{
		Nonce:     nonce,
		UserData:  userData,
		PublicKey: publicKey,
	})
	if err != nil {
		fail(fmt.Sprintf("nsm attestation request: %v", err))
	}
	if res.Error != "" {
		fail(fmt.Sprintf("nsm error code: %s", string(res.Error)))
	}
	if res.Attestation == nil || len(res.Attestation.Document) == 0 {
		fail("nsm returned an empty attestation document")
	}
	return res.Attestation.Document
}
