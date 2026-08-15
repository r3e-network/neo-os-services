using System;
using System.Numerics;
using System.Text;
using Neo;
using Neo.SmartContract.Testing;
using Neo.Wallets;
using Xunit;
using Kernel = Neo.SmartContract.Testing.MorpheusOracle;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for the callback->appId reverse-index uniqueness rules.
    ///
    /// Threat model under test: the reverse index used by the legacy request entry
    /// points (Request / RequestFromCallback / QueueAutomationRequest) was
    /// last-write-wins, so ANY account could register a fresh appId naming an
    /// existing app's callback contract and repoint that contract's request routing
    /// to an app it controls (takeover) or to an app with no module grants
    /// (permissionless DoS of the victim's on-chain entry points).
    ///
    /// Rules pinned here:
    ///   1. Registering/reconfiguring a callback already mapped to a DIFFERENT
    ///      appId reverts with "callback already registered".
    ///   2. The SAME app re-writing its own mapping stays allowed (owner updates).
    ///   3. Repointing away releases the callback for other apps to claim.
    ///   4. RebuildIndexes (the post-upgrade backfill) is first-wins on legacy
    ///      registries where several records share one callback (mainnet has such a
    ///      set), mirroring the earliest-registered-wins semantics of the deployed
    ///      O(n) resolver; it must neither overwrite the winner nor revert.
    ///   5. A legacy duplicate that later repoints away must not clear the
    ///      winner's mapping (the delete path is owner-checked).
    ///
    /// Legacy duplicate state (two records naming one callback) cannot be created
    /// through the public API any more - that is exactly the fix - so tests 4 and 5
    /// fabricate it through raw storage writes, simulating a registry that predates
    /// the uniqueness assert and was carried across ContractManagement.Update.
    ///
    /// The deployed contract is the generated artifact under Generated/ (produced
    /// by `nccs MorpheusOracle.csproj --generate-artifacts Source`).  Regenerate it
    /// when the contract changes.
    /// </summary>
    public class MorpheusOracleCallbackIndexTests
    {
        private const byte PrefixApp = 0x05;           // PREFIX_APP
        private const byte PrefixCallbackIndex = 0x27; // PREFIX_CALLBACK_INDEX
        private const byte PrefixIndexRebuildRequired = 0x2D;
        private const byte PrefixIndexRebuildCursor = 0x2E;

        private const string VictimAppId = "victim.app";
        private const string OtherAppId = "other.app";
        private const string AttackerAppId = "attacker.app";

        private sealed record Harness(TestEngine Engine, Kernel Contract, UInt160 Owner);

        private static Harness Deploy()
        {
            // Same bootstrap as MorpheusOracleFeeAccountingTests: a 1-key committee
            // makes the genesis mintable and engine.Sender the deployer => admin.
            byte[] priv = new byte[32];
            priv[31] = 1;
            ProtocolSettings settings = ProtocolSettings.Default with
            {
                StandbyCommittee = new[] { new KeyPair(priv).PublicKey },
                ValidatorsCount = 1,
            };

            TestEngine engine = new(settings, true);
            engine.Fee = 10_000 * 100_000_000L; // deploy + module seeding needs > 20 GAS
            UInt160 owner = engine.Sender;
            engine.SetTransactionSigners(owner);

            Kernel contract = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);
            Assert.Equal(owner, contract.Admin);

            return new Harness(engine, contract, owner);
        }

        private static UInt160 FilledHash(byte value)
        {
            byte[] bytes = new byte[20];
            for (int i = 0; i < bytes.Length; i++) bytes[i] = value;
            return new UInt160(bytes);
        }

        private static byte[] StorageKey(byte prefix, byte[] suffix)
        {
            byte[] key = new byte[suffix.Length + 1];
            key[0] = prefix;
            Buffer.BlockCopy(suffix, 0, key, 1, suffix.Length);
            return key;
        }

        private static byte[] CallbackIndexKey(UInt160 callback) =>
            StorageKey(PrefixCallbackIndex, callback.GetSpan().ToArray());

        private static byte[] AppRecordKey(string appId) =>
            StorageKey(PrefixApp, Encoding.UTF8.GetBytes(appId));

        private static byte[] ScalarKey(byte prefix) => new[] { prefix };

        private static string? IndexedAppId(Harness h, UInt160 callback)
        {
            byte[] key = CallbackIndexKey(callback);
            if (!h.Contract.Storage.Contains(key)) return null;
            return Encoding.UTF8.GetString(h.Contract.Storage.Get(key).Span);
        }

        private static void Register(Harness h, string appId, UInt160 admin, UInt160? callback)
        {
            h.Engine.SetTransactionSigners(admin);
            h.Contract.RegisterMiniApp(appId, admin, admin, callback, "ipfs://meta", "deadbeef");
        }

        // The testing engine surfaces a VM FAULT as a thrown exception whose text
        // includes the contract's assert message.
        private static void AssertReverts(Action action, string messageFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(messageFragment, ex.ToString());
        }

        // Simulates a registry that predates the uniqueness assert and was carried
        // across ContractManagement.Update: two records naming the SAME callback
        // contract and an EMPTY reverse index (the index prefix is new storage, so
        // it starts empty after the upgrade until RebuildIndexes backfills it).
        //
        // victim.app is registered first (registry index 0), other.app second; then
        // other.app's record is byte-patched so its CallbackContract equals the
        // victim's, and both index entries written by the new registration path are
        // removed.  This is exactly the mainnet shape (three e2e apps share one
        // consumer contract).
        private static (UInt160 Shared, UInt160 VictimAdmin, UInt160 OtherAdmin) FabricateLegacyDuplicate(Harness h)
        {
            UInt160 shared = FilledHash(0xAA);
            UInt160 placeholder = FilledHash(0xBB);
            UInt160 victimAdmin = TestEngine.GetNewSigner().Account;
            UInt160 otherAdmin = TestEngine.GetNewSigner().Account;

            Register(h, VictimAppId, victimAdmin, shared);
            Register(h, OtherAppId, otherAdmin, placeholder);

            // Patch other.app's serialized MiniAppRecord: the placeholder callback's
            // 20 constant bytes appear exactly once, so an in-place replace rewrites
            // CallbackContract to the shared hash without disturbing the layout.
            byte[] record = h.Contract.Storage.Get(AppRecordKey(OtherAppId)).ToArray();
            byte[] needle = placeholder.GetSpan().ToArray();
            byte[] replacement = shared.GetSpan().ToArray();
            int at = ((ReadOnlySpan<byte>)record).IndexOf(needle);
            Assert.True(at >= 0, "placeholder callback bytes not found in serialized record");
            Buffer.BlockCopy(replacement, 0, record, at, replacement.Length);
            Assert.Equal(-1, ((ReadOnlySpan<byte>)record).IndexOf(needle)); // appeared exactly once
            h.Contract.Storage.Put(AppRecordKey(OtherAppId), record);

            // The pre-upgrade contract had no reverse index: start it empty.
            h.Contract.Storage.Remove(CallbackIndexKey(shared));
            h.Contract.Storage.Remove(CallbackIndexKey(placeholder));
            Assert.Null(IndexedAppId(h, shared));

            return (shared, victimAdmin, otherAdmin);
        }

        [Fact]
        public void Register_ForeignCallbackTakeover_Reverts_AndVictimMappingSurvives()
        {
            Harness h = Deploy();
            UInt160 callback = FilledHash(0xAA);
            UInt160 victimAdmin = TestEngine.GetNewSigner().Account;
            UInt160 attacker = TestEngine.GetNewSigner().Account;

            Register(h, VictimAppId, victimAdmin, callback);
            Assert.Equal(VictimAppId, IndexedAppId(h, callback));

            // The attacker self-witnesses a fresh appId naming the victim's callback;
            // pre-fix this overwrote the reverse index (last-write-wins takeover).
            h.Engine.SetTransactionSigners(attacker);
            AssertReverts(
                () => h.Contract.RegisterMiniApp(AttackerAppId, attacker, attacker, callback, "ipfs://evil", "beef"),
                "callback already registered");

            // Routing stays with the victim and the attacker app was never created.
            Assert.Equal(VictimAppId, IndexedAppId(h, callback));
            Assert.False(h.Contract.Storage.Contains(AppRecordKey(AttackerAppId)));
        }

        [Fact]
        public void Configure_RepointOntoForeignCallback_Reverts()
        {
            Harness h = Deploy();
            UInt160 victimCallback = FilledHash(0xAA);
            UInt160 ownCallback = FilledHash(0xBB);
            UInt160 victimAdmin = TestEngine.GetNewSigner().Account;
            UInt160 otherAdmin = TestEngine.GetNewSigner().Account;

            Register(h, VictimAppId, victimAdmin, victimCallback);
            Register(h, OtherAppId, otherAdmin, ownCallback);

            // ConfigureMiniApp goes through the same PutMiniApp path, so repointing an
            // EXISTING app onto someone else's callback must also be blocked.
            h.Engine.SetTransactionSigners(otherAdmin);
            AssertReverts(
                () => h.Contract.ConfigureMiniApp(OtherAppId, otherAdmin, victimCallback, "ipfs://meta", "deadbeef", true),
                "callback already registered");

            Assert.Equal(VictimAppId, IndexedAppId(h, victimCallback));
            Assert.Equal(OtherAppId, IndexedAppId(h, ownCallback));
        }

        [Fact]
        public void Configure_SameApp_KeepingItsCallback_StaysAllowed()
        {
            Harness h = Deploy();
            UInt160 callback = FilledHash(0xAA);
            UInt160 admin = TestEngine.GetNewSigner().Account;

            Register(h, VictimAppId, admin, callback);

            // Owner update: same appId re-writes its own mapping (metadata refresh,
            // active toggle) without tripping the uniqueness assert.
            h.Engine.SetTransactionSigners(admin);
            h.Contract.ConfigureMiniApp(VictimAppId, admin, callback, "ipfs://meta-v2", "cafebabe", true);

            Assert.Equal(VictimAppId, IndexedAppId(h, callback));
        }

        [Fact]
        public void Configure_RepointAway_ReleasesCallback_ForOtherAppsToClaim()
        {
            Harness h = Deploy();
            UInt160 first = FilledHash(0xAA);
            UInt160 second = FilledHash(0xBB);
            UInt160 admin = TestEngine.GetNewSigner().Account;
            UInt160 otherAdmin = TestEngine.GetNewSigner().Account;

            Register(h, VictimAppId, admin, first);

            h.Engine.SetTransactionSigners(admin);
            h.Contract.ConfigureMiniApp(VictimAppId, admin, second, "ipfs://meta", "deadbeef", true);
            Assert.Null(IndexedAppId(h, first)); // released
            Assert.Equal(VictimAppId, IndexedAppId(h, second));

            // The released callback is claimable again - the assert must not be
            // stricter than "currently mapped to a different app".
            Register(h, OtherAppId, otherAdmin, first);
            Assert.Equal(OtherAppId, IndexedAppId(h, first));
        }

        [Fact]
        public void RebuildIndexes_OnLegacyDuplicateRecords_FirstRegisteredWins_AndDoesNotRevert()
        {
            Harness h = Deploy();
            (UInt160 shared, _, _) = FabricateLegacyDuplicate(h);

            // Admin-gated backfill over the whole (tiny) registry. With a revert-on-
            // duplicate this call would FAULT and the backfill could never complete;
            // with last-write-wins the LATER record would steal the mapping.
            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.RebuildIndexes(0, 16);

            Assert.Equal(VictimAppId, IndexedAppId(h, shared));

            // Idempotency across re-runs (operational requirement for chunked
            // backfills that may overlap or be retried).
            h.Contract.RebuildIndexes(0, 16);
            Assert.Equal(VictimAppId, IndexedAppId(h, shared));
        }

        [Fact]
        public void RebuildIndexes_RepairsAPoisonedLaterCallbackMapping()
        {
            Harness h = Deploy();
            (UInt160 shared, _, _) = FabricateLegacyDuplicate(h);

            // Simulate an entry poisoned before the migration lock existed. The
            // canonical owner is still the first registry record, not whichever
            // appId happens to be present in the reverse index before backfill.
            h.Contract.Storage.Put(CallbackIndexKey(shared), Encoding.UTF8.GetBytes(OtherAppId));
            Assert.Equal(OtherAppId, IndexedAppId(h, shared));

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.RebuildIndexes(0, 16);

            Assert.Equal(VictimAppId, IndexedAppId(h, shared));
        }

        [Fact]
        public void LegacyDuplicate_RepointingAway_DoesNotClearTheWinnersMapping()
        {
            Harness h = Deploy();
            (UInt160 shared, _, UInt160 otherAdmin) = FabricateLegacyDuplicate(h);

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.RebuildIndexes(0, 16);
            Assert.Equal(VictimAppId, IndexedAppId(h, shared));

            // The losing duplicate moves to its own callback. Its record's PRIOR
            // callback is the shared one, but the index entry belongs to the winner,
            // so the owner-checked delete must leave it untouched.
            UInt160 fresh = FilledHash(0xCC);
            h.Engine.SetTransactionSigners(otherAdmin);
            h.Contract.ConfigureMiniApp(OtherAppId, otherAdmin, fresh, "ipfs://meta", "deadbeef", true);

            Assert.Equal(VictimAppId, IndexedAppId(h, shared)); // winner keeps routing
            Assert.Equal(OtherAppId, IndexedAppId(h, fresh));
        }

        [Fact]
        public void UpgradeRebuildLock_BlocksRegistration_UntilContiguousBackfillCompletes()
        {
            Harness h = Deploy();
            FabricateLegacyDuplicate(h);

            // Simulate the new _deploy(update=true) migration state: legacy app
            // records exist, callback indexes start empty, and public mutation is
            // locked until the admin has backfilled every registry index in order.
            h.Contract.Storage.Put(ScalarKey(PrefixIndexRebuildRequired), new byte[] { 1 });
            h.Contract.Storage.Remove(ScalarKey(PrefixIndexRebuildCursor));

            UInt160 attacker = TestEngine.GetNewSigner().Account;
            UInt160 fresh = FilledHash(0xCC);
            h.Engine.SetTransactionSigners(attacker);
            AssertReverts(
                () => h.Contract.RegisterMiniApp(AttackerAppId, attacker, attacker, fresh, "ipfs://evil", "beef"),
                "index rebuild required");

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.RebuildIndexes(0, 1);
            Assert.True(h.Contract.Storage.Contains(ScalarKey(PrefixIndexRebuildRequired)));

            // A retry must continue from the committed cursor instead of skipping
            // or reordering slices and falsely declaring the migration complete.
            AssertReverts(() => h.Contract.RebuildIndexes(0, 1), "unexpected rebuild start");

            h.Engine.SetTransactionSigners(h.Owner);
            h.Contract.RebuildIndexes(1, 16);
            Assert.False(h.Contract.Storage.Contains(ScalarKey(PrefixIndexRebuildRequired)));
            Assert.False(h.Contract.Storage.Contains(ScalarKey(PrefixIndexRebuildCursor)));

            h.Engine.SetTransactionSigners(attacker);
            h.Contract.RegisterMiniApp(AttackerAppId, attacker, attacker, fresh, "ipfs://meta", "deadbeef");
            Assert.Equal(AttackerAppId, IndexedAppId(h, fresh));
        }
    }
}
