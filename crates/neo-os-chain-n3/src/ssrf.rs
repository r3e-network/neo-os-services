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
//! * IPv4 written as decimal / hex / octal single numbers or mixed-radix
//!   dotted forms (`2130706433`, `0x7f000001`, `0177.0.0.1`, `127.1`) is
//!   canonicalized before classification so it cannot bypass by spelling.

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

/// http/https + host classification for one URL. Returns the decision; the
/// caller turns a rejection into its own error shape.
pub fn classify_url(raw_url: &str, resolver: &dyn Resolve) -> SsrfDecision {
    let Some((scheme, host)) = split_scheme_and_host(raw_url) else {
        return SsrfDecision::Rejected("url must be absolute with an http/https scheme".into());
    };
    if scheme != "http" && scheme != "https" {
        return SsrfDecision::Rejected("url must use http or https".into());
    }
    if host.is_empty() {
        return SsrfDecision::Rejected("url host is empty".into());
    }

    // An IP literal (in any spelling) is classified without DNS.
    if let Some(ip) = parse_host_as_ip(&host) {
        return classify_ip(ip);
    }

    match resolver.resolve(&host) {
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

fn split_scheme_and_host(raw_url: &str) -> Option<(String, String)> {
    let (scheme, rest) = raw_url.split_once("://")?;
    let authority_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let authority = &rest[..authority_end];
    // Strip userinfo — a URL like https://evil@internal.host/ must classify on
    // the HOST, and userinfo in an RPC endpoint is itself suspicious but the
    // classification target is still the host part.
    let host_port = authority.rsplit('@').next()?;
    let host = host_port
        .strip_prefix('[')
        .and_then(|rest| rest.split_once(']').map(|(v6, _)| v6.to_string()))
        .unwrap_or_else(|| {
            host_port
                .rsplit_once(':')
                .map(|(host, _port)| host.to_string())
                .unwrap_or_else(|| host_port.to_string())
        });
    Some((scheme.to_lowercase(), host.to_lowercase()))
}

/// Parse a host string as an IP literal, including IPv4 spellings std rejects:
/// pure decimal/hex/octal 32-bit numbers, and dotted quads with 1-4 parts in
/// mixed decimal/hex/octal radix (classic SSRF bypass spellings).
fn parse_host_as_ip(host: &str) -> Option<IpAddr> {
    if let Ok(ip) = host.parse::<IpAddr>() {
        return Some(ip);
    }
    // Strip a trailing dot (FQDN spelling) — "127.0.0.1." would otherwise be
    // treated as a name.
    let host = host.strip_suffix('.').unwrap_or(host);
    if host.is_empty() {
        return None;
    }

    let parse_part = |part: &str| -> Option<u32> {
        let value = if let Some(hex) = part.strip_prefix("0x").or_else(|| part.strip_prefix("0X")) {
            u32::from_str_radix(hex, 16).ok()?
        } else if part.len() > 1 && part.starts_with('0') {
            u32::from_str_radix(part, 8).ok()?
        } else {
            part.parse::<u32>().ok()?
        };
        Some(value)
    };

    // Single-number forms: the whole host is one 32-bit value in decimal, hex,
    // or octal.
    if !host.contains('.') {
        let value = if let Some(hex) = host.strip_prefix("0x").or_else(|| host.strip_prefix("0X")) {
            u32::from_str_radix(hex, 16).ok()?
        } else if host.len() > 1 && host.starts_with('0') {
            u32::from_str_radix(host, 8).ok()?
        } else {
            host.parse::<u32>().ok()?
        };
        return Some(IpAddr::V4(Ipv4Addr::from(value)));
    }

    // Dotted forms with 1-4 mixed-radix parts: the last part fills the
    // remaining bytes (classic inet_aton behavior).
    let parts: Vec<&str> = host.split('.').collect();
    if parts.len() > 4 {
        return None;
    }
    let mut values = Vec::with_capacity(4);
    for part in parts.iter() {
        if part.is_empty() {
            return None;
        }
        let parsed = parse_part(part)?;
        let max = 1u32 << (8 * (4 - parts.len() + 1));
        if parsed >= max {
            return None;
        }
        values.push(parsed);
    }
    let mut word = 0u32;
    for (index, value) in values.iter().enumerate() {
        let last = index == values.len() - 1;
        if last {
            let remaining = 4 - values.len() + 1;
            word |= value << (8 * (4 - remaining));
        } else {
            word |= value << (8 * (3 - index));
        }
    }
    Some(IpAddr::V4(Ipv4Addr::from(word)))
}

fn classify_ip(ip: IpAddr) -> SsrfDecision {
    if is_blocked_ip(ip) {
        SsrfDecision::Rejected(format!("host resolves to a blocked address ({ip})"))
    } else {
        SsrfDecision::Allowed
    }
}

/// True for every address class the worker's SSRF guard blocks: unspecified,
/// loopback, private (RFC1918), link-local, CGNAT, ULA, multicast, reserved,
/// documentation, broadcast — for both families.
pub fn is_blocked_ip(ip: IpAddr) -> bool {
    match ip {
        IpAddr::V4(v4) => is_blocked_ipv4(v4),
        IpAddr::V6(v6) => is_blocked_ipv6(v6),
    }
}

fn is_blocked_ipv4(ip: Ipv4Addr) -> bool {
    let [a, b, _c, d] = ip.octets();
    a == 0                                   // "this network"
        || a == 10                            // RFC1918 private
        || (a == 100 && (0x40..=0x7f).contains(&b)) // CGNAT 100.64/10
        || (a == 127)                         // loopback
        || (a == 169 && b == 254)             // link-local
        || (a == 172 && (16..=31).contains(&b)) // RFC1918 private
        || (a == 192 && b == 168)             // RFC1918 private
        || (a == 192 && b == 0 && d == 0)     // TEST-NET-1-ish (192.0.0.0/24)
        || (a == 192 && b == 0 && d == 2)     // documentation 192.0.2/24
        || (a == 198 && b == 51 && d == 100)  // documentation 198.51.100/24
        || (a == 203 && b == 0 && d == 113)   // documentation 203.0.113/24
        || (224..=239).contains(&a)   // multicast
        || a >= 240 // reserved + broadcast
}

fn is_blocked_ipv6(ip: Ipv6Addr) -> bool {
    let segments = ip.segments();
    if ip.is_loopback() || ip.is_unspecified() {
        return true;
    }
    // v4-mapped / NAT64 64:ff9b:: → classify the embedded v4.
    if segments[..6] == [0, 0, 0, 0, 0, 0xffff] {
        return is_blocked_ipv4(Ipv4Addr::new(
            (segments[6] >> 8) as u8,
            (segments[6] & 0xff) as u8,
            (segments[7] >> 8) as u8,
            (segments[7] & 0xff) as u8,
        ));
    }
    if segments[0] == 0x64 && segments[1] == 0xff9b {
        return true;
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
}
