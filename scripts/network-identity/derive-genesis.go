//go:build ignore

// Run from a reviewed NeoGo v0.122.0 checkout. No RPC, keys, or database access.
package main

import (
	"fmt"
	"github.com/nspcc-dev/neo-go/pkg/config"
	"github.com/nspcc-dev/neo-go/pkg/core"
)

func main() {
	for _, network := range []string{"mainnet", "testnet"} {
		cfg, err := config.LoadFile("config/protocol." + network + ".yml")
		if err != nil { panic(err) }
		block, err := core.CreateGenesisBlock(cfg.ProtocolConfiguration)
		if err != nil { panic(err) }
		fmt.Printf("%s magic=%d genesis_hash=0x%s\n", network, cfg.ProtocolConfiguration.Magic, block.Hash().StringLE())
	}
}
