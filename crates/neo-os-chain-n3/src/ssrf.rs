//! SSRF guard for operator-configured RPC / indexer / custody URLs
//! (architecture §5.5; the relayer-side sibling of the worker's
//! `platform/ssrf.js`).
//!
//! Policy (fail-closed):
//! * only `http` / `https` schemes;
//! * the host is classified BEFORE any request: IP literals directly, names
//!   via an INJECTED resolver (`cargo test` never touches DNS);
//! * rejected: unspecified, loopback, private (RFC1918), link-local,
//!   CGNAT (100.64/10), ULA (fc00::/7), multicast, reserved/documentation;
//! * IPv4 hidden inside IPv6 transition forms (IPv4-mapped/compatible/SIIT,
//!   6to4 2002::/16, and both the server and the client IPv4 of Teredo
//!   2001:0::/32) is classified by the embedded IPv4 so a private target
//!   cannot bypass by spelling;
//! * NAT64 64:ff9b::/32 is refused outright, the well-known /96 included
//!   (stricter than the worker and compute classifiers, which decode the
//!   /96);
//! * the URL is parsed with the WHATWG URL parser of the `url` crate, which
//!   reqwest applies to the same string, so the guard classifies the host
//!   the transport would connect to: IPv4 written as decimal / hex / octal
//!   numbers or short dotted forms (`2130706433`, `0x7f000001`,
//!   `0177.0.0.1`, `127.1`, `10.0.0.01`) arrives canonicalized, and a
//!   backslash or userinfo cannot make the guard read a different host.

use std::net::{IpAddr, Ipv4Addr, Ipv6Addr};

/// DNS resolution seam. The production resolver uses the system resolver; the
/// test resolver returns scripted addresses.
pub trait Resolve: Send + Sync {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String>;
}

/// Production resolver over the system DNS (std `ToSocketAddrs`).
pub struct SystemResolve;

impl Resolve for SystemResolve {
    fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
        use std::net::ToSocketAddrs;
        let candidate = format!("{host}:0");
        let sockets = candidate
            .to_socket_addrs()
            .map_err(|error| error.to_string())?;
        Ok(sockets.map(|socket| socket.ip()).collect())
    }
}

/// The classification outcome for one URL.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SsrfDecision {
    Allowed,
    Rejected(String),
}

/// http/https + host classification for one URL, parsed with the WHATWG
/// parser of the `url` crate (the parser reqwest applies to the same string)
/// so the classified host is the one the transport would connect to. Returns
/// the decision; the caller turns a rejection into its own error shape.
pub fn classify_url(raw_url: &str, resolver: &dyn Resolve) -> SsrfDecision {
    let parsed = match url::Url::parse(raw_url) {
        Ok(parsed) => parsed,
        Err(url::ParseError::RelativeUrlWithoutBase) => {
            return SsrfDecision::Rejected("url must be absolute with an http/https scheme".into());
        }
        Err(url::ParseError::EmptyHost) => {
            return SsrfDecision::Rejected("url host is empty".into());
        }
        Err(error) => return SsrfDecision::Rejected(format!("url is not valid: {error}")),
    };
    if parsed.scheme() != "http" && parsed.scheme() != "https" {
        return SsrfDecision::Rejected("url must use http or https".into());
    }
    match parsed.host() {
        // An IP literal, in any spelling the parser accepts, is classified
        // without DNS.
        Some(url::Host::Ipv4(ip)) => classify_ip(IpAddr::V4(ip)),
        Some(url::Host::Ipv6(ip)) => classify_ip(IpAddr::V6(ip)),
        Some(url::Host::Domain(name)) => classify_name(name, resolver),
        None => SsrfDecision::Rejected("url host is empty".into()),
    }
}

fn classify_name(name: &str, resolver: &dyn Resolve) -> SsrfDecision {
    match resolver.resolve(name) {
        Ok(addresses) => {
            if addresses.is_empty() {
                return SsrfDecision::Rejected("host resolved to no addresses".into());
            }
            for address in addresses {
                if let SsrfDecision::Rejected(reason) = classify_ip(address) {
                    return SsrfDecision::Rejected(reason);
                }
            }
            SsrfDecision::Allowed
        }
        Err(error) => SsrfDecision::Rejected(format!("host resolution failed: {error}")),
    }
}

fn classify_ip(ip: IpAddr) -> SsrfDecision {
    if is_blocked_ip(ip) {
        SsrfDecision::Rejected(format!("host resolves to a blocked address ({ip})"))
    } else {
        SsrfDecision::Allowed
    }
}

/// True for every address class the worker's SSRF guard blocks (unspecified,
/// loopback, private (RFC1918), link-local, CGNAT, ULA, multicast, reserved,
/// broadcast, and IPv4 embedded in transition forms), plus the classes this
/// guard alone refuses: 192.0.0.0/24, the IPv4 and IPv6 documentation ranges
/// and all of NAT64 64:ff9b::/32.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, c, _d] = ip.octets();
    a == 0                                   // "this network"
        || a == 10                            // RFC1918 private
        || (a == 100 && (0x40..=0x7f).contains(&b)) // CGNAT 100.64/10
        || (a == 127)                         // loopback
        || (a == 169 && b == 254)             // link-local
        || (a == 172 && (16..=31).contains(&b)) // RFC1918 private
        || (a == 192 && b == 168)             // RFC1918 private
        || (a == 192 && b == 0 && c == 0)     // IETF protocol assignments 192.0.0.0/24
        || (a == 192 && b == 0 && c == 2)     // documentation 192.0.2/24
        || (a == 198 && b == 51 && c == 100)  // documentation 198.51.100/24
        || (a == 203 && b == 0 && c == 113)   // documentation 203.0.113/24
        || (224..=239).contains(&a)   // multicast
        || a >= 240 // reserved + broadcast
}

/// The IPv4 carried in two IPv6 segments (high, low).
fn embedded_ipv4(hi: u16, lo: u16) -> Ipv4Addr {
    let [a, b] = hi.to_be_bytes();
    let [c, d] = lo.to_be_bytes();
    Ipv4Addr::new(a, b, c, d)
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    // The /96 tunnel prefixes (::/96 compatible, ::ffff:0:0/96 mapped,
    // ::ffff:0:0:0/96 SIIT-translated) carry an IPv4 in the low 32 bits —
    // classify the embedded IPv4.
    if segments[..5] == [0, 0, 0, 0, 0] && (segments[5] == 0 || segments[5] == 0xffff) {
        return is_blocked_ipv4(embedded_ipv4(segments[6], segments[7]));
    }
    if segments[..4] == [0, 0, 0, 0] && segments[4] == 0xffff && segments[5] == 0 {
        return is_blocked_ipv4(embedded_ipv4(segments[6], segments[7]));
    }
    // NAT64 64:ff9b::/32 is refused outright, the well-known /96 included.
    // This is stricter than the worker and compute classifiers, which decode
    // the IPv4 of 64:ff9b::/96 and refuse only the rest of the /32.
    if segments[0] == 0x64 && segments[1] == 0xff9b {
        return true;
    }
    // Transition tunnels carry an IPv4 inside the literal as well: 6to4
    // (2002::/16) in segments 1-2, and Teredo (2001:0::/32) two of them: the
    // server IPv4 in segments 2-3, where a Teredo relay or client sends its
    // indirect bubble (UDP 3544), and the client IPv4, obfuscated (XOR 0xffff
    // per segment), in segments 6-7. A translator on the egress path targets
    // those IPv4, so each is classified with the IPv4 rules and any blocked
    // one refuses the address.
    if segments[0] == 0x2002 {
        return is_blocked_ipv4(embedded_ipv4(segments[1], segments[2]));
    }
    if segments[0] == 0x2001 && segments[1] == 0 {
        return is_blocked_ipv4(embedded_ipv4(segments[2], segments[3]))
            || is_blocked_ipv4(embedded_ipv4(segments[6] ^ 0xffff, segments[7] ^ 0xffff));
    }
    (segments[0] & 0xfe00) == 0xfc00        // ULA fc00::/7
        || (segments[0] & 0xffc0) == 0xfe80 // link-local fe80::/10
        || (segments[0] & 0xff00) == 0xff00 // multicast
        || (segments[0] == 0x2001 && segments[1] == 0xdb8) // documentation
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    struct FakeResolver(HashMap<String, Vec<IpAddr>>);

    impl Resolve for FakeResolver {
        fn resolve(&self, host: &str) -> Result<Vec<IpAddr>, String> {
            self.0
                .get(host)
                .cloned()
                .ok_or_else(|| "NXDOMAIN".to_string())
        }
    }

    fn guard() -> FakeResolver {
        let mut map = HashMap::new();
        map.insert(
            "public.example".to_string(),
            vec!["93.184.216.34".parse().unwrap()],
        );
        map.insert(
            "internal.example".to_string(),
            vec!["10.0.0.5".parse().unwrap()],
        );
        map.insert(
            "metadata.example".to_string(),
            vec!["169.254.169.254".parse().unwrap()],
        );
        map.insert("localhost".to_string(), vec!["127.0.0.1".parse().unwrap()]);
        map.insert(
            "v6private.example".to_string(),
            vec!["fc00::5".parse().unwrap()],
        );
        map.insert("empty.example".to_string(), vec![]);
        FakeResolver(map)
    }

    #[test]
    fn allows_public_http_and_https_urls() {
        assert_eq!(
            classify_url("https://public.example/rpc", &guard()),
            SsrfDecision::Allowed
        );
        assert_eq!(
            classify_url("http://public.example/rpc", &guard()),
            SsrfDecision::Allowed
        );
    }

    #[test]
    fn rejects_non_http_schemes_and_relative_urls() {
        assert!(matches!(
            classify_url("ftp://public.example", &guard()),
            SsrfDecision::Rejected(_)
        ));
        assert!(matches!(
            classify_url("file:///etc/passwd", &guard()),
            SsrfDecision::Rejected(_)
        ));
        assert!(matches!(
            classify_url("/rpc/relative", &guard()),
            SsrfDecision::Rejected(_)
        ));
    }

    #[test]
    fn rejects_private_loopback_and_metadata_targets() {
        for url in [
            "http://localhost:10332",
            "http://127.0.0.1:10332",
            "http://10.0.0.5:10332",
            "http://192.168.1.10",
            "http://172.16.0.9",
            "http://169.254.169.254/latest/meta-data",
            "http://metadata.example/latest/meta-data",
            "http://internal.example/rpc",
            "http://100.64.0.1",
            "http://[::1]:10332",
            "http://[fc00::5]",
        ] {
            assert!(
                matches!(classify_url(url, &guard()), SsrfDecision::Rejected(_)),
                "expected rejection for {url}"
            );
        }
    }

    #[test]
    fn rejects_numeric_spellings_of_private_addresses() {
        for url in [
            "http://2130706433", // 127.0.0.1 decimal
            "http://0x7f000001", // 127.0.0.1 hex
            "http://0177.0.0.1", // 127.0.0.1 octal
            "http://127.1",      // 127.0.0.1 short
            "http://0xA9FE4254", // 169.254.66.84 hex (metadata)
            "http://2852039166", // 169.254.66.84 decimal
        ] {
            assert!(
                matches!(classify_url(url, &guard()), SsrfDecision::Rejected(_)),
                "expected rejection for {url}"
            );
        }
    }

    #[test]
    fn classifies_the_address_the_url_parser_resolves_a_spelling_to() {
        // Each spelling is the address the WHATWG parser (the url crate that
        // reqwest uses) turns it into: the last part fills the low bytes, a
        // leading 0 is octal, 0x is hex, and a trailing dot is dropped.
        for (url, canonical) in [
            ("http://10.0.0.01/", "10.0.0.1"),
            ("http://192.168.0.01/", "192.168.0.1"),
            ("http://0x0a.0.0.1/", "10.0.0.1"),
            ("http://012.0.0.1/", "10.0.0.1"),
            ("http://192.168.1/", "192.168.0.1"),
            ("http://192.168.257/", "192.168.1.1"),
            ("http://169.254.169/", "169.254.0.169"),
            ("http://127.0.0.1./", "127.0.0.1"),
        ] {
            assert_eq!(
                classify_url(url, &guard()),
                SsrfDecision::Rejected(format!("host resolves to a blocked address ({canonical})")),
                "{url}"
            );
        }
    }

    #[test]
    fn classifies_the_host_the_transport_connects_to() {
        // For http(s) a backslash ends the authority, so the host here is
        // 127.0.0.1 and "@public.example/" is path, not userinfo + host.
        assert_eq!(
            classify_url("http://127.0.0.1\\@public.example/", &guard()),
            SsrfDecision::Rejected("host resolves to a blocked address (127.0.0.1)".into())
        );
        // The mirror image connects to public.example, so it is classified
        // as public.example.
        assert_eq!(
            classify_url("http://public.example\\@127.0.0.1/", &guard()),
            SsrfDecision::Allowed
        );
        // Userinfo is not the host.
        assert_eq!(
            classify_url("https://127.0.0.1@public.example/rpc", &guard()),
            SsrfDecision::Allowed
        );
        assert!(matches!(
            classify_url("https://public.example@127.0.0.1/rpc", &guard()),
            SsrfDecision::Rejected(_)
        ));
    }

    #[test]
    fn rejects_urls_the_transport_cannot_parse() {
        for url in [
            "http://public.example:99999/", // port out of range
            "http://08.8.8.8/",             // 08 is not an octal number
            "http://[::ffff:08.8.8.8]/",    // leading zero in an embedded IPv4
            "http://[fe80::1%25eth0]/",     // zone identifier
            "http://1.2.3.4.5/",            // five-part dotted number
        ] {
            assert!(
                matches!(classify_url(url, &guard()), SsrfDecision::Rejected(_)),
                "expected rejection for {url}"
            );
        }
    }

    #[test]
    fn refuses_special_ipv4_ranges_by_their_third_octet() {
        // 192.0.0.0/24, 192.0.2.0/24, 198.51.100.0/24 and 203.0.113.0/24 are
        // matched on the third octet; a fourth octet that happens to equal
        // it does not put a public address in the range.
        for address in ["192.0.0.8", "192.0.2.5", "198.51.100.7", "203.0.113.9"] {
            let ip: IpAddr = address.parse().unwrap();
            assert!(is_blocked_ip(ip), "expected blocked: {address}");
        }
        for address in ["192.0.1.0", "192.0.5.2", "198.51.7.100", "203.0.9.113"] {
            let ip: IpAddr = address.parse().unwrap();
            assert!(!is_blocked_ip(ip), "expected allowed: {address}");
        }
    }

    #[test]
    fn rejects_unresolvable_hosts_and_empty_answers() {
        assert!(matches!(
            classify_url("http://nx.example", &guard()),
            SsrfDecision::Rejected(_)
        ));
        assert!(matches!(
            classify_url("http://empty.example", &guard()),
            SsrfDecision::Rejected(_)
        ));
    }

    #[test]
    fn allows_public_ipv6_and_embedded_public_v4() {
        let mut map = HashMap::new();
        map.insert(
            "v6.example".to_string(),
            vec!["2606:4700:4700::1111".parse().unwrap()],
        );
        map.insert(
            "v4mapped.example".to_string(),
            vec!["::ffff:93.184.216.34".parse().unwrap()],
        );
        assert_eq!(
            classify_url("https://v6.example", &FakeResolver(map.clone())),
            SsrfDecision::Allowed
        );
        assert_eq!(
            classify_url("https://v4mapped.example", &FakeResolver(map)),
            SsrfDecision::Allowed
        );
    }

    #[test]
    fn shared_js_rust_vectors_hold() {
        // crates/neo-os-core/tests/vectors/ssrf_addresses.json is the one case
        // list shared with the worker's JS classifier and the compute port, so
        // the transport guard cannot drift from them on these verdicts. A case
        // may carry chain_n3_blocked where this guard's documented policy is
        // stricter than the worker's; it can only tighten a verdict.
        let raw = include_str!("../../neo-os-core/tests/vectors/ssrf_addresses.json");
        let vector: serde_json::Value =
            serde_json::from_str(raw).expect("valid shared ssrf vectors");
        let cases = vector["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 40);
        let no_dns = FakeResolver(HashMap::new());
        for case in cases {
            let address = case["address"].as_str().expect("case address");
            let shared = case["blocked"].as_bool().expect("case blocked flag");
            let expected = match case.get("chain_n3_blocked") {
                None => shared,
                Some(stricter) => {
                    assert_eq!(
                        (stricter.as_bool(), shared),
                        (Some(true), false),
                        "chain_n3_blocked may only tighten an allowed case: {address}"
                    );
                    true
                }
            };
            match address.parse::<IpAddr>() {
                Ok(ip) => assert_eq!(
                    is_blocked_ip(ip),
                    expected,
                    "shared vector case mismatch: {address}"
                ),
                // Only a spelling Node's net.isIP rejects too (a leading-zero
                // octet) fails to parse; every implementation must refuse it.
                Err(_) => assert!(
                    expected,
                    "unparseable shared vector must be blocked: {address}"
                ),
            }
            // The URL path must reach the same verdict without DNS.
            let url = if address.contains(':') {
                format!("http://[{address}]/")
            } else {
                format!("http://{address}/")
            };
            assert_eq!(
                matches!(classify_url(&url, &no_dns), SsrfDecision::Rejected(_)),
                expected,
                "shared vector URL mismatch: {url}"
            );
        }
    }

    #[test]
    fn transition_ipv6_classifies_on_the_embedded_ipv4() {
        // FZ-16 reproducers: 6to4, Teredo and SIIT spellings of loopback,
        // private, link-local and metadata IPv4 must refuse even though the
        // surrounding hextets look public.
        for address in [
            "2002:7f00:1::1",
            "2002:a9fe:a9fe::1",
            "2002:a01:203::1",
            "2002::",
            "2001:0:4136:e378:8000:63bf:f5fe:fdfc",
            "2001:0:4136:e378:8000:63bf:80ff:fffe",
            "2001:0::",
            "::ffff:0:127.0.0.1",
        ] {
            let ip: IpAddr = address.parse().unwrap();
            assert!(is_blocked_ip(ip), "expected blocked: {address}");
        }
        // Public embedded IPv4 stays allowed on every transition prefix
        // (Teredo: server 65.54.227.120, client 8.8.8.8).
        for address in ["2002:808:808::1", "2001:0:4136:e378:8000:63bf:f7f7:f7f7"] {
            let ip: IpAddr = address.parse().unwrap();
            assert!(!is_blocked_ip(ip), "expected allowed: {address}");
        }
    }

    #[test]
    fn teredo_refuses_a_blocked_server_ipv4() {
        // A Teredo relay or client sends its indirect bubble (UDP 3544) to
        // the server IPv4 in segments 2-3, so a public client does not make
        // the address safe.
        for address in [
            "2001:0:a9fe:a9fe::f7f7:f7f7", // server 169.254.169.254
            "2001:0:7f00:1::f7f7:f7f7",    // server 127.0.0.1
            "2001:0:a00:1::f7f7:f7f7",     // server 10.0.0.1
            "2001:0:c0a8:1::f7f7:f7f7",    // server 192.168.0.1
            "2001:0:6440:1::f7f7:f7f7",    // server 100.64.0.1 (CGNAT)
            "2001:0:0:0::f7f7:f7f7",       // server 0.0.0.0
        ] {
            let ip: IpAddr = address.parse().unwrap();
            assert!(is_blocked_ip(ip), "expected blocked: {address}");
        }
    }

    #[test]
    fn nat64_is_refused_outright() {
        // Stricter than the worker and compute classifiers: the well-known
        // 64:ff9b::/96 is refused even when it embeds a public IPv4, and so is
        // every other 64:ff9b::/32 layout.
        for address in [
            "64:ff9b::808:808",
            "64:ff9b::a01:203",
            "64:ff9b:1:0:7f:0:100:0",
            "64:ff9b:1::808:808",
            "64:ff9b:ffff::808:808",
        ] {
            let ip: IpAddr = address.parse().unwrap();
            assert!(is_blocked_ip(ip), "expected blocked: {address}");
        }
    }
}
