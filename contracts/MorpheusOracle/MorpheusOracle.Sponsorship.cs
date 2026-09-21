using System.ComponentModel;
using System.Numerics;
using Neo;
using Neo.SmartContract.Framework;
using Neo.SmartContract.Framework.Attributes;
using Neo.SmartContract.Framework.Services;

namespace MorpheusOracle.Contracts
{
    public delegate void SponsorshipModeChangedHandler(string appId, BigInteger mode);
    public delegate void DefaultSponsoredRequesterCapUpdatedHandler(BigInteger oldCap, BigInteger newCap);

    /// <summary>
    /// Sponsorship posture for MiniApp request fees (SVC-E-8).
    /// </summary>
    /// <remarks>
    /// The per-(appId, requester) allowlist and spend cap only bind once the app admin
    /// has configured at least one of them. Until then the app's FeePayer covered every
    /// requester without limit, which made an unconfigured but funded app drainable by
    /// any witnessed account on the network, one DEFAULT_REQUEST_FEE at a time — a
    /// default-open posture on a fund-bearing control.
    ///
    /// The posture is now a tri-state stored in the same SPONSOR_GATED slot, so the
    /// existing allowlist / cap / spend machinery is reused unchanged:
    ///
    ///   absent (0)  unconfigured — sponsored, but only up to
    ///               DefaultSponsoredRequesterCap() per requester per app.
    ///   1           gated — the app admin configured a control, so only allowlisted or
    ///               under-explicit-cap requesters are sponsored (unchanged).
    ///   2           open — the app admin explicitly opted back into sponsor-everyone.
    ///
    /// Inverting the default to "sponsor nobody" was rejected as the primary fix: with
    /// no credit of their own, every user of a deployed sponsored app would immediately
    /// hit "request fee not paid". A bounded default keeps real users working while
    /// capping what one attacker account can move out of the app's credit, and the
    /// bound is operator-tunable (0 = fully closed, which IS the inverted default) so
    /// the posture can be changed without a contract upgrade.
    /// </remarks>
    public partial class MorpheusOracle : SmartContract
    {
        // Per-app sponsorship posture marker values stored under PREFIX_SPONSOR_GATED.
        private const int SPONSOR_MODE_UNCONFIGURED = 0;
        private const int SPONSOR_MODE_GATED = 1;
        private const int SPONSOR_MODE_OPEN = 2;

        // System-wide ceiling on what an UNCONFIGURED app's fee payer will sponsor for a
        // single requester, in GAS fractions. 100_000_000 == 1 GAS == 100 requests at the
        // DEFAULT_REQUEST_FEE of 1_000_000. Tunable by the platform admin below.
        private const long DEFAULT_SPONSORED_REQUESTER_CAP = 100_000_000;

        private static readonly byte[] PREFIX_SPONSOR_DEFAULT_CAP = new byte[] { 0x35 };

        [DisplayName("SponsorshipModeChanged")]
        public static event SponsorshipModeChangedHandler OnSponsorshipModeChanged;

        // Neo N3 caps an event name at 32 bytes, so this is not the method name verbatim.
        [DisplayName("SponsorDefaultCapUpdated")]
        public static event DefaultSponsoredRequesterCapUpdatedHandler OnDefaultSponsoredRequesterCapUpdated;

        // 0 when the app admin has never configured a posture.
        private static BigInteger SponsorshipMode(string appId)
        {
            ByteString raw = SponsorGatedMap().Get(appId);
            return raw == null ? SPONSOR_MODE_UNCONFIGURED : (BigInteger)raw;
        }

        /// <summary>
        /// The per-(app, requester) sponsorship ceiling applied to apps whose admin has
        /// not configured any sponsorship control. 0 means an unconfigured app sponsors
        /// nobody (every requester self-pays).
        /// </summary>
        [Safe]
        public static BigInteger DefaultSponsoredRequesterCap()
        {
            ByteString raw = Storage.Get(Storage.CurrentContext, PREFIX_SPONSOR_DEFAULT_CAP);
            return raw == null ? DEFAULT_SPONSORED_REQUESTER_CAP : (BigInteger)raw;
        }

        /// <summary>
        /// Retune the ceiling applied to unconfigured apps. Platform admin only.
        /// Setting 0 closes open sponsorship entirely; a large value restores the
        /// original unbounded-in-practice behavior for every unconfigured app.
        /// </summary>
        public static void SetDefaultSponsoredRequesterCap(BigInteger cap)
        {
            ValidateAdmin();
            ExecutionEngine.Assert(cap >= 0, "invalid cap");
            BigInteger oldCap = DefaultSponsoredRequesterCap();
            Storage.Put(Storage.CurrentContext, PREFIX_SPONSOR_DEFAULT_CAP, cap);
            OnDefaultSponsoredRequesterCapUpdated(oldCap, cap);
        }

        /// <summary>
        /// True when the app admin has explicitly opted the app back into sponsoring
        /// every requester without limit.
        /// </summary>
        [Safe]
        public static bool IsSponsorshipOpen(string appId)
        {
            ValidateIdentifier(appId, MAX_APP_ID_LENGTH, "invalid app id");
            return SponsorshipMode(appId) == SPONSOR_MODE_OPEN;
        }

        /// <summary>
        /// Declare the app's sponsorship posture explicitly. <c>open == true</c> opts into
        /// sponsoring every requester without limit — the pre-SVC-E-8 behavior, now an
        /// explicit and separately auditable choice rather than the silent default.
        /// <c>open == false</c> gates the app, so only allowlisted or under-cap requesters
        /// draw on the fee payer's credit. Gated by the app admin (or the system admin).
        ///
        /// Note the pre-existing interaction: setting an allowlist entry or a non-zero cap calls
        /// EnableSponsorshipGating, which writes the gated marker — so configuring any control on
        /// an explicitly-open app moves it back to gated. That is the intended reading of
        /// "the admin configured a control", but it means `open` is not sticky against the other
        /// two setters.
        /// </summary>
        public static void SetSponsorshipOpen(string appId, bool open)
        {
            MiniAppRecord app = RequireMiniApp(appId);
            ValidateMiniAppAdmin(app);

            BigInteger mode = open ? SPONSOR_MODE_OPEN : SPONSOR_MODE_GATED;
            SponsorGatedMap().Put(appId, mode);
            OnSponsorshipModeChanged(appId, mode);
        }
    }
}
