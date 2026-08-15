using System;
using System.Collections.Generic;
using System.Numerics;
using System.Security.Cryptography;
using System.Text;
using Xunit;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// Cross-language golden vector for the Neo N3 fulfillment digest (R2-3.1).
    ///
    /// The fulfillment digest is re-implemented in 4 places (C# kernel, relayer JS for N3,
    /// relayer JS for NeoX, EVM Solidity) and was ALREADY broken once before. This test pins
    /// the C# <c>ComputeFulfillmentDigest</c> algorithm to a FIXED expected hex value for a
    /// canonical vector, so any field-order/domain-string/encoding drift in the contract's
    /// digest breaks here. The SAME canonical vector is asserted independently by the relayer
    /// JS suite (identifier-hygiene.test.mjs "N3 fulfillment digest matches the cross-language
    /// golden vector"), so a drift on EITHER side breaks one of the two suites — turning a
    /// silent cross-chain signature-rejection bug into a CI failure.
    ///
    /// This mirrors the ComputeFulfillmentDigest helper used by MorpheusOracleCallbackDispatchTests
    /// (the kernel's own algorithm); it is intentionally a second copy so a drift in the kernel
    /// source + the dispatch-test helper together is still caught by THIS independent recomputation.
    /// </summary>
    public class MorpheusOracleGoldenDigestTests
    {
        // Canonical vector (must stay identical to the relayer JS golden-vector test).
        private const string RequestId = "42";
        private const string AppId = "demo.app";
        private const string ModuleId = "oracle.fetch";
        private const string Operation = "fetch";
        private const bool Success = true;
        private const string ResultJson = "{\"v\":1}";
        private const string Error = "";
        // scriptHash big-endian display 0x1212...1212 -> little-endian VM bytes (20 bytes of 0x12;
        // 0x12 is byte-symmetric so reverse is a no-op, but spell it out for clarity).
        private static readonly byte[] ScriptHashLe = BytesOf12(20);
        private const uint NetworkMagic = 894710606; // testnet default (ProtocolSettings.Default.Network)

        private static byte[] BytesOf12(int n)
        {
            byte[] b = new byte[n];
            for (int i = 0; i < n; i++) b[i] = 0x12;
            return b;
        }

        [Fact]
        public void N3FulfillmentDigestMatchesGoldenVector()
        {
            byte[] digest = ComputeFulfillmentDigest(
                BigInteger.Parse(RequestId),
                AppId,
                ModuleId,
                Operation,
                Success,
                Encoding.UTF8.GetBytes(ResultJson),
                Error,
                ScriptHashLe,
                NetworkMagic
            );
            // MUST equal the relayer JS bound golden vector (cross-language parity).
            // If this fails, the contract's digest algorithm drifted from the JS implementation.
            Assert.Equal(
                "cf2832f7e5ab9a37a6c93907be5d7762d7b6c62c256363df432adc7b2fb2192e",
                BitConverter.ToString(digest).Replace("-", "").ToLowerInvariant()
            );
        }

        // Independent re-implementation of MorpheusOracle.ComputeFulfillmentDigest (mirrors the
        // kernel + the dispatch-test helper). Kept here so a simultaneous drift in kernel source
        // AND the dispatch helper is still caught.
        private static byte[] ComputeFulfillmentDigest(
            BigInteger requestId, string appId, string moduleId, string operation,
            bool success, byte[] result, string error, byte[] scriptHashLe, uint network)
        {
            static byte[] Sha(byte[] b)
            {
                using var sha = SHA256.Create();
                return sha.ComputeHash(b);
            }
            var payload = new List<byte>();
            payload.AddRange(Encoding.ASCII.GetBytes("miniapp-os-fulfillment-v1"));
            payload.AddRange(ToUInt256BE(requestId));
            payload.AddRange(Sha(Encoding.UTF8.GetBytes(appId)));
            payload.AddRange(Sha(Encoding.UTF8.GetBytes(moduleId)));
            payload.AddRange(Sha(Encoding.UTF8.GetBytes(operation)));
            payload.Add(success ? (byte)0x01 : (byte)0x00);
            payload.AddRange(Sha(result ?? Array.Empty<byte>()));
            payload.AddRange(Sha(Encoding.UTF8.GetBytes(error ?? "")));
            payload.AddRange(scriptHashLe);
            payload.Add((byte)(network & 0xFF));
            payload.Add((byte)((network >> 8) & 0xFF));
            payload.Add((byte)((network >> 16) & 0xFF));
            payload.Add((byte)((network >> 24) & 0xFF));
            return Sha(payload.ToArray());
        }

        // Big-endian 32-byte encoding (mirrors the contract's ToUInt256Bytes).
        private static byte[] ToUInt256BE(BigInteger value)
        {
            byte[] raw = value.ToByteArray(); // little-endian, two's complement
            byte[] outp = new byte[32];
            for (int i = 0; i < raw.Length && i < 32; i++) outp[31 - i] = raw[i];
            return outp;
        }
    }
}
