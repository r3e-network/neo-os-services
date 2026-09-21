using System;
using System.Collections.Generic;
using System.Text.RegularExpressions;
using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    // ===================================================================
    //  Storage-prefix freeze pin (audit low, MorpheusOracle.cs:64-93).
    //
    //  The prefix bytes below are the DEPLOYED on-chain storage layout for
    //  the MiniApp-OS kernel (testnet + mainnet). Renumbering an existing
    //  prefix orphans every key already written under the old byte — so this
    //  test pins the exact name -> byte map, forbids duplicates, and forbids
    //  reuse of the documented FREE bytes (0x0A-0x0F, 0x1A-0x1F are fine to
    //  claim; the USED bytes below are not). Any edit to the allocation map
    //  must be APPEND-ONLY (update this pin in the same PR).
    // ===================================================================
    public class MorpheusOracleStoragePrefixFreezeTests
    {
        private static readonly (string Name, byte Byte)[] Frozen = new[]
        {
            ("PREFIX_ADMIN", (byte)0x01),
            ("PREFIX_UPDATER", (byte)0x02),
            ("PREFIX_REQUEST", (byte)0x03),
            ("PREFIX_COUNTER", (byte)0x04),
            ("PREFIX_APP", (byte)0x05),
            ("PREFIX_APP_INDEX", (byte)0x06),
            ("PREFIX_APP_COUNT", (byte)0x07),
            ("PREFIX_MODULE", (byte)0x08),
            ("PREFIX_MODULE_INDEX", (byte)0x09),
            ("PREFIX_MODULE_COUNT", (byte)0x10),
            ("PREFIX_APP_MODULE_GRANT", (byte)0x11),
            ("PREFIX_RUNTIME_KEY", (byte)0x12),
            ("PREFIX_RUNTIME_KEY_ALGO", (byte)0x13),
            ("PREFIX_RUNTIME_KEY_VERSION", (byte)0x14),
            ("PREFIX_RUNTIME_VERIFIER", (byte)0x15),
            ("PREFIX_TOTAL_REQUESTS", (byte)0x16),
            ("PREFIX_TOTAL_FULFILLED", (byte)0x17),
            ("PREFIX_REQUEST_FEE", (byte)0x18),
            ("PREFIX_REQUEST_CREDIT", (byte)0x19),
            ("PREFIX_ACCRUED_REQUEST_FEES", (byte)0x20),
            ("PREFIX_APP_REQUESTS", (byte)0x21),
            ("PREFIX_APP_FULFILLED", (byte)0x22),
            ("PREFIX_APP_INBOX", (byte)0x23),
            ("PREFIX_APP_STATE", (byte)0x24),
            ("PREFIX_REQUEST_TTL", (byte)0x25),
            ("PREFIX_RESERVED_REQUEST_FEES", (byte)0x26),
            ("PREFIX_CALLBACK_INDEX", (byte)0x27),
            ("PREFIX_ACCOUNT_REGISTERED", (byte)0x28),
            ("PREFIX_SPONSOR_GATED", (byte)0x29),
            ("PREFIX_SPONSOR_ALLOWED", (byte)0x2A),
            ("PREFIX_SPONSOR_CAP", (byte)0x2B),
            ("PREFIX_SPONSOR_SPENT", (byte)0x2C),
            ("PREFIX_INDEX_REBUILD_REQUIRED", (byte)0x2D),
            ("PREFIX_INDEX_REBUILD_CURSOR", (byte)0x2E),
            // Appended with the governance timelocks (P0-07): admin rotation,
            // hash-pinned self-upgrade, and security-key re-pointing. Claimed
            // from the documented free slots 0x2F+.
            ("PREFIX_PENDING_ADMIN", (byte)0x2F),
            ("PREFIX_PENDING_ADMIN_TIME", (byte)0x30),
            ("PREFIX_UPGRADE_TIME", (byte)0x31),
            ("PREFIX_UPGRADE_HASH", (byte)0x32),
            ("PREFIX_PENDING_RUNTIME_KEY", (byte)0x33),
            ("PREFIX_PENDING_RUNTIME_VERIFIER", (byte)0x34),
            // Appended with the bounded default sponsorship cap (SVC-E-8), declared in
            // the MorpheusOracle.Sponsorship.cs partial. Claimed from free slot 0x35.
            ("PREFIX_SPONSOR_DEFAULT_CAP", (byte)0x35),
        };

        private static readonly Regex PrefixDecl = new(
            @"private static readonly byte\[\] (?<name>PREFIX_[A-Z_]+) = new byte\[\] \{ (?<byte>0x[0-9A-Fa-f]{2}) \};",
            RegexOptions.Compiled);

        private static Dictionary<string, byte> ParsePrefixes()
        {
            string source = ContractSourceAssertions.ReadSourcesInDirectory("contracts", "MorpheusOracle");
            var map = new Dictionary<string, byte>(StringComparer.Ordinal);
            foreach (Match m in PrefixDecl.Matches(source))
            {
                string name = m.Groups["name"].Value;
                byte value = Convert.ToByte(m.Groups["byte"].Value, 16);
                Assert.False(map.ContainsKey(name), $"duplicate prefix name {name}");
                map[name] = value;
            }
            return map;
        }

        [Fact]
        public void FrozenLayout_ExactNameByteMap()
        {
            var map = ParsePrefixes();
            Assert.Equal(Frozen.Length, map.Count);
            foreach (var (name, value) in Frozen)
            {
                Assert.True(map.TryGetValue(name, out byte actual), $"missing {name}");
                Assert.Equal(value, actual);
            }
        }

        [Fact]
        public void FrozenLayout_NoDuplicateBytes()
        {
            var map = ParsePrefixes();
            var seen = new HashSet<byte>();
            foreach (var kv in map)
            {
                Assert.True(seen.Add(kv.Value), $"byte 0x{kv.Value:X2} used by two prefixes ({kv.Key})");
            }
        }

        [Fact]
        public void FrozenLayout_UsedBytesStayInDocumentedRanges()
        {
            // USED ranges per the frozen map: 0x01-0x09, 0x10-0x19, 0x20-0x35.
            // New prefixes must not silently appear outside the frozen set —
            // any addition fails FrozenLayout_ExactNameByteMap anyway, but this
            // guard documents the append-only intent explicitly.
            var map = ParsePrefixes();
            foreach (var kv in map)
            {
                bool inRange =
                    (kv.Value >= 0x01 && kv.Value <= 0x09) ||
                    (kv.Value >= 0x10 && kv.Value <= 0x19) ||
                    (kv.Value >= 0x20 && kv.Value <= 0x35);
                Assert.True(inRange, $"{kv.Key} uses byte 0x{kv.Value:X2} outside the frozen used ranges");
            }
        }
    }
}
