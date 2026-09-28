using System;
using System.Collections.Generic;
using System.ComponentModel;
using System.Numerics;
using System.Reflection;
using Neo;
using Neo.Network.P2P.Payloads;
using Neo.SmartContract;
using Neo.SmartContract.Manifest;
using Neo.SmartContract.Testing;
using Neo.VM;
using Neo.Wallets;
using Xunit;
using Kernel = Neo.SmartContract.Testing.MorpheusOracle;

namespace MorpheusOracle.Contracts.Tests
{
    /// <summary>
    /// A real intermediate contract for entry -> contract -> kernel tests. Its one method,
    /// <c>call(target, method, args)</c>, forwards to <c>System.Contract.Call</c>, so the
    /// kernel sees the hop as <c>Runtime.CallingScriptHash</c> and evaluates
    /// <c>Runtime.CheckWitness</c> two frames below the entry script — exactly the
    /// on-chain shape of a MiniApp integration contract calling the kernel. (A test that
    /// only overrides CallingScriptHash while calling the kernel from the entry script
    /// lets a CalledByEntry signature pass; on chain it would not.)
    /// </summary>
    public abstract class IntegrationHop(SmartContractInitialize initialize)
        : Neo.SmartContract.Testing.SmartContract(initialize)
    {
        [DisplayName("call")]
        public abstract BigInteger? Call(UInt160? target, string? method, object[]? args);
    }

    /// <summary>
    /// Shared VM harness for the kernel fee-consent tests: a fresh engine with mintable
    /// genesis GAS, the compiled kernel from Generated/, and helpers for credit, apps,
    /// signer scopes, time and request fields.
    /// </summary>
    internal sealed class KernelFeeHarness
    {
        public const string OracleModule = "oracle.fetch";      // seeded active at deploy
        public const string AutomationModule = "automation.run"; // seeded active at deploy
        public const long Fee = 1_000_000;                       // DEFAULT_REQUEST_FEE

        // KernelRequest field indices in the struct returned by GetRequest.
        private const int RequesterIndex = 5;
        private const int SponsorIndex = 6;
        private const int StatusIndex = 8;
        private const int FeePaidIndex = 14;

        // AutomationSpendApproval field indices.
        private const int ApprovalRequesterIndex = 1;
        private const int ApprovalCapIndex = 3;
        private const int ApprovalSpentIndex = 4;
        private const int ApprovalExpiresAtIndex = 5;

        private KernelFeeHarness(TestEngine engine, Kernel kernel, UInt160 owner)
        {
            Engine = engine;
            Kernel = kernel;
            Owner = owner;
        }

        public TestEngine Engine { get; }
        public Kernel Kernel { get; }
        public UInt160 Owner { get; }

        public static KernelFeeHarness Deploy()
        {
            // ProtocolSettings.Default has no standby committee, so the genesis GAS supply
            // is not mintable; seed a 1-key committee whose account (engine.Sender) holds it.
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
            Kernel kernel = engine.Deploy<Kernel>(Kernel.Nef, Kernel.Manifest, null);
            Assert.Equal(owner, kernel.Admin);
            return new KernelFeeHarness(engine, kernel, owner);
        }

        public static UInt160 NewAccount() => TestEngine.GetNewSigner().Account;

        /// <summary>Deploys the entry -> hop -> kernel intermediate contract.</summary>
        public IntegrationHop DeployHop(string name = "IntegrationHop")
        {
            using ScriptBuilder sb = new();
            sb.Emit(OpCode.INITSLOT, new byte[] { 0, 3 }); // 0 locals, 3 args
            sb.Emit(OpCode.LDARG2);                        // args array
            sb.EmitPush((int)CallFlags.All);
            sb.Emit(OpCode.LDARG1);                        // method
            sb.Emit(OpCode.LDARG0);                        // target
            sb.EmitSysCall(ApplicationEngine.System_Contract_Call);
            sb.Emit(OpCode.RET);

            NefFile nef = new()
            {
                Compiler = "morpheus-oracle-tests",
                Source = string.Empty,
                Tokens = Array.Empty<MethodToken>(),
                Script = sb.ToArray(),
            };
            nef.CheckSum = NefFile.ComputeChecksum(nef);

            ContractManifest manifest = ContractManifest.Parse(
                "{\"name\":\"" + name + "\",\"groups\":[],\"features\":{},\"supportedstandards\":[]," +
                "\"abi\":{\"methods\":[{\"name\":\"call\",\"parameters\":[" +
                "{\"name\":\"target\",\"type\":\"Hash160\"},{\"name\":\"method\",\"type\":\"String\"}," +
                "{\"name\":\"args\",\"type\":\"Array\"}],\"returntype\":\"Any\",\"offset\":0,\"safe\":false}]," +
                "\"events\":[]},\"permissions\":[{\"contract\":\"*\",\"methods\":\"*\"}],\"trusts\":[],\"extra\":null}");

            Engine.SetTransactionSigners(Owner);
            return Engine.Deploy<IntegrationHop>(nef, manifest, null);
        }

        /// <summary>
        /// Deposits exactly <paramref name="amount"/> of fee credit for the account, funding it
        /// from genesis GAS first. Leaves the account as the transaction signer.
        /// </summary>
        public void FundCredit(UInt160 account, BigInteger amount)
        {
            BigInteger before = Kernel.FeeCreditOf(account)!.Value;
            Engine.SetTransactionSigners(Owner);
            Assert.True(Engine.Native.GAS.Transfer(Owner, account, amount + 1_000 * 100_000_000L, null) == true);
            Engine.SetTransactionSigners(account);
            Assert.True(Engine.Native.GAS.Transfer(account, Kernel.Hash, amount, null) == true);
            Assert.Equal(before + amount, Kernel.FeeCreditOf(account)!.Value);
        }

        public BigInteger CreditOf(UInt160 account) => Kernel.FeeCreditOf(account)!.Value;

        /// <summary>
        /// Registers an app and grants the modules, signed by its admin (and by its fee payer
        /// when that is a different account, as ValidateFeePayerAuthorization requires).
        /// </summary>
        public void RegisterApp(string appId, UInt160 admin, UInt160 feePayer, UInt160? callback, params string[] modules)
        {
            if (feePayer == admin || feePayer == UInt160.Zero)
                Engine.SetTransactionSigners(admin);
            else
                Engine.SetTransactionSigners(admin, feePayer);
            Kernel.RegisterMiniApp(appId, admin, feePayer, callback, "ipfs://meta", "deadbeef");
            foreach (string module in modules)
            {
                Kernel.GrantModuleToMiniApp(appId, module);
            }
        }

        /// <summary>The platform owner takes the updater role (the relayer's key on chain).</summary>
        public void OwnerIsUpdater()
        {
            Engine.SetTransactionSigners(Owner);
            Kernel.SetUpdater(Owner);
        }

        public void Sign(params Signer[] signers) => Engine.SetTransactionSigners(signers);

        public static Signer Scoped(UInt160 account, WitnessScope scope, params UInt160[] allowedContracts) =>
            new()
            {
                Account = account,
                Scopes = scope,
                AllowedContracts = scope.HasFlag(WitnessScope.CustomContracts) ? allowedContracts : Array.Empty<UInt160>(),
                AllowedGroups = Array.Empty<Neo.Cryptography.ECC.ECPoint>(),
                Rules = Array.Empty<Neo.Network.P2P.Payloads.WitnessRule>(),
            };

        public UInt160 RequesterOf(BigInteger id) => AsUInt160(Kernel.GetRequest(id)![RequesterIndex]);
        public UInt160 SponsorOf(BigInteger id) => AsUInt160(Kernel.GetRequest(id)![SponsorIndex]);
        public BigInteger StatusOf(BigInteger id) => AsInteger(Kernel.GetRequest(id)![StatusIndex]);
        public BigInteger FeePaidOf(BigInteger id) => AsInteger(Kernel.GetRequest(id)![FeePaidIndex]);

        public bool HasApproval(BigInteger registrationId)
        {
            object requester = Kernel.GetAutomationSpendApproval(registrationId)![ApprovalRequesterIndex];
            return requester is not null && requester is not Neo.VM.Types.Null;
        }

        public BigInteger ApprovalCap(BigInteger registrationId) =>
            AsInteger(Kernel.GetAutomationSpendApproval(registrationId)![ApprovalCapIndex]);
        public BigInteger ApprovalSpent(BigInteger registrationId) =>
            AsInteger(Kernel.GetAutomationSpendApproval(registrationId)![ApprovalSpentIndex]);
        public BigInteger ApprovalExpiresAt(BigInteger registrationId) =>
            AsInteger(Kernel.GetAutomationSpendApproval(registrationId)![ApprovalExpiresAtIndex]);

        public ulong NowMs => (ulong)Engine.PersistingBlock.Timestamp.TotalMilliseconds;

        // PersistingBlock.Timestamp is read-only; Runtime.Time moves with the block header.
        public void AdvanceMs(ulong deltaMs)
        {
            object persistingBlock = Engine.PersistingBlock;
            Block block = (Block)persistingBlock.GetType()
                .GetField("UnderlyingBlock", BindingFlags.NonPublic | BindingFlags.Instance)!
                .GetValue(persistingBlock)!;
            block.Header.Timestamp = NowMs + deltaMs;
        }

        public void AdvancePastTtl() => AdvanceMs((ulong)Kernel.RequestTTL!.Value + 1_000);

        public static void AssertReverts(Action action, string reasonFragment)
        {
            Exception ex = Assert.ThrowsAny<Exception>(action);
            Assert.Contains(reasonFragment, ex.ToString());
        }

        public static UInt160 AsUInt160(object value) => value switch
        {
            UInt160 u => u,
            byte[] b => new UInt160(b),
            Neo.VM.Types.ByteString bs => new UInt160(bs.GetSpan().ToArray()),
            Neo.VM.Types.Buffer buf => new UInt160(buf.GetSpan().ToArray()),
            _ => throw new InvalidCastException($"cannot convert {value?.GetType()} to UInt160"),
        };

        public static BigInteger AsInteger(object value) => value switch
        {
            BigInteger i => i,
            Neo.VM.Types.Integer vi => vi.GetInteger(),
            Neo.VM.Types.Boolean vb => vb.GetBoolean() ? BigInteger.One : BigInteger.Zero,
            Neo.VM.Types.ByteString bs => new BigInteger(bs.GetSpan()),
            _ => throw new InvalidCastException($"cannot convert {value?.GetType()} to BigInteger"),
        };
    }
}
