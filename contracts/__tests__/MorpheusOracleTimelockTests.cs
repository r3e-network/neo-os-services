using System;
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
    /// VM-level coverage for the governance timelocks (P0-07): platform admin
    /// rotation, verification-key re-pointing, and contract self-upgrade must
    /// all be two-step (propose -> wait -> execute) so a stolen or malicious
    /// admin EOA cannot redirect oracle verification or swap the kernel within
    /// the transaction it is compromised in. Mirrors the audited
    /// PlatformRegistry timelock semantics.
    /// </summary>
    public class MorpheusOracleTimelockTests
    {
        private sealed record Harness(TestEngine Engine, Kernel Contract, UInt160 Owner);

        private static Harness Deploy()
        {
            byte[] priv = new byte[32];
            priv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(priv).PublicKey },
                ValidatorsCount = 1,
            };
            TestEngine engine = new(settings, true);
            engine.Fee = 10_000 * 100_000_000L;
            UInt160 owner = engine.Sender;
            engine.SetTransactionSigners(owner);
            Kernel contract = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);
            Assert.Equal(owner, contract.Admin);
            return new Harness(engine, contract, owner);
        }

        private static ulong BlockTimeMs(TestEngine engine) =>
            (ulong)engine.PersistingBlock.Timestamp.TotalMilliseconds;

        // PersistingBlock.Timestamp is read-only; the supported way to move
        // Runtime.Time forward is the underlying block header (same reflection
        // as MorpheusOracleFeeAccountingTests).
        private static void AdvanceTimeMs(TestEngine engine, ulong deltaMs)
        {
            object persistingBlock = engine.PersistingBlock;
            Block block = (Block)persistingBlock.GetType()
                .GetField("UnderlyingBlock", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(persistingBlock)!;
            block.Header.Timestamp = BlockTimeMs(engine) + deltaMs;
        }

        private static void AdvancePastTimelock(TestEngine engine) =>
            AdvanceTimeMs(engine, 86_400_000 + 1_000);

        [Fact]
        public void AdminRotation_RequiresTimelock()
        {
            Harness h = Deploy();
            UInt160 next = TestEngine.GetNewSigner().Account;

            // Proposal is admin-gated.
            h.Engine.SetTransactionSigners(next);
            AssertReverts(() => h.Contract.ProposeAdmin(next), "unauthorized");

            // Admin proposes; executing before the delay must fail.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.ProposeAdmin(next);
            AssertReverts(() => h.Contract.ExecuteAdminChange(), "timelock active");
            Assert.Equal(h.Owner, h.Contract.Admin);

            // After the delay the rotation lands exactly once.
            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteAdminChange();
            Assert.Equal(next, h.Contract.Admin);

            // The pending slot is consumed: a second execute must fail.
            AssertReverts(() => h.Contract.ExecuteAdminChange(), "no pending admin");
        }

        [Fact]
        public void AdminRotation_CanBeCanceledByAdminOnly()
        {
            Harness h = Deploy();
            UInt160 next = TestEngine.GetNewSigner().Account;

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.ProposeAdmin(next);

            h.Engine.SetTransactionSigners(next);
            AssertReverts(() => h.Contract.CancelAdminChange(), "unauthorized");

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.CancelAdminChange();
            AdvancePastTimelock(h.Engine);
            AssertReverts(() => h.Contract.ExecuteAdminChange(), "no pending admin");
            Assert.Equal(h.Owner, h.Contract.Admin);
        }

        [Fact]
        public void VerificationKeyRepointing_RequiresTimelock()
        {
            Harness h = Deploy();
            byte[] priv = new byte[32];
            priv[31] = 7;
            var verifier = new KeyPair(priv).PublicKey;

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.ProposeRuntimeVerificationPublicKey(verifier);

            // The active key must NOT change at proposal time.
            AssertReverts(() => h.Contract.ExecuteRuntimeVerificationPublicKey(), "timelock active");
            Assert.NotEqual(verifier, h.Contract.RuntimeVerificationPublicKey);

            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteRuntimeVerificationPublicKey();
            Assert.Equal(verifier, h.Contract.RuntimeVerificationPublicKey);
        }

        [Fact]
        public void EncryptionKeyRepointing_RequiresTimelock_AndBumpsVersionOnce()
        {
            Harness h = Deploy();

            h.Engine.SetTransactionSigners(h.Owner);
            BigInteger versionBefore = h.Contract.RuntimeEncryptionKeyVersion!.Value;
            h.Contract.ProposeRuntimeEncryptionKey("x25519", "pubkey-material");

            AssertReverts(() => h.Contract.ExecuteRuntimeEncryptionKey(), "timelock active");
            Assert.Equal(versionBefore, h.Contract.RuntimeEncryptionKeyVersion!.Value);

            AdvancePastTimelock(h.Engine);
            h.Contract.ExecuteRuntimeEncryptionKey();
            Assert.Equal(versionBefore + 1, h.Contract.RuntimeEncryptionKeyVersion!.Value);
            Assert.Equal("x25519", h.Contract.RuntimeEncryptionAlgorithm);
        }

        [Fact]
        public void Upgrade_RequiresScheduleTimelockAndMatchingArtifact()
        {
            Harness h = Deploy();

            // NefFile serializes through the Neo IO layer; round-trip it to the
            // byte form the update ABI takes.
            byte[] nef;
            using (var ms = new System.IO.MemoryStream())
            using (var bw = new System.IO.BinaryWriter(ms))
            {
                Kernel.Nef.Serialize(bw);
                nef = ms.ToArray();
            }
            string manifest = Kernel.Manifest.ToJson().ToString();

            h.Engine.SetTransactionSigners(h.Owner);
            // Executing without a scheduled upgrade must fail.
            AssertReverts(() => h.Contract.Update(nef, manifest), "no upgrade scheduled");

            h.Contract.ScheduleUpdate(nef, manifest);

            // Before the delay, even the exact matching artifact must fail.
            AssertReverts(() => h.Contract.Update(nef, manifest), "timelock active");

            AdvancePastTimelock(h.Engine);
            // A different artifact than scheduled must fail the hash pin.
            byte[] mutated = new byte[nef.Length];
            nef.CopyTo(mutated, 0);
            mutated[mutated.Length - 1] ^= 0xFF;
            AssertReverts(() => h.Contract.Update(mutated, manifest), "upgrade data mismatch");
        }

        private static void AssertReverts(Action action, string reasonFragment)
        {
            // Neo.SmartContract.Testing turns VM faults into
            // RuntimeException with the assert message embedded.
            Exception ex = Record.Exception(action);
            Assert.NotNull(ex);
            Assert.Contains(reasonFragment, ex.Message, StringComparison.OrdinalIgnoreCase);
        }
    }
}
