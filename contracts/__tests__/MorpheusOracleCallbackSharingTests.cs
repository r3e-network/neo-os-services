using System;
using System.Collections.Generic;
using System.Numerics;
using System.Text;
using Neo;
using Neo.SmartContract.Testing;
using Neo.VM.Types;
using Neo.Wallets;
using Xunit;
using Kernel = Neo.SmartContract.Testing.MorpheusOracle;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// VM-level coverage for SAME-OPERATOR multi-tenant callback sharing — the
    /// neo-miniapps-platform case: MANY appIds settle through ONE PlatformGame
    /// callback contract, so a strict one-callback-one-appId uniqueness rule blocks
    /// legitimate tenant onboarding.
    ///
    /// Rules pinned here (OR-D-03 relaxed, anti-hijack preserved):
    ///   1. Two appIds with the SAME admin may register the SAME callback contract;
    ///      both records exist, and the reverse index keeps mapping to the FIRST
    ///      appId (first-wins, mirroring RebuildIndexes). Per-tenant routing is
    ///      unaffected because the rich 8-arg onMiniAppResult dispatch passes appId
    ///      per request record.
    ///   2. Two appIds with DIFFERENT admins still fault with
    ///      "callback already registered" — an operator cannot repoint another
    ///      operator's legacy request routing.
    ///   3. The SAME app reconfiguring its own (shared) callback stays allowed.
    ///
    /// The deployed contract is the generated artifact under Generated/ (produced
    /// by `nccs MorpheusOracle.csproj --generate-artifacts Source`). Regenerate it
    /// when the contract changes.
    /// </summary>
    public class MorpheusOracleCallbackSharingTests
    {
        private const byte PrefixCallbackIndex = 0x27; // PREFIX_CALLBACK_INDEX

        private const string FirstAppId = "tenant.one";
        private const string SecondAppId = "tenant.two";

        private sealed record Harness(TestEngine Engine, Kernel Contract, UInt160 Owner);

        private static Harness Deploy()
        {
            // Same bootstrap as MorpheusOracleCallbackIndexTests: a 1-key committee
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

        private static byte[] CallbackIndexKey(UInt160 callback)
        {
            byte[] suffix = callback.GetSpan().ToArray();
            byte[] key = new byte[suffix.Length + 1];
            key[0] = PrefixCallbackIndex;
            System.Buffer.BlockCopy(suffix, 0, key, 1, suffix.Length);
            return key;
        }

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

        // GetMiniApp returns the raw VM Struct fields in declaration order:
        // AppId, Admin, FeePayer, CallbackContract, MetadataUri, MetadataHash,
        // Active, CreatedAt, UpdatedAt.
        private static string Str(object item) =>
            Encoding.UTF8.GetString(((ByteString)item).GetSpan());

        private static UInt160 Hash(object item) =>
            new UInt160(((ByteString)item).GetSpan());

        [Fact]
        public void Register_SameOperatorSharedCallback_BothAppsCoexist_IndexKeepsFirstApp()
        {
            Harness h = Deploy();
            UInt160 shared = FilledHash(0xAA);
            UInt160 platformAdmin = TestEngine.GetNewSigner().Account;

            // One operator onboards two tenants through the SAME PlatformGame
            // callback contract. Pre-relaxation the second register FAULTed.
            Register(h, FirstAppId, platformAdmin, shared);
            Register(h, SecondAppId, platformAdmin, shared);

            // First-wins: the legacy routing lane still resolves to the FIRST app.
            Assert.Equal(FirstAppId, IndexedAppId(h, shared));

            // Both tenant records are stored and readable with their own appIds.
            IList<object> first = h.Contract.GetMiniApp(FirstAppId)!;
            Assert.Equal(FirstAppId, Str(first[0]));
            Assert.Equal(platformAdmin, Hash(first[1]));
            Assert.Equal(shared, Hash(first[3]));
            Assert.True((BigInteger)first[7] > 0, "first record persisted");

            IList<object> second = h.Contract.GetMiniApp(SecondAppId)!;
            Assert.Equal(SecondAppId, Str(second[0]));
            Assert.Equal(platformAdmin, Hash(second[1]));
            Assert.Equal(shared, Hash(second[3]));
            Assert.True((BigInteger)second[7] > 0, "second record persisted");
        }

        [Fact]
        public void Register_DifferentOperatorSharedCallback_Faults_AndMappingSurvives()
        {
            Harness h = Deploy();
            UInt160 shared = FilledHash(0xAA);
            UInt160 platformAdmin = TestEngine.GetNewSigner().Account;
            UInt160 otherAdmin = TestEngine.GetNewSigner().Account;

            Register(h, FirstAppId, platformAdmin, shared);

            // A DIFFERENT operator naming the same callback is still a hijack
            // attempt: the assert must keep faulting, and nothing may change.
            AssertReverts(
                () => Register(h, SecondAppId, otherAdmin, shared),
                "callback already registered");

            Assert.Equal(FirstAppId, IndexedAppId(h, shared));
            IList<object> second = h.Contract.GetMiniApp(SecondAppId)!;
            Assert.True((BigInteger)second[7] == 0, "hijack app never created");
        }

        [Fact]
        public void Configure_SameAppKeepingSharedCallback_StaysAllowed_IndexUnmoved()
        {
            Harness h = Deploy();
            UInt160 shared = FilledHash(0xAA);
            UInt160 platformAdmin = TestEngine.GetNewSigner().Account;

            Register(h, FirstAppId, platformAdmin, shared);
            Register(h, SecondAppId, platformAdmin, shared);

            // Owner update on the SECOND tenant: same appId re-writing its own
            // (shared) callback must not trip the uniqueness check nor steal the
            // first app's index mapping.
            h.Engine.SetTransactionSigners(platformAdmin);
            h.Contract.ConfigureMiniApp(SecondAppId, platformAdmin, shared, "ipfs://meta-v2", "cafebabe", true);

            Assert.Equal(FirstAppId, IndexedAppId(h, shared));
            IList<object> second = h.Contract.GetMiniApp(SecondAppId)!;
            Assert.Equal("ipfs://meta-v2", Str(second[4]));
            Assert.Equal(shared, Hash(second[3]));
        }
    }
}
