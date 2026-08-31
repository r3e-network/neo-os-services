using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Native;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public delegate void FeedUpdatedHandler(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId);
    public delegate void AdminChangedHandler(UInt160 oldAdmin, UInt160 newAdmin);
    public delegate void UpdaterChangedHandler(UInt160 oldUpdater, UInt160 newUpdater);
    public delegate void VerificationKeyChangedHandler(ECPoint oldKey, ECPoint newKey);
    public delegate void AdminTimelockProposedHandler(UInt160 proposed, BigInteger executeAfter);

    /// <summary>
    /// On-chain synchronized storage for Morpheus shared numeric resources.
    /// </summary>
    /// <remarks>
    /// Price feeds remain the primary built-in use case, but the registry is intentionally generic
    /// enough for any operator-maintained numeric resource snapshots that multiple miniapps can
    /// compose over without deploying dedicated storage contracts.
    /// </remarks>
    [DisplayName("MorpheusDataFeed")]
    [ManifestExtra("Author", "Morpheus Oracle")]
    [ManifestExtra("Version", "2.0.0")]
    [ManifestExtra("Description", "Shared numeric resource registry for the Morpheus MiniApp OS")]
    public class MorpheusDataFeed : SmartContract
    {
        private const int MAX_PAIR_LENGTH = 63;
        // Versioned signing domain. Every field that can affect the stored feed
        // record is framed below, together with the exact deployment and network.
        // Keep this domain stable once this implementation is deployed.
        private static readonly byte[] FEED_SIGNATURE_DOMAIN = new byte[] { 109, 111, 114, 112, 104, 101, 117, 115, 45, 100, 97, 116, 97, 102, 101, 101, 100, 45, 118, 50 };

        // Storage-key prefixes. USED: 0x01-0x06 (contiguous). FREE: 0x07+.
        // These bytes are the FROZEN on-chain storage layout — NEVER renumber an
        // existing prefix; only APPEND with the next free byte.
        // WARNING (hex, not decimal): these are HEX literals, so the byte after 0x09
        // is 0x0A, NOT 0x10. The sister contract MorpheusOracle counted these in
        // decimal by mistake and left deceptive 0x0A-0x0F / 0x1A-0x1F gaps — keep this
        // one contiguous in true hex order to avoid the same footgun.
        private static readonly byte[] PREFIX_ADMIN = new byte[] { 0x01 };
        private static readonly byte[] PREFIX_UPDATER = new byte[] { 0x02 };
        private static readonly byte[] PREFIX_FEED = new byte[] { 0x03 };
        private static readonly byte[] PREFIX_PAIR_INDEX = new byte[] { 0x04 };
        private static readonly byte[] PREFIX_PAIR_COUNT = new byte[] { 0x05 };
        private static readonly byte[] PREFIX_VERIFICATION_KEY = new byte[] { 0x06 };
        // Governance timelock (P0-07 pattern): admin rotation.
        private static readonly byte[] PREFIX_PENDING_ADMIN = new byte[] { 0x07 };
        private static readonly byte[] PREFIX_PENDING_ADMIN_TIME = new byte[] { 0x08 };
        private const long TIMELOCK_DELAY_MS = 86_400_000; // 24 hours

        [DisplayName("FeedUpdated")]
        public static event FeedUpdatedHandler OnFeedUpdated;

        [DisplayName("AdminChanged")]
        public static event AdminChangedHandler OnAdminChanged;

        [DisplayName("AdminTimelockProposed")]
        public static event AdminTimelockProposedHandler OnAdminTimelockProposed;

        [DisplayName("UpdaterChanged")]
        public static event UpdaterChangedHandler OnUpdaterChanged;

        [DisplayName("VerificationKeyChanged")]
        public static event VerificationKeyChangedHandler OnVerificationKeyChanged;

        public struct FeedRecord
        {
            public string Pair;
            public BigInteger RoundId;
            public BigInteger Price;
            public BigInteger Timestamp;
            public ByteString AttestationHash;
            public BigInteger SourceSetId;
        }

        public static void _deploy(object data, bool update)
        {
            if (update) return;
            Transaction tx = Runtime.Transaction;
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, tx.Sender);
        }

        [Safe]
        public static UInt160 Admin() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_ADMIN);

        [Safe]
        public static UInt160 Updater() => (UInt160)Storage.Get(Storage.CurrentContext, PREFIX_UPDATER);

        /// <summary>
        /// The optional ECDSA public key used to verify off-chain price signatures.
        /// </summary>
        /// <remarks>
        /// Returns null when unset, which is the default. While unset every write is
        /// gated by the updater witness only (the original behavior). Once an admin
        /// registers a key, every updater-witness write MUST carry a signature that
        /// verifies against this key — the unsigned path (UpdateFeed/UpdateFeeds, or
        /// UpdateFeedSigned with an empty signature) is rejected — so a leaked updater
        /// witness alone can no longer anchor an arbitrary price. AdminResetFeed is the
        /// only exception (admin-gated, a higher-trust key, for feed-stall recovery).
        /// </remarks>
        [Safe]
        public static ECPoint OracleVerificationKey()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_VERIFICATION_KEY);
            return raw == null ? null : (ECPoint)(byte[])raw;
        }

        private static void ValidateAdmin()
        {
            UInt160 admin = Admin();
            ExecutionEngine.Assert(admin != null && admin.IsValid, "admin not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(admin), "unauthorized");
        }

        private static void ValidateUpdater()
        {
            UInt160 updater = Updater();
            ExecutionEngine.Assert(updater != null && updater.IsValid, "updater not set");
            ExecutionEngine.Assert(Runtime.CheckWitness(updater), "unauthorized");
        }

        /// <summary>Propose a new admin; executable after the 24h timelock (P0-07).</summary>
        public static void ProposeAdmin(UInt160 newAdmin)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(newAdmin != null && newAdmin.IsValid, "invalid admin");
            ExecutionEngine.Assert(newAdmin != Admin(), "same admin");
            BigInteger executeAfter = Runtime.Time + TIMELOCK_DELAY_MS;
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_ADMIN, newAdmin);
            Storage.Put(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME, executeAfter);
            OnAdminTimelockProposed(newAdmin, executeAfter);
        }

        /// <summary>Execute a matured admin rotation. Permissionless once proposed.</summary>
        public static void ExecuteAdminChange()
        {
            ByteString pending = Storage.Get(Storage.CurrentContext, PREFIX_PENDING_ADMIN);
            ExecutionEngine.Assert(pending != null, "no pending admin");
            BigInteger changeTime = (BigInteger)Storage.Get(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME);
            ExecutionEngine.Assert(Runtime.Time >= changeTime, "timelock active");
            UInt160 oldAdmin = Admin();
            UInt160 newAdmin = (UInt160)pending;
            Storage.Put(Storage.CurrentContext, PREFIX_ADMIN, newAdmin);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME);
            OnAdminChanged(oldAdmin, newAdmin);
        }

        /// <summary>Cancel a pending admin change. Admin only.</summary>
        public static void CancelAdminChange()
        {
            ValidateAdmin();
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN);
            Storage.Delete(Storage.CurrentContext, PREFIX_PENDING_ADMIN_TIME);
        }

        public static void SetUpdater(UInt160 updater)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(updater != null && updater.IsValid, "invalid updater");
            UInt160 oldUpdater = Updater();
            Storage.Put(Storage.CurrentContext, PREFIX_UPDATER, updater);
            OnUpdaterChanged(oldUpdater, updater);
        }

        /// <summary>
        /// Registers (or rotates) the ECDSA public key used to verify off-chain price
        /// signatures. Admin-only. Registering a key opts the feed into signature
        /// verification for any signed write; until then writes stay updater-witness
        /// only.
        /// </summary>
        public static void SetOracleVerificationKey(ECPoint publicKey)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(publicKey != null && publicKey.IsValid, "invalid verification key");
            ECPoint oldKey = OracleVerificationKey();
            Storage.Put(Storage.CurrentContext, PREFIX_VERIFICATION_KEY, (byte[])publicKey);
            OnVerificationKeyChanged(oldKey, publicKey);
        }

        /// <summary>
        /// Clears the verification key, reverting the feed to updater-witness-only
        /// writes. Admin-only escape hatch (e.g. if the off-chain signer key is lost
        /// before a replacement is provisioned).
        /// </summary>
        public static void ClearOracleVerificationKey()
        {
            ValidateAdmin();
            ECPoint oldKey = OracleVerificationKey();
            Storage.Delete(Storage.CurrentContext, PREFIX_VERIFICATION_KEY);
            OnVerificationKeyChanged(oldKey, null);
        }

        private static StorageMap FeedMap() => new StorageMap(Storage.CurrentContext, PREFIX_FEED);
        private static StorageMap PairIndexMap() => new StorageMap(Storage.CurrentContext, PREFIX_PAIR_INDEX);

        [Safe]
        public static BigInteger GetPairCount()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_PAIR_COUNT);
            return raw == null ? 0 : (BigInteger)raw;
        }

        private static void IndexPairIfNeeded(string pair)
        {
            IndexPairIfNeeded(pair, FeedMap().Get(pair));
        }

        // The caller of UpdateFeedInternal / AdminResetFeed already fetched the pair's raw
        // bytes for its own stale/overwrite checks; accept that snapshot here so the index
        // existence test does not re-Storage.Get the same key (one SLOAD saved per write).
        private static void IndexPairIfNeeded(string pair, ByteString existingRaw)
        {
            if (existingRaw != null) return;

            BigInteger count = GetPairCount();
            PairIndexMap().Put(count.ToByteArray(), pair);
            Storage.Put(Storage.CurrentContext, PREFIX_PAIR_COUNT, count + 1);
        }

        // One-byte length prefix followed by the exact VM bytes. Framing every
        // value prevents delimiter ambiguity and makes the signed attestation and
        // source-set metadata inseparable from the price tuple.
        private static ByteString EncodeSegment(ByteString value)
        {
            ByteString safe = value ?? (ByteString)"";
            ExecutionEngine.Assert(safe.Length <= 255, "feed signature segment too long");
            return Helper.Concat((ByteString)new byte[] { (byte)safe.Length }, safe);
        }

        private static byte[] NetworkMagicLe4()
        {
            BigInteger net = (BigInteger)Runtime.GetNetwork();
            return new byte[]
            {
                (byte)(net & 0xFF),
                (byte)((net / 256) & 0xFF),
                (byte)((net / 65536) & 0xFF),
                (byte)((net / 16777216) & 0xFF),
            };
        }

        /// <summary>
        /// Canonical v2 feed message. It binds the pair, price, timestamp, round,
        /// attestation hash, source set, executing contract, and network magic.
        /// The off-chain signer must reproduce these exact bytes.
        /// </summary>
        private static ByteString BuildFeedMessage(
            string pair,
            BigInteger price,
            BigInteger timestamp,
            BigInteger roundId,
            ByteString attestationHash,
            BigInteger sourceSetId)
        {
            ByteString message = (ByteString)FEED_SIGNATURE_DOMAIN;
            message = Helper.Concat(message, (ByteString)Runtime.ExecutingScriptHash);
            message = Helper.Concat(message, (ByteString)NetworkMagicLe4());
            message = Helper.Concat(message, EncodeSegment((ByteString)(pair ?? "")));
            message = Helper.Concat(message, EncodeSegment((ByteString)StdLib.Itoa(price, 10)));
            message = Helper.Concat(message, EncodeSegment((ByteString)StdLib.Itoa(timestamp, 10)));
            message = Helper.Concat(message, EncodeSegment((ByteString)StdLib.Itoa(roundId, 10)));
            message = Helper.Concat(message, EncodeSegment(attestationHash));
            message = Helper.Concat(message, EncodeSegment((ByteString)StdLib.Itoa(sourceSetId, 10)));
            return message;
        }

        /// <summary>
        /// Mandatory second factor on top of the updater witness, once a verification
        /// key is registered. Inert by default (no key => returns immediately, the
        /// write stays updater-witness only, fully backward compatible). Once an admin
        /// registers a key EVERY updater-witness write must carry a non-empty signature
        /// that verifies over the canonical v2 message (including all stored metadata,
        /// the executing contract, and network magic): an absent/empty signature is
        /// rejected, so a leaked updater witness alone can no longer anchor an
        /// arbitrary price through the unsigned path.
        /// </summary>
        private static void VerifyFeedSignature(
            string pair,
            BigInteger roundId,
            BigInteger price,
            BigInteger timestamp,
            ByteString attestationHash,
            BigInteger sourceSetId,
            ByteString signature)
        {
            ECPoint verificationKey = OracleVerificationKey();
            if (verificationKey == null) return;

            // A verification key is registered: the signature is now REQUIRED. An
            // empty/absent signature (the witness-only path) is no longer accepted —
            // this is what closes the leaked-updater-witness bypass.
            ExecutionEngine.Assert(signature != null && signature.Length > 0, "feed signature required");

            // Preserve the existing restriction for signed writes. The v2 framing is
            // already unambiguous, but accepting a new pair alphabet in the
            // key-enabled path would be an unnecessary ABI behavior change.
            ExecutionEngine.Assert(StdLib.MemorySearch((ByteString)pair, (ByteString)"|") < 0, "pair may not contain '|'");

            ByteString message = BuildFeedMessage(pair, price, timestamp, roundId, attestationHash, sourceSetId);
            ExecutionEngine.Assert(
                CryptoLib.VerifyWithECDsa(message, verificationKey, signature, NamedCurveHash.secp256r1SHA256),
                "invalid feed signature"
            );
        }

        // Shared input validation for the two write paths (UpdateFeedInternal and
        // AdminResetFeed) so the accepted-input contract cannot drift between them.
        private static void ValidateFeedInputs(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, BigInteger sourceSetId, ByteString attestationHash)
        {
            ExecutionEngine.Assert(pair != null && pair.Length > 0, "pair required");
            ExecutionEngine.Assert(pair.Length <= MAX_PAIR_LENGTH, "pair too long");
            ExecutionEngine.Assert(roundId >= 0, "invalid round");
            ExecutionEngine.Assert(price >= 0, "invalid price");
            ExecutionEngine.Assert(timestamp >= 0, "invalid timestamp");
            ExecutionEngine.Assert(sourceSetId >= 0, "invalid source set");
            ExecutionEngine.Assert(attestationHash == null || attestationHash.Length <= 32, "attestation hash too long");
        }

        // Shared record write + event emit for the two write paths. Emits the
        // coalesced record.AttestationHash (not the raw param) so the stored value
        // and the event stay identical across both callers.
        private static void WriteFeedRecord(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId)
        {
            FeedRecord record = new FeedRecord
            {
                Pair = pair,
                RoundId = roundId,
                Price = price,
                Timestamp = timestamp,
                AttestationHash = attestationHash ?? (ByteString)"",
                SourceSetId = sourceSetId
            };
            FeedMap().Put(pair, StdLib.Serialize(record));
            OnFeedUpdated(pair, roundId, price, timestamp, record.AttestationHash, sourceSetId);
        }

        private static void UpdateFeedInternal(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId, ByteString signature)
        {
            ValidateFeedInputs(pair, roundId, price, timestamp, sourceSetId, attestationHash);

            VerifyFeedSignature(pair, roundId, price, timestamp, attestationHash, sourceSetId, signature);

            ByteString existingRaw = FeedMap().Get(pair);
            if (existingRaw != null)
            {
                // Deserialize the bytes we already fetched rather than re-reading the pair
                // via GetLatest (which Storage.Get's the same key again). One SLOAD saved.
                FeedRecord existing = (FeedRecord)StdLib.Deserialize(existingRaw);
                ExecutionEngine.Assert(roundId > existing.RoundId, "stale round");
                ExecutionEngine.Assert(timestamp >= existing.Timestamp, "stale timestamp");
            }

            IndexPairIfNeeded(pair, existingRaw);

            WriteFeedRecord(pair, roundId, price, timestamp, attestationHash, sourceSetId);
        }

        [Safe]
        public static string GetPairByIndex(BigInteger index)
        {
            ExecutionEngine.Assert(index >= 0, "invalid index");
            ByteString raw = PairIndexMap().Get(index.ToByteArray());
            return raw == null ? "" : (string)raw;
        }

        [Safe]
        public static string[] GetAllPairs()
        {
            int count = (int)GetPairCount();
            string[] pairs = new string[count];
            for (int index = 0; index < count; index++)
            {
                pairs[index] = GetPairByIndex(index);
            }
            return pairs;
        }

        /// <summary>
        /// Writes or overwrites a single feed record over the unsigned (updater-witness
        /// only) path. Works while no verification key is registered; once a key is
        /// registered this path carries no signature and therefore REVERTS
        /// ("feed signature required") — publishers must switch to <see cref="UpdateFeedSigned"/>.
        /// The 6-argument ABI is preserved so the entrypoint is unchanged.
        /// </summary>
        public static void UpdateFeed(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId)
        {
            ValidateUpdater();
            UpdateFeedInternal(pair, roundId, price, timestamp, attestationHash, sourceSetId, null);
        }

        /// <summary>
        /// Writes a single feed record carrying an off-chain ECDSA signature over the
        /// canonical v2 message, including all stored fields, this deployment, and the
        /// network magic. Behaves identically to <see cref="UpdateFeed"/> while no
        /// verification key is registered; once a key is registered the signature is
        /// MANDATORY and must verify against it (an empty signature is rejected). This
        /// is the signed write path the publisher must use once a key is registered.
        /// </summary>
        public static void UpdateFeedSigned(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId, ByteString signature)
        {
            ValidateUpdater();
            UpdateFeedInternal(pair, roundId, price, timestamp, attestationHash, sourceSetId, signature);
        }

        /// <summary>
        /// Audit fix (feed-stall recovery): admin-only forced feed write that BYPASSES the
        /// roundId/timestamp monotonicity guard in UpdateFeedInternal. That guard rejects
        /// stale/replayed updates, but a single bad publish (a far-future timestamp or an
        /// oversized roundId) would otherwise permanently reject every subsequent legitimate
        /// update and stall the feed. This admin-gated escape hatch resets a stalled feed to a
        /// sane round/timestamp. It is restricted to the admin so producers cannot abuse it to
        /// rewind/replay prices.
        /// </summary>
        public static void AdminResetFeed(string pair, BigInteger roundId, BigInteger price, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId)
        {
            ValidateAdmin();
            ValidateFeedInputs(pair, roundId, price, timestamp, sourceSetId, attestationHash);

            IndexPairIfNeeded(pair);
            WriteFeedRecord(pair, roundId, price, timestamp, attestationHash, sourceSetId);
        }

        /// <summary>
        /// Generic alias for shared numeric resources.
        /// </summary>
        public static void UpdateResource(string resourceId, BigInteger version, BigInteger value, BigInteger timestamp, ByteString attestationHash, BigInteger sourceSetId)
        {
            UpdateFeed(resourceId, version, value, timestamp, attestationHash, sourceSetId);
        }

        /// <summary>
        /// Batch writes multiple feed records in one transaction.
        /// </summary>
        public static void UpdateFeeds(string[] pairs, BigInteger[] roundIds, BigInteger[] prices, BigInteger[] timestamps, ByteString[] attestationHashes, BigInteger[] sourceSetIds)
        {
            ValidateUpdater();
            ExecutionEngine.Assert(pairs != null && pairs.Length > 0, "pairs required");
            ExecutionEngine.Assert(roundIds != null && roundIds.Length == pairs.Length, "roundIds length mismatch");
            ExecutionEngine.Assert(prices != null && prices.Length == pairs.Length, "prices length mismatch");
            ExecutionEngine.Assert(timestamps != null && timestamps.Length == pairs.Length, "timestamps length mismatch");
            ExecutionEngine.Assert(attestationHashes != null && attestationHashes.Length == pairs.Length, "attestationHashes length mismatch");
            ExecutionEngine.Assert(sourceSetIds != null && sourceSetIds.Length == pairs.Length, "sourceSetIds length mismatch");

            for (int index = 0; index < pairs.Length; index++)
            {
                UpdateFeedInternal(
                    pairs[index],
                    roundIds[index],
                    prices[index],
                    timestamps[index],
                    attestationHashes[index],
                    sourceSetIds[index],
                    null
                );
            }
        }

        /// <summary>
        /// Generic batch alias for shared numeric resources.
        /// </summary>
        public static void UpdateResources(string[] resourceIds, BigInteger[] versions, BigInteger[] values, BigInteger[] timestamps, ByteString[] attestationHashes, BigInteger[] sourceSetIds)
        {
            UpdateFeeds(resourceIds, versions, values, timestamps, attestationHashes, sourceSetIds);
        }

        [Safe]
        public static FeedRecord GetLatest(string pair)
        {
            if (pair == null || pair.Length > MAX_PAIR_LENGTH)
            {
                return new FeedRecord { Pair = pair ?? "", RoundId = 0, Price = 0, Timestamp = 0, AttestationHash = (ByteString)"", SourceSetId = 0 };
            }

            ByteString raw = FeedMap().Get(pair);
            if (raw == null)
            {
                return new FeedRecord { Pair = pair, RoundId = 0, Price = 0, Timestamp = 0, AttestationHash = (ByteString)"", SourceSetId = 0 };
            }
            return (FeedRecord)StdLib.Deserialize(raw);
        }

        [Safe]
        public static FeedRecord GetResource(string resourceId)
        {
            return GetLatest(resourceId);
        }

        [Safe]
        public static FeedRecord[] GetAllFeedRecords()
        {
            string[] pairs = GetAllPairs();
            FeedRecord[] records = new FeedRecord[pairs.Length];
            for (int index = 0; index < pairs.Length; index++)
            {
                records[index] = GetLatest(pairs[index]);
            }
            return records;
        }

        [Safe]
        public static FeedRecord[] GetAllResources()
        {
            return GetAllFeedRecords();
        }

        public static void Update(ByteString nefFile, string manifest)
        {
            ValidateAdmin();
            ContractManagement.Update(nefFile, manifest, null);
        }
    }
}
