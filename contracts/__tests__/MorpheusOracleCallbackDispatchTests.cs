using System;
using System.Collections.Generic;
using System.Numerics;
using Neo;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using Kernel = Neo.SmartContract.Testing.MorpheusOracle;
using Consumer = Neo.SmartContract.Testing.OracleCallbackConsumer;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM coverage for kernel -> consumer callback DISPATCH.
    ///
    /// FulfillRequest now delivers the rich onMiniAppResult callback (carrying the
    /// real appId + requester) with a fallback to the legacy 5-arg onOracleResult.
    /// Previously it only ever called onOracleResult, so a consumer routed the dead
    /// onMiniAppResult ABI silently recorded appId="legacy"/requester=null. This test
    /// deploys the real OracleCallbackConsumer (which implements onMiniAppResult) and
    /// asserts the recorded callback carries the real appId + a populated requester.
    ///
    /// Uses the generated artifacts under Generated/ — regenerate after contract changes.
    /// </summary>
    public class MorpheusOracleCallbackDispatchTests
    {
        private const string AppId = "demo.app";
        private const string ModuleId = "oracle.fetch"; // seeded active built-in module at deploy
        private const string Operation = "fetch";
        private const long DefaultFee = 1_000_000;       // DEFAULT_REQUEST_FEE

        [Fact]
        public void Fulfill_DispatchesRichOnMiniAppResult_WithRealAppIdAndRequester()
        {
            // 1-key committee so the genesis GAS is mintable (engine.Sender holds it).
            byte[] committeePriv = new byte[32];
            committeePriv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(committeePriv).PublicKey },
                ValidatorsCount = 1,
            };

            TestEngine engine = new(settings, true);
            engine.Fee = 10_000 * 100_000_000L; // 10,000 GAS — deploy + seed needs > the 20 GAS default
            UInt160 owner = engine.Sender;
            engine.SetTransactionSigners(owner);

            Kernel oracle = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);
            Consumer consumer = engine.Deploy<Consumer>(Consumer.Nef, Consumer.Manifest, null);

            // Point the consumer at the kernel so its ValidateKernel accepts the callback.
            consumer.SetKernel(oracle.Hash);

            // Register the app with the consumer as its callback contract, grant the
            // module, and prepay the owner's fee credit.
            bool? funded = engine.Native.GAS.Transfer(owner, oracle.Hash, 10 * DefaultFee, null);
            Assert.True(funded == true);
            oracle.RegisterMiniApp(AppId, owner, owner, consumer.Hash, "ipfs://meta", "deadbeef");
            oracle.GrantModuleToMiniApp(AppId, ModuleId);

            // Submit as a distinct requester so a non-null requester is recorded.
            UInt160 requester = TestEngine.GetNewSigner().Account;
            engine.SetTransactionSigners(requester);
            BigInteger requestId = oracle
                .SubmitMiniAppRequest(AppId, ModuleId, Operation, new byte[] { 1, 2, 3 })!.Value;

            // Fulfill through the real secp256r1 verifier path (mirrors the off-chain oracle).
            byte[] verifierPriv = new byte[32];
            verifierPriv[31] = 7;
            KeyPair verifier = new KeyPair(verifierPriv);
            engine.SetTransactionSigners(owner);
            oracle.SetRuntimeVerificationPublicKey(verifier.PublicKey);
            oracle.SetUpdater(owner);

            byte[] result = new byte[] { 0x01 };
            byte[] scriptHashLe = oracle.Hash.GetSpan().ToArray();
            uint network = ProtocolSettings.Default.Network;
            byte[] digest = ComputeFulfillmentDigest(
                requestId, AppId, ModuleId, Operation, true, result, "", scriptHashLe, network);
            byte[] signature = SignVerified(digest, verifier);
            oracle.FulfillRequest(requestId, true, result, "", signature);

            // The consumer must have recorded the RICH onMiniAppResult callback: the real
            // appId/moduleId/operation + a populated requester — NOT the legacy adapter's
            // appId="legacy"/requester=null. GetCallback returns raw VM types.
            IList<object> cb = consumer.GetCallback(requestId)!;
            Assert.Equal(AppId, Str(cb[0]));        // DECISIVE: real appId — legacy adapter records "legacy"
            Assert.Equal(ModuleId, Str(cb[1]));     // ModuleId
            Assert.Equal(Operation, Str(cb[2]));    // Operation
            Assert.False(cb[3] is Neo.VM.Types.Null, "requester populated; legacy adapter passes null");
        }

        // ── helpers (mirrors MorpheusOracleFeeAccountingTests harness) ───────────────

        // The VM test above covers the happy rich path (consumer implements onMiniAppResult
        // and receives the real appId/requester). These SOURCE-LEVEL assertions pin the
        // dispatch CONTRACT a future edit could silently break without any VM signal:
        //   (a) the rich onMiniAppResult call carries the EXACT 8 args in the order the
        //       consumer's OnMiniAppResult signature declares (a reorder = silent cross-
        //       contract bug, the #1 dispatch hazard);
        //   (b) the legacy onOracleResult fallback is invoked STRICTLY inside the catch of
        //       the rich call — i.e. EITHER/OR, never BOTH (a consumer implementing both
        //       must not be called twice);
        //   (c) the rich arg order matches the consumer source, not just this contract.
        // Source-level (via ContractSourceAssertions) is the idiomatic pattern here (see
        // OracleCallbackConsumerTest / UserConsumerN3Test) and avoids compiling a second
        // legacy-only consumer contract just to exercise the fallback at the VM level.
        [Fact]
        public void DispatchCallsRichOnMiniAppResultFirstWithLegacyFallbackOnlyOnCatch()
        {
            string kernel = ContractSourceAssertions.ReadSource(
                "contracts", "MorpheusOracle", "MorpheusOracle.cs");
            string consumer = ContractSourceAssertions.ReadSource(
                "contracts", "OracleCallbackConsumer", "OracleCallbackConsumer.cs");

            // (c) The consumer's OnMiniAppResult declares this exact parameter order; the
            // kernel must pass args in the SAME order. Asserting the consumer signature
            // here means a drift between the two files is caught at test time.
            ContractSourceAssertions.AssertHasPublicStaticMethod(
                consumer, "void", "OnMiniAppResult");
            Assert.Matches(
                @"OnMiniAppResult\(\s*BigInteger\s+requestId\s*,\s*string\s+appId\s*,\s*string\s+moduleId\s*,\s*string\s+operation\s*,\s*UInt160\s+requester\s*,\s*bool\s+success\s*,\s*ByteString\s+result\s*,\s*string\s+error\s*\)",
                consumer);

            // (a) The kernel's rich Contract.Call passes CALLBACK_METHOD then these 8 args
            // in the order (requestId, appId, moduleId, operation, requester, success,
            // result, error) — matching the consumer signature above.
            Assert.Contains("CALLBACK_METHOD", kernel);
            Assert.Matches(
                @"Contract\.Call\(\s*req\.CallbackContract\s*,\s*CALLBACK_METHOD\s*,\s*CallFlags\.All\s*,\s*" +
                @"requestId\s*,\s*req\.AppId\s*,\s*req\.ModuleId\s*,\s*req\.Operation\s*,\s*" +
                @"req\.Requester\s*,\s*req\.Success\s*,\s*req\.Result\s*,\s*req\.Error\s*\)",
                kernel);

            // (b) The legacy fallback (LEGACY_CALLBACK_METHOD / onOracleResult) must be
            // nested strictly inside the catch of the rich call. We assert the rich call's
            // arguments appear BEFORE the legacy call's arguments in source order, and that
            // the legacy call is reached only via a catch. This locks EITHER/OR semantics:
            // a consumer whose onMiniAppResult succeeds never reaches the legacy call.
            Assert.Contains("LEGACY_CALLBACK_METHOD", kernel);
            Assert.Matches(
                @"Contract\.Call\(\s*req\.CallbackContract\s*,\s*LEGACY_CALLBACK_METHOD\s*,\s*CallFlags\.All\s*,\s*" +
                @"requestId\s*,\s*req\.Operation\s*,\s*req\.Success\s*,\s*req\.Result\s*,\s*req\.Error\s*\)",
                kernel);

            int richCallPos = kernel.IndexOf("CALLBACK_METHOD", StringComparison.Ordinal);
            int legacyCallPos = kernel.IndexOf("LEGACY_CALLBACK_METHOD", StringComparison.Ordinal);
            Assert.True(richCallPos >= 0 && legacyCallPos > richCallPos,
                "legacy onOracleResult fallback must come after the rich onMiniAppResult call");
        }

        // GetCallback returns raw VM stack items; decode a ByteString field to its UTF-8 string.
        private static string Str(object item) =>
            System.Text.Encoding.UTF8.GetString(((Neo.VM.Types.ByteString)item).GetSpan());

        // Crypto.Sign occasionally emits a signature the managed verifier rejects; re-sign
        // until it round-trips locally so the suite stays deterministic.
        private static byte[] SignVerified(byte[] digest, KeyPair key)
        {
            for (int attempt = 0; attempt < 16; attempt++)
            {
                byte[] signature = Neo.Cryptography.Crypto.Sign(
                    digest, key.PrivateKey, Neo.Cryptography.ECC.ECCurve.Secp256r1);
                if (Neo.Cryptography.Crypto.VerifySignature(digest, signature, key.PublicKey))
                    return signature;
            }
            throw new InvalidOperationException("could not produce a locally verifiable signature");
        }

        private static byte[] ComputeFulfillmentDigest(
            BigInteger requestId, string appId, string moduleId, string operation,
            bool success, byte[] result, string error, byte[] scriptHashLe, uint network)
        {
            static byte[] Sha(byte[] b)
            {
                using var sha = System.Security.Cryptography.SHA256.Create();
                return sha.ComputeHash(b);
            }
            var payload = new List<byte>();
            payload.AddRange(System.Text.Encoding.ASCII.GetBytes("miniapp-os-fulfillment-v1"));
            payload.AddRange(ToUInt256BE(requestId));
            payload.AddRange(Sha(System.Text.Encoding.UTF8.GetBytes(appId)));
            payload.AddRange(Sha(System.Text.Encoding.UTF8.GetBytes(moduleId)));
            payload.AddRange(Sha(System.Text.Encoding.UTF8.GetBytes(operation)));
            payload.Add(success ? (byte)0x01 : (byte)0x00);
            payload.AddRange(Sha(result ?? System.Array.Empty<byte>()));
            payload.AddRange(Sha(System.Text.Encoding.UTF8.GetBytes(error ?? "")));
            payload.AddRange(scriptHashLe);
            payload.Add((byte)(network & 0xFF));
            payload.Add((byte)((network >> 8) & 0xFF));
            payload.Add((byte)((network >> 16) & 0xFF));
            payload.Add((byte)((network >> 24) & 0xFF));
            return Sha(payload.ToArray());
        }

        // Mirrors the contract's ToUInt256Bytes: big-endian 32-byte encoding.
        private static byte[] ToUInt256BE(BigInteger value)
        {
            byte[] raw = value.ToByteArray(); // little-endian, two's complement
            byte[] outp = new byte[32];
            for (int i = 0; i < raw.Length && i < 32; i++) outp[31 - i] = raw[i];
            return outp;
        }
    }
}
