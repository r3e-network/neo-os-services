using System;
using System.Collections.Generic;
using System.Numerics;
using System.Reflection;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using Kernel = Neo.SmartContract.Testing.MorpheusOracle;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for the request fee-accounting lifecycle
    /// (submit -> fulfill -> expire).
    ///
    /// Unlike the source-text assertions in <see cref="MorpheusOracleTest"/>, these
    /// tests deploy the compiled NEF into an emulated Neo VM and exercise real
    /// storage, GAS transfers, witness checks and Runtime.Time.  That is required to
    /// catch fee-math regressions: the expiry refund used to credit the *current*
    /// configured fee and increment the sponsor credit unconditionally while only
    /// decrementing the accrued pool when it still held enough, which both
    /// over-refunded after a fee change and could leave fee-credit liabilities
    /// exceeding the GAS the contract actually holds.
    ///
    /// Current semantics under test (the reserve invariant): every pending request's
    /// FeePaid is mirrored into ReservedRequestFees, AccruedRequestFees >=
    /// ReservedRequestFees at all times, only the free surplus (WithdrawableFees =
    /// accrued - reserved) is admin-withdrawable, fulfillment releases the reserve
    /// into the withdrawable surplus, and expiry refunds the FULL FeePaid (the
    /// reserve guarantees its backing can never have been withdrawn).
    ///
    /// The deployed contract is the generated artifact under Generated/ (produced by
    /// `nccs MorpheusOracle.csproj --generate-artifacts Source`).  Regenerate it when
    /// the contract changes.
    /// </summary>
    public class MorpheusOracleFeeAccountingTests
    {
        private const string AppId = "demo.app";
        private const string ModuleId = "oracle.fetch"; // seeded as an active built-in module at deploy
        private const long DefaultFee = 1_000_000;       // DEFAULT_REQUEST_FEE

        // KernelRequest field indices in the serialized struct returned by GetRequest.
        private const int StatusIndex = 8;   // KernelRequestStatus { Pending=0, Succeeded=1, Failed=2 }
        private const int FeePaidIndex = 14; // BigInteger FeePaid (recorded at submission)

        private sealed record Harness(TestEngine Engine, Kernel Contract, UInt160 Owner, UInt160 Requester);

        private static Harness Deploy()
        {
            // ProtocolSettings.Default has no standby committee, which makes the
            // genesis (and therefore the GAS supply) un-mintable, so seed a 1-key
            // committee.  That key's account (engine.Sender) holds the genesis GAS.
            byte[] priv = new byte[32];
            priv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(priv).PublicKey },
                ValidatorsCount = 1,
            };

            TestEngine engine = new(settings, true);
            // Default per-invocation gas limit is 20 GAS; deploying the kernel and
            // seeding its built-in modules needs more, so raise it generously.
            engine.Fee = 10_000 * 100_000_000L; // 10,000 GAS
            UInt160 owner = engine.Sender;          // genesis GAS holder
            engine.SetTransactionSigners(owner);    // deployer => admin (set in _deploy)

            Kernel contract = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);

            // _deploy records the deploying sender as admin; the expiry path is
            // admin-gated, so this assumption must hold for the tests below.
            Assert.Equal(owner, contract.Admin);

            return new Harness(engine, contract, owner, TestEngine.GetNewSigner().Account);
        }

        private static ulong BlockTimeMs(TestEngine engine) =>
            (ulong)engine.PersistingBlock.Timestamp.TotalMilliseconds;

        // PersistingBlock.Timestamp is read-only in the testing API; the supported
        // way to move Runtime.Time forward is to mutate the underlying block header.
        private static void SetBlockTimeMs(TestEngine engine, ulong ms)
        {
            object persistingBlock = engine.PersistingBlock;
            Block block = (Block)persistingBlock.GetType()
                .GetField("UnderlyingBlock", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(persistingBlock)!;
            block.Header.Timestamp = ms;
        }

        private static void AdvancePastTtl(Harness h)
        {
            ulong ttl = (ulong)h.Contract.RequestTTL!.Value;
            SetBlockTimeMs(h.Engine, BlockTimeMs(h.Engine) + ttl + 1_000);
        }

        // Registers an app whose fee payer (sponsor) is the owner and grants the
        // seeded module, after prepaying the owner's fee credit with real GAS.
        private static void Bootstrap(Harness h, BigInteger deposit)
        {
            h.Engine.SetTransactionSigners(h.Owner);

            // Sending GAS to the kernel with no data credits the sender itself.
            bool? funded = h.Engine.Native.GAS.Transfer(h.Owner, h.Contract.Hash, deposit, null);
            Assert.True(funded == true);
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);

            h.Contract.RegisterMiniApp(AppId, h.Owner, h.Owner, null, "ipfs://meta", "deadbeef");
            h.Contract.GrantModuleToMiniApp(AppId, ModuleId);
        }

        // Submits as a distinct requester so the fee is drawn from the sponsor
        // (owner) credit, exactly the path that the expiry refund reverses.
        private static BigInteger Submit(Harness h)
        {
            h.Engine.SetTransactionSigners(h.Requester);
            return h.Contract.SubmitMiniAppRequest(AppId, ModuleId, "fetch", new byte[] { 1, 2, 3 })!.Value;
        }

        private static void Expire(Harness h, BigInteger requestId)
        {
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.ExpireStaleRequest(requestId);
        }

        private static BigInteger RequestField(Harness h, BigInteger requestId, int index)
        {
            IList<object> req = h.Contract.GetRequest(requestId)!;
            return (BigInteger)req[index];
        }

        // Core invariant the fix protects: outstanding fee-credit liabilities must
        // never exceed the GAS the contract actually holds.  Only the owner carries
        // credit in these tests, so its credit plus the accrued pool is the full
        // liability.  The reserve ledger must additionally never exceed the accrued
        // pool it is carved out of.
        private static void AssertSolvent(Harness h)
        {
            BigInteger gas = h.Engine.Native.GAS.BalanceOf(h.Contract.Hash)!.Value;
            BigInteger accrued = h.Contract.AccruedRequestFees!.Value;
            BigInteger reserved = h.Contract.ReservedRequestFees!.Value;
            BigInteger liabilities = h.Contract.FeeCreditOf(h.Owner)!.Value + accrued;
            Assert.True(gas >= liabilities, $"under-collateralized: gas={gas} < liabilities={liabilities}");
            Assert.True(accrued >= reserved, $"reserve overhang: accrued={accrued} < reserved={reserved}");
        }

        // Asserts the accrued/reserved/withdrawable triple in one shot so every
        // lifecycle step pins the full fee ledger, not just the accrued pool.
        private static void AssertFeeLedger(
            Harness h, BigInteger accrued, BigInteger reserved, BigInteger withdrawable)
        {
            Assert.Equal(accrued, h.Contract.AccruedRequestFees!.Value);
            Assert.Equal(reserved, h.Contract.ReservedRequestFees!.Value);
            Assert.Equal(withdrawable, h.Contract.WithdrawableFees!.Value);
        }

        // The testing engine surfaces a VM FAULT as a thrown exception whose text
        // includes the contract's assert message.
        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        // Crypto.Sign on this platform (observed on macOS/arm64) emits an invalid
        // signature for roughly 2% of nonces; Neo's own VerifySignature and pure
        // .NET ECDsa both reject those deterministically.  Re-sign until the
        // signature round-trips locally: the VM's CryptoLib.VerifyWithECDsa uses
        // the same managed verifier, so a locally verified signature is guaranteed
        // to verify in-contract and the suite stays deterministic.
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

        // Configures the runtime verifier + updater (both admin-gated) and fulfills
        // the request through the real secp256r1 signature path, mirroring what the
        // off-chain oracle does.  Fulfillment is the only transition that releases a
        // pending request's reserved fee into the withdrawable surplus.
        private static void Fulfill(Harness h, BigInteger requestId)
        {
            byte[] priv = new byte[32];
            priv[31] = 7;
            KeyPair verifier = new KeyPair(priv);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetRuntimeVerificationPublicKey(verifier.PublicKey);
            h.Contract.SetUpdater(h.Owner);

            byte[] result = new byte[] { 0x01 };
            byte[] scriptHashLe = h.Contract.Hash.GetSpan().ToArray();
            uint network = ProtocolSettings.Default.Network;
            byte[] digest = ComputeFulfillmentDigest(
                requestId, AppId, ModuleId, "fetch", true, result, "", scriptHashLe, network);
            byte[] signature = SignVerified(digest, verifier);

            h.Contract.FulfillRequest(requestId, true, result, "", signature);
            Assert.Equal(BigInteger.One, RequestField(h, requestId, StatusIndex)); // Succeeded
        }

        [Fact]
        public void SubmitThenExpire_RefundsExactFee_AndKeepsAccruedSymmetric()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            BigInteger id = Submit(h);

            // Fee debited from the sponsor, mirrored into the accrued pool AND the
            // reserved ledger (nothing is withdrawable while the request is
            // pending), and the exact amount recorded on the request for a later
            // symmetric refund.
            Assert.Equal(deposit - DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, DefaultFee, DefaultFee, 0);
            Assert.Equal(new BigInteger(DefaultFee), RequestField(h, id, FeePaidIndex));
            Assert.Equal(BigInteger.Zero, RequestField(h, id, StatusIndex)); // Pending

            AdvancePastTtl(h);
            Expire(h, id);

            // Sponsor made whole; accrued and reserved both return to zero (credit,
            // accrued and reserved all moved by the same amount).
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, 0, 0, 0);
            Assert.Equal(new BigInteger(2), RequestField(h, id, StatusIndex)); // Failed
            AssertSolvent(h);
        }

        [Fact]
        public void Expire_AfterFeeChange_RefundsFeePaid_NotCurrentFee()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            BigInteger id = Submit(h); // pays DefaultFee (1,000,000)
            Assert.Equal(deposit - DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, DefaultFee, DefaultFee, 0);

            // Admin raises the fee 5x AFTER submission but before expiry.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.SetRequestFee(5 * DefaultFee);
            Assert.Equal(new BigInteger(5 * DefaultFee), h.Contract.SystemRequestFee!.Value);

            AdvancePastTtl(h);
            Expire(h, id);

            // Refund must equal the 1,000,000 actually paid, NOT the current
            // 5,000,000.  The pre-fix code refunded SystemRequestFee(), inflating the
            // sponsor credit to deposit + 4,000,000 and leaving 1,000,000 stuck in
            // the accrued pool.
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, 0, 0, 0);
            AssertSolvent(h);
        }

        [Fact]
        public void WithdrawAccruedFees_OfReservedPendingBacking_Reverts_AndExpiryRefundsInFull()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            BigInteger id = Submit(h);
            AssertFeeLedger(h, DefaultFee, DefaultFee, 0);

            // The whole accrued pool backs the pending request, so the admin may
            // not withdraw any of it.  The pre-reserve code clamped the LATER
            // expiry refund instead, silently shorting the sponsor.
            h.Engine.SetTransactionSigners(h.Owner);
            AssertReverts(
                () => h.Contract.WithdrawAccruedFees(h.Owner, DefaultFee),
                "exceeds withdrawable");

            // The failed withdrawal must not have moved any GAS or ledger state.
            Assert.Equal(deposit, h.Engine.Native.GAS.BalanceOf(h.Contract.Hash)!.Value);
            AssertFeeLedger(h, DefaultFee, DefaultFee, 0);

            AdvancePastTtl(h);
            Expire(h, id);

            // With its backing protected by the reserve, the expiry refund is the
            // FULL FeePaid and the sponsor is made whole.
            Assert.Equal(deposit, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, 0, 0, 0);
            AssertSolvent(h);
        }

        [Fact]
        public void Fulfillment_ReleasesReserve_MakingFeeWithdrawable_WhilePendingStaysProtected()
        {
            Harness h = Deploy();
            BigInteger deposit = 10 * DefaultFee;
            Bootstrap(h, deposit);

            BigInteger id1 = Submit(h);
            BigInteger id2 = Submit(h); // second pending request, also paid by the sponsor
            Assert.Equal(deposit - 2 * DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, 2 * DefaultFee, 2 * DefaultFee, 0);

            // Both fees back pending requests: even a partial withdrawal reverts.
            h.Engine.SetTransactionSigners(h.Owner);
            AssertReverts(
                () => h.Contract.WithdrawAccruedFees(h.Owner, DefaultFee / 2),
                "exceeds withdrawable");

            // Fulfilling request 1 earns its fee: the reserve releases exactly that
            // request's FeePaid into the withdrawable surplus.
            Fulfill(h, id1);
            AssertFeeLedger(h, 2 * DefaultFee, DefaultFee, DefaultFee);

            // The earned fee is now withdrawable as revenue...
            h.Contract.WithdrawAccruedFees(h.Owner, DefaultFee);
            AssertFeeLedger(h, DefaultFee, DefaultFee, 0);

            // ...but nothing beyond it: request 2's backing is still reserved.
            AssertReverts(
                () => h.Contract.WithdrawAccruedFees(h.Owner, 1),
                "exceeds withdrawable");

            AdvancePastTtl(h);
            Expire(h, id2);

            // Request 2's refund is the FULL FeePaid; only the fulfilled request's
            // fee was spendable revenue, so the sponsor ends down exactly one fee.
            Assert.Equal(deposit - DefaultFee, h.Contract.FeeCreditOf(h.Owner)!.Value);
            AssertFeeLedger(h, 0, 0, 0);
            AssertSolvent(h);
        }

        // Behavioral coverage for the fulfillment signature path: the off-chain
        // oracle signs ComputeFulfillmentDigest with the runtime verifier key, and
        // FulfillRequest must recompute the identical digest and accept the secp256r1
        // signature. This pins the exact digest byte layout that the relayer's
        // buildFulfillmentDigestBytes must reproduce; a divergence here would mean a
        // signature mismatch and a stalled oracle.
        [Fact]
        public void FulfillRequest_VerifiesSignatureOverDigest_AndMarksSucceeded()
        {
            Harness h = Deploy();
            Bootstrap(h, 10 * DefaultFee);
            BigInteger id = Submit(h); // appId=demo.app, moduleId=oracle.fetch, operation="fetch"
            Assert.Equal(BigInteger.Zero, RequestField(h, id, StatusIndex)); // Pending
            AssertFeeLedger(h, DefaultFee, DefaultFee, 0);

            byte[] priv = new byte[32];
            priv[31] = 7;
            KeyPair verifier = new KeyPair(priv);

            h.Engine.SetTransactionSigners(h.Owner); // admin sets verifier + updater
            h.Contract.SetRuntimeVerificationPublicKey(verifier.PublicKey);
            h.Contract.SetUpdater(h.Owner);          // owner submits the fulfill tx (updater witness)

            byte[] result = new byte[] { 0xAA, 0xBB, 0xCC };
            string error = "";
            byte[] scriptHashLe = h.Contract.Hash.GetSpan().ToArray(); // (ByteString)Runtime.ExecutingScriptHash (LE)
            uint network = ProtocolSettings.Default.Network;        // == Runtime.GetNetwork() in the engine
            byte[] digest = ComputeFulfillmentDigest(
                id, AppId, ModuleId, "fetch", true, result, error, scriptHashLe, network);
            byte[] signature = SignVerified(digest, verifier);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.FulfillRequest(id, true, result, error, signature);

            Assert.Equal(BigInteger.One, RequestField(h, id, StatusIndex)); // Succeeded
            // Fulfillment earned the fee: reserve released, surplus withdrawable.
            AssertFeeLedger(h, DefaultFee, 0, DefaultFee);
        }

        // C# replica of the contract's ComputeFulfillmentDigest (and the relayer's
        // buildFulfillmentDigestBytes). If FulfillRequest above accepts a signature
        // over this, the contract computes the identical bytes.
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
