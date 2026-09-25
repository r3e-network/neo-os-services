using System;
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
    public partial class MorpheusOracle : SmartContract
    {
        private static BigInteger SubmitMiniAppRequestInternal(UInt160 requester, string appId, string moduleId, string operation, ByteString payload)
        {
            // ValidateRequestInputs returns the active MiniAppRecord it already read, so
            // we reuse it here instead of reading + deserializing the record a second time
            // (no AppMap write happens between the two, so the re-read was pure overhead).
            MiniAppRecord app = ValidateRequestInputs(appId, moduleId, operation, payload);

            UInt160 sponsor = ResolveFeePayer(appId, requester, app.FeePayer);
            BigInteger feePaid = ConsumeRequestFeeFromPayer(sponsor);

            // When the fee payer actually covered this request (i.e. the sponsor differs from the
            // requester), record the spend against any configured per-requester cap so a capped
            // requester can only ever be sponsored up to its budget.
            if (feePaid > 0 && sponsor != requester)
            {
                RecordSponsoredSpend(appId, requester, feePaid);
            }

            BigInteger requestId = NextRequestId();
            KernelRequest req = new KernelRequest
            {
                Id = requestId,
                AppId = appId,
                ModuleId = moduleId,
                Operation = operation,
                Payload = payload ?? (ByteString)"",
                Requester = requester,
                Sponsor = sponsor,
                CallbackContract = app.CallbackContract,
                Status = KernelRequestStatus.Pending,
                CreatedAt = Runtime.Time,
                FulfilledAt = 0,
                Success = false,
                Result = (ByteString)"",
                Error = "",
                FeePaid = feePaid
            };

            RequestMap().Put(requestId.ToByteArray(), StdLib.Serialize(req));
            IncrementTotalRequests();
            IncrementMiniAppRequests(appId);
            ByteString payloadHash = CryptoLib.Sha256(req.Payload);
            OnMiniAppRequestQueued(requestId, appId, moduleId, operation, requester, sponsor, req.Payload, payloadHash);
            return requestId;
        }

        private static UInt160 ResolveFeePayer(string appId, UInt160 requester, UInt160 sponsor)
        {
            BigInteger fee = SystemRequestFee();
            if (fee <= 0) return requester;

            if (sponsor != null
                && sponsor.IsValid
                && sponsor != requester
                && FeeCreditOf(sponsor) >= fee
                && IsRequesterSponsorable(appId, requester, fee))
            {
                return sponsor;
            }

            return requester;
        }

        // Decides whether the app fee payer is willing to cover this requester's fee.
        //
        // An app whose admin explicitly opted into sponsor-everyone (SetSponsorshipOpen) covers
        // every requester. A gated app covers a requester only when it is allowlisted, or when a
        // per-requester spend cap is configured and crediting this fee keeps the requester at or
        // below it.
        //
        // SVC-E-8: an app whose admin has configured NOTHING used to be covered by the first
        // branch and so sponsored everyone without limit — any account on the network could drain
        // a funded app's credit one request at a time. It is still sponsored, because a deployed
        // app's real users hold no credit of their own and would otherwise all fail with
        // "request fee not paid", but only up to DefaultSponsoredRequesterCap() per requester.
        // The bound reuses the same spend ledger as an explicit cap, including its expiry-side
        // ReleaseSponsoredSpend reversal.
        private static bool IsRequesterSponsorable(string appId, UInt160 requester, BigInteger fee)
        {
            BigInteger mode = SponsorshipMode(appId);
            if (mode == SPONSOR_MODE_OPEN) return true;

            byte[] key = BuildRequesterKey(appId, requester);
            if (SponsorAllowedMap().Get(key) != null) return true;

            BigInteger cap;
            ByteString rawCap = SponsorCapMap().Get(key);
            if (rawCap != null)
            {
                cap = (BigInteger)rawCap;
            }
            else
            {
                // A gated app with no explicit entry for this requester sponsors nothing
                // (unchanged); an unconfigured one falls back to the bounded default.
                if (mode == SPONSOR_MODE_GATED) return false;
                cap = DefaultSponsoredRequesterCap();
            }
            if (cap <= 0) return false;

            ByteString rawSpent = SponsorSpentMap().Get(key);
            BigInteger spent = rawSpent == null ? 0 : (BigInteger)rawSpent;
            return spent + fee <= cap;
        }

        private static UInt160 ResolveCreditBeneficiary(UInt160 from, object data)
        {
            if (data is ByteString byteString && byteString != null && byteString.Length == 20)
            {
                UInt160 beneficiary = (UInt160)(byte[])byteString;
                ExecutionEngine.Assert(beneficiary.IsValid && beneficiary != UInt160.Zero, "invalid beneficiary");

                // Reject arbitrary 20-byte beneficiary injection.  Crediting an
                // attacker-chosen account is dangerous because any account with
                // fee credit can be auto-charged as a sponsor (see ResolveFeePayer).
                // A directed beneficiary is only honoured when it is sane:
                //   1. it is the depositor itself, or
                //   2. the beneficiary also witnesses this transaction, or
                //   3. it is a registered miniapp account (admin or fee-payer),
                //      i.e. a known sponsor rather than an arbitrary address.
                // This mirrors the contract's account validation elsewhere
                // (CheckWitness / registered-account checks).
                bool authorized = beneficiary == from
                    || Runtime.CheckWitness(beneficiary)
                    || IsRegisteredMiniAppAccount(beneficiary);
                ExecutionEngine.Assert(authorized, "beneficiary not authorized");

                return beneficiary;
            }

            return from;
        }

        // True when the account is (or was) a registered miniapp admin or fee-payer.
        // Used to allow directed fee-credit deposits to known sponsors while rejecting arbitrary
        // 20-byte beneficiary injection on NEP-17 payments. O(1) membership lookup (was an O(n)
        // registry scan -> per-deposit DoS). Membership is monotonic: a former sponsor remains
        // depositable, which only ever permits crediting real, previously-vetted addresses.
        private static bool IsRegisteredMiniAppAccount(UInt160 account)
        {
            if (account == null || !account.IsValid || account == UInt160.Zero)
            {
                return false;
            }
            return AccountRegisteredMap().Get((byte[])account) != null;
        }

        /// <summary>
        /// One-time post-upgrade backfill of the callback and account-membership reverse indexes
        /// from existing miniapp records. Required after a ContractManagement.Update that
        /// introduces these indexes, because storage persists but the new index prefixes start
        /// empty — without backfill, existing integration contracts could not resolve their app
        /// and existing sponsors could not receive directed deposits. Process a bounded
        /// [startIndex, startIndex+count) slice per call to stay within gas limits on large
        /// registries; both writes are idempotent so re-running a slice is harmless. When
        /// legacy records share a callback contract, the earliest-registered app keeps the
        /// mapping (first-wins, mirroring the pre-index O(n) resolver's semantics).
        /// </summary>
        public static void RebuildIndexes(BigInteger startIndex, BigInteger count)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(startIndex >= 0 && count > 0, "invalid range");

            bool migrationActive = IsIndexRebuildRequired();
            if (migrationActive)
            {
                ExecutionEngine.Assert(startIndex == IndexRebuildCursor(), "unexpected rebuild start");
            }

            BigInteger total = GetMiniAppCount();
            BigInteger end = startIndex + count;
            if (end > total) end = total;

            for (BigInteger i = startIndex; i < end; i++)
            {
                string appId = GetMiniAppIdByIndex(i);
                MiniAppRecord app = GetMiniApp(appId);
                if (app.CreatedAt == 0) continue;
                if (app.CallbackContract != null && app.CallbackContract.IsValid)
                {
                    ByteString indexedAppId = CallbackIndexMap().Get((byte[])app.CallbackContract);
                    if (indexedAppId == null)
                    {
                        // Registry order is the canonical first-wins order. For an empty
                        // reverse index the sequential cursor guarantees this is the first
                        // occurrence, so no registry-wide scan is needed.
                        CallbackIndexMap().Put((byte[])app.CallbackContract, appId);
                    }
                    else if ((string)indexedAppId != appId)
                    {
                        // Only pay the legacy O(n) repair cost when an existing mapping
                        // conflicts. This keeps the common unique-callback backfill O(n)
                        // while still repairing a poisoned later mapping from an older
                        // upgrade window.
                        string canonicalAppId = FindEarliestMiniAppIdByCallback(app.CallbackContract);
                        if (canonicalAppId != null && canonicalAppId.Length > 0)
                        {
                            CallbackIndexMap().Put((byte[])app.CallbackContract, canonicalAppId);
                        }
                    }
                }
                MarkAccountRegistered(app.Admin);
                MarkAccountRegistered(app.FeePayer);
            }

            if (migrationActive)
            {
                if (end >= total)
                {
                    Storage.Delete(Storage.CurrentContext, PREFIX_INDEX_REBUILD_REQUIRED);
                    Storage.Delete(Storage.CurrentContext, PREFIX_INDEX_REBUILD_CURSOR);
                }
                else
                {
                    Storage.Put(Storage.CurrentContext, PREFIX_INDEX_REBUILD_CURSOR, end);
                }
            }
        }

        // Returns the exact fee debited from the payer so the caller can record
        // it on the request for a symmetric refund if the request later expires.
        private static BigInteger ConsumeRequestFeeFromPayer(UInt160 feePayer)
        {
            ExecutionEngine.Assert(feePayer != null && feePayer.IsValid, "fee payer required");

            BigInteger fee = SystemRequestFee();
            if (fee <= 0) return 0;

            BigInteger credit = FeeCreditOf(feePayer);
            ExecutionEngine.Assert(credit >= fee, "request fee not paid");
            RequestCreditMap().Put((byte[])feePayer, credit - fee);
            Storage.Put(Storage.CurrentContext, PREFIX_ACCRUED_REQUEST_FEES, AccruedRequestFees() + fee);
            // The request is now pending and its fee is refundable on expiry, so reserve the fee
            // against withdrawal until it is fulfilled (earned) or expired (refunded).
            ReserveRequestFee(fee);
            return fee;
        }
    }
}
