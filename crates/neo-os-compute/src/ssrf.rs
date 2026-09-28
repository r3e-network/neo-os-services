//! Port of `workers/nitro-worker/src/platform/ssrf.js` — the shared SSRF host
//! classifier. String-prefix host checks are bypassable via DNS rebinding,
//! octal/hex/decimal IPv4 literals and IPv6 forms, so a host is resolved to
//! concrete IPs and every address is range-checked. The DNS layer is injected
//! ([`DnsLookup`]) so the classification stays pure and fixtures stub the wire.

use serde_json::Value as Json;

use crate::js::js_trim_string;

/// One resolved address record (`{ address, family }`); family mirrors Node's
/// `dns.lookup` — 4 or 6.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedAddress {
    pub address: String,
    pub family: u8,
}

pub type DnsLookupError = ();

/// `dnsPromises.lookup(host, { all: true, verbatim: true })` — `Err(())` is a
/// lookup failure (the JS `catch`).
pub type DnsLookup<'a> = &'a dyn Fn(&str) -> Result<Vec<ResolvedAddress>, DnsLookupError>;

fn is_ascii_digit_byte(byte: u8) -> bool {
    byte.is_ascii_digit()
}

/// `net.isIP(address)` — 0, 4 or 6. IPv4 accepts 1-3 digit decimal octets
/// including leading zeros (Node's regex), IPv6 follows the RFC 5952 literal
/// grammar with an optional embedded dotted-quad tail. Anything the validator
/// cannot confidently parse is NOT an IP literal, which the caller treats as a
/// hostname (and the blocked-address gate stays fail-closed).
pub fn net_is_ip(address: &str) -> u8 {
    if is_ipv4_literal(address) {
        return 4;
    }
    if is_ipv6_literal(address) {
        return 6;
    }
    0
}

fn is_ipv4_literal(address: &str) -> bool {
    let parts: Vec<&str> = address.split('.').collect();
    parts.len() == 4
        && parts.iter().all(|part| {
            !part.is_empty()
                && part.len() <= 3
                && part.bytes().all(is_ascii_digit_byte)
                && part.parse::<u32>().map(|v| v <= 255).unwrap_or(false)
        })
}

/// Expands a validated IPv6 literal into 8 hextets (`expandIpv6`).
fn expand_ipv6(address: &str) -> Option<[u16; 8]> {
    let mut value = address.to_string();
    // Trailing dotted-decimal IPv4 → two hextets.
    if let Some(dot) = value.rfind('.') {
        if let Some(colon) = value.rfind(':') {
            if dot > colon {
                let v4 = &value[colon + 1..];
                if !is_ipv4_literal(v4) {
                    return None;
                }
                let parts: Vec<u32> = v4.split('.').map(|p| p.parse().unwrap()).collect();
                let hi = (parts[0] << 8) | parts[1];
                let lo = (parts[2] << 8) | parts[3];
                value = format!("{}{:x}:{:x}", &value[..colon + 1], hi, lo);
            }
        }
    }
    if value.matches("::").count() > 1 {
        return None;
    }
    let (head, tail) = match value.split_once("::") {
        Some((head, tail)) => (head, Some(tail)),
        None => (value.as_str(), None),
    };
    let head_groups: Vec<&str> = head.split(':').filter(|g| !g.is_empty()).collect();
    let tail_groups: Vec<&str> = tail
        .map(|t| t.split(':').filter(|g| !g.is_empty()).collect())
        .unwrap_or_default();
    let mut groups: Vec<u32> = Vec::new();
    if tail.is_none() {
        for group in &head_groups {
            groups.push(parse_hextet(group)?);
        }
    } else {
        let missing = 8i64 - head_groups.len() as i64 - tail_groups.len() as i64;
        for group in &head_groups {
            groups.push(parse_hextet(group)?);
        }
        groups.extend(std::iter::repeat_n(0, missing.max(0) as usize));
        for group in &tail_groups {
            groups.push(parse_hextet(group)?);
        }
    }
    if groups.len() != 8 {
        return None;
    }
    let mut out = [0u16; 8];
    for (slot, group) in out.iter_mut().zip(&groups) {
        *slot = u16::try_from(*group).ok()?;
    }
    Some(out)
}

fn parse_hextet(group: &str) -> Option<u32> {
    if group.is_empty() || group.len() > 4 || !group.bytes().all(|b| b.is_ascii_hexdigit()) {
        return None;
    }
    u32::from_str_radix(group, 16).ok()
}

fn is_ipv6_literal(address: &str) -> bool {
    expand_ipv6(address).is_some()
}

/// `isBlockedIpAddress(rawAddress)` — true when an IP literal must be rejected
/// (private/loopback/link-local/CGNAT/multicast/reserved, plus IPv4 embedded
/// in the IPv4-mapped/SIIT/NAT64/6to4/Teredo transition forms). Unparseable
/// input is treated as unsafe.
pub fn is_blocked_ip_address(raw_address: &Json) -> bool {
    let mut address = js_trim_string(Some(raw_address)).to_lowercase();
    if address.is_empty() {
        return true;
    }
    // Strip an IPv6 zone identifier (e.g. fe80::1%eth0) before classification.
    if let Some(zone) = address.find('%') {
        address.truncate(zone);
    }
    match net_is_ip(&address) {
        4 => is_blocked_ipv4(&address),
        6 => is_blocked_ipv6(&address),
        _ => true,
    }
}

fn is_blocked_ipv4(address: &str) -> bool {
    let parts: Vec<Option<u32>> = address
        .split('.')
        .map(|part| part.parse::<u32>().ok())
        .collect();
    if parts.len() != 4 || parts.iter().any(|part| part.is_none()) {
        return true;
    }
    let octets: Vec<u32> = parts.into_iter().map(|part| part.unwrap()).collect();
    if octets.iter().any(|part| *part > 255) {
        return true;
    }
    let (a, b) = (octets[0], octets[1]);
    a == 0
        || a == 127
        || a == 10
        || (a == 172 && (16..=31).contains(&b))
        || (a == 192 && b == 168)
        || (a == 169 && b == 254)
        || (a == 100 && (64..=127).contains(&b))
        || a >= 224
}

fn is_blocked_ipv6(address: &str) -> bool {
    let Some(groups) = expand_ipv6(address) else {
        return true;
    };
    let groups: Vec<u32> = groups.iter().map(|g| u32::from(*g)).collect();
    // The /96 tunnel prefixes carry an IPv4 in the low 32 bits:
    // IPv4-compatible (::/96), IPv4-mapped (::ffff:0:0/96), SIIT
    // IPv4-translated (::ffff:0:0:0/96) and NAT64 (64:ff9b::/96). 6to4
    // (2002::/16) and Teredo (2001:0::/32) embed an IPv4 as well (the Teredo
    // client obfuscated, XOR 0xffffffff). A transition translator on the
    // egress path sends traffic to the embedded IPv4, so every form is
    // classified with the IPv4 rules.
    let zero_head = groups[0] == 0 && groups[1] == 0 && groups[2] == 0;
    let is_v4_tunnelled =
        (zero_head && groups[3] == 0 && groups[4] == 0 && (groups[5] == 0 || groups[5] == 0xffff))
            || (zero_head && groups[3] == 0 && groups[4] == 0xffff && groups[5] == 0);
    let is_nat64 = groups[0] == 0x64 && groups[1] == 0xff9b;
    if is_v4_tunnelled || is_nat64 {
        if groups[6] == 0 && groups[7] == 0 {
            // Bare ::ffff:0:0 / :: with no embedded host is itself unroutable.
            return true;
        }
        let v4 = format!(
            "{}.{}.{}.{}",
            groups[6] >> 8,
            groups[6] & 0xff,
            groups[7] >> 8,
            groups[7] & 0xff
        );
        return is_blocked_ipv4(&v4);
    }
    if groups[0] == 0x2002 {
        return is_blocked_ipv4(&format!(
            "{}.{}.{}.{}",
            groups[1] >> 8,
            groups[1] & 0xff,
            groups[2] >> 8,
            groups[2] & 0xff
        ));
    }
    if groups[0] == 0x2001 && groups[1] == 0 {
        let (hi, lo) = (groups[6] ^ 0xffff, groups[7] ^ 0xffff);
        return is_blocked_ipv4(&format!(
            "{}.{}.{}.{}",
            hi >> 8,
            hi & 0xff,
            lo >> 8,
            lo & 0xff
        ));
    }
    let first = groups[0];
    let all_zero = groups.iter().all(|g| *g == 0);
    let loopback = groups[..7].iter().all(|g| *g == 0) && groups[7] == 1;
    all_zero
        || loopback
        || (first & 0xffc0) == 0xfe80
        || (first & 0xffc0) == 0xfec0
        || (first & 0xfe00) == 0xfc00
        || (first & 0xff00) == 0xff00
}

/// `resolvePinnedAddresses(hostname, { allowUnresolved })` — resolve + validate
/// a hostname and return the validated resolved addresses so the caller can pin
/// the outbound connection to them (audit finding 8). Returns `[]` for an
/// IP-literal host (nothing to rebind) and `[]` when resolution fails and
/// `allow_unresolved` is set (lenient: the fetch fails on its own).
pub fn resolve_pinned_addresses(
    hostname: &Json,
    allow_unresolved: bool,
    dns: DnsLookup<'_>,
) -> Result<Vec<ResolvedAddress>, String> {
    let host = js_trim_string(Some(hostname)).to_lowercase();
    let literal_host = host
        .strip_prefix('[')
        .and_then(|rest| rest.strip_suffix(']'))
        .unwrap_or(&host)
        .to_string();

    if host == "localhost" || host == "0.0.0.0" || host.ends_with(".local") {
        return Err("private/internal URLs not allowed".to_string());
    }

    // Reject IP literals (octal/hex/decimal IPv4, IPv6) without a DNS round trip.
    if net_is_ip(&literal_host) != 0 {
        if is_blocked_ip_address(&Json::String(literal_host.clone())) {
            return Err("private/internal URLs not allowed".to_string());
        }
        return Ok(Vec::new());
    }

    // Resolve through getaddrinfo (the same path the outbound fetch uses), then
    // reject any private address.
    let records = match dns(&literal_host) {
        Ok(records) => records,
        Err(()) => {
            if !allow_unresolved {
                return Err(format!("unable to resolve host: {literal_host}"));
            }
            return Ok(Vec::new());
        }
    };
    for record in &records {
        if is_blocked_ip_address(&Json::String(record.address.clone())) {
            return Err("private/internal URLs not allowed".to_string());
        }
    }
    Ok(records
        .iter()
        .filter(|record| !record.address.is_empty())
        .cloned()
        .collect())
}

/// `assertResolvedHostAllowed(hostname)` — validation-only wrapper used at
/// URL-parse time.
pub fn assert_resolved_host_allowed(hostname: &Json, dns: DnsLookup<'_>) -> Result<(), String> {
    resolve_pinned_addresses(hostname, true, dns).map(|_| ())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn blocked(address: &str) -> bool {
        is_blocked_ip_address(&json!(address))
    }

    #[test]
    fn blocked_ranges_match_the_js_classifier() {
        // "this" network, loopback, private, link-local (cloud metadata),
        // CGNAT, multicast/reserved
        assert!(blocked("0.0.0.0"));
        assert!(blocked("127.0.0.1"));
        assert!(blocked("10.0.0.5"));
        assert!(blocked("172.16.0.1"));
        assert!(blocked("172.31.255.255"));
        assert!(blocked("192.168.1.10"));
        assert!(blocked("169.254.169.254"));
        assert!(blocked("100.64.0.1"));
        assert!(blocked("224.0.0.1"));
        assert!(blocked("240.0.0.1"));
        assert!(blocked("255.255.255.255"));
        // public addresses pass
        assert!(!blocked("8.8.8.8"));
        assert!(!blocked("172.32.0.1"));
        assert!(!blocked("100.128.0.1"));
        // CGNAT edges
        assert!(!blocked("100.63.255.255"));
        assert!(!blocked("100.128.0.0"));
        // unparseable → unsafe
        assert!(blocked("not-an-ip"));
        assert!(blocked("1.2.3"));
        assert!(blocked("1.2.3.4.5"));
        assert!(blocked("1.2.3.256"));
    }

    #[test]
    fn ipv6_ranges_match_the_js_classifier() {
        assert!(blocked("::1"));
        assert!(blocked("::"));
        assert!(blocked("fc00::1"));
        assert!(blocked("fd00::1"));
        assert!(blocked("fe80::1"));
        assert!(blocked("febf::1"));
        assert!(blocked("fec0::1"));
        assert!(blocked("ff00::1"));
        // IPv4-mapped loopback / private / metadata
        assert!(blocked("::ffff:127.0.0.1"));
        assert!(blocked("::ffff:10.0.0.1"));
        assert!(blocked("::ffff:169.254.169.254"));
        assert!(blocked("::ffff:0:0"));
        // NAT64 tunnelled loopback
        assert!(blocked("64:ff9b::127.0.0.1"));
        // public v6
        assert!(!blocked("2606:4700:4700::1111"));
        assert!(!blocked("::ffff:8.8.8.8"));
        assert!(!blocked("64:ff9b::8.8.8.8"));
        // zone identifiers are stripped before classification
        assert!(blocked("fe80::1%eth0"));
        // ULA edges
        assert!(!blocked("fe00::1"));
        assert!(!blocked("fbff::1"));
        assert!(blocked("fc00::1"));
    }

    #[test]
    fn shared_js_rust_vectors_hold() {
        // crates/neo-os-core/tests/vectors/ssrf_addresses.json is the one case
        // list shared with the JS classifier (workers/nitro-worker
        // src/platform/ssrf.test.mjs) and the chain-n3 transport guard, so all
        // three implementations are pinned to the same verdicts.
        let raw = include_str!("../../neo-os-core/tests/vectors/ssrf_addresses.json");
        let vector: Json = serde_json::from_str(raw).expect("valid shared ssrf vectors");
        let cases = vector["cases"].as_array().expect("cases array");
        assert!(cases.len() >= 40);
        for case in cases {
            let address = case["address"].as_str().expect("case address");
            let expected = case["blocked"].as_bool().expect("case blocked flag");
            assert_eq!(
                blocked(address),
                expected,
                "shared vector case mismatch: {address}"
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
            "2001:0:0:0:0:0:80ff:fffe",
            "2001:0::",
            "::ffff:0:127.0.0.1",
        ] {
            assert!(blocked(address), "expected blocked: {address}");
        }
        // Public embedded IPv4 stays allowed on every transition prefix.
        for address in ["2002:808:808::1", "2001:0:0:0:0:0:f7f7:f7f7"] {
            assert!(!blocked(address), "expected allowed: {address}");
        }
    }

    #[test]
    fn net_is_ip_matches_node_literal_rules() {
        assert_eq!(net_is_ip("8.8.8.8"), 4);
        // Node accepts leading-zero octets as decimal
        assert_eq!(net_is_ip("010.0.0.1"), 4);
        assert_eq!(net_is_ip("::1"), 6);
        assert_eq!(net_is_ip("2606:4700:4700::1111"), 6);
        assert_eq!(net_is_ip("::ffff:8.8.8.8"), 6);
        assert_eq!(net_is_ip("1:2:3:4:5:6:7:8"), 6);
        assert_eq!(net_is_ip("1:2:3:4:5:6:7:8:9"), 0);
        assert_eq!(net_is_ip("1::2::3"), 0);
        assert_eq!(net_is_ip("example.com"), 0);
        assert_eq!(net_is_ip("12345::"), 0);
        assert_eq!(net_is_ip("::ffff:1.2.3.4.5"), 0);
    }

    fn dns_records(addresses: &[&str]) -> Vec<ResolvedAddress> {
        addresses
            .iter()
            .map(|address| ResolvedAddress {
                address: address.to_string(),
                family: if net_is_ip(address) == 6 { 6 } else { 4 },
            })
            .collect()
    }

    fn literal_dns() -> DnsLookup<'static> {
        &|_host| Err(())
    }

    #[test]
    fn resolve_rejects_private_and_internal_hosts() {
        for host in [
            "localhost",
            "0.0.0.0",
            "foo.local",
            "127.0.0.1",
            "10.0.0.5",
            "192.168.1.10",
            "169.254.169.254",
            "100.64.0.1",
            "::1",
            "fc00::1",
            "fe80::1",
        ] {
            assert_eq!(
                resolve_pinned_addresses(&json!(host), true, literal_dns()).unwrap_err(),
                "private/internal URLs not allowed",
                "{host}"
            );
        }
    }

    #[test]
    fn resolve_returns_no_pin_set_for_a_public_ip_literal() {
        assert_eq!(
            resolve_pinned_addresses(&json!("8.8.8.8"), true, literal_dns()).unwrap(),
            Vec::new()
        );
    }

    #[test]
    fn resolve_returns_validated_records_for_a_public_host() {
        let dns = &|_host: &str| {
            Ok(dns_records(&[
                "93.184.216.34",
                "2606:2800:220:1:248:1893:25c8:1946",
            ]))
        };
        let pinned = resolve_pinned_addresses(&json!("example.com"), true, dns).unwrap();
        assert_eq!(pinned.len(), 2);
        assert_eq!(pinned[0].family, 4);
        assert_eq!(pinned[1].family, 6);
    }

    #[test]
    fn resolve_rejects_when_any_resolved_address_is_private() {
        let dns = &|_host: &str| Ok(dns_records(&["93.184.216.34", "10.0.0.1"]));
        assert_eq!(
            resolve_pinned_addresses(&json!("example.com"), true, dns).unwrap_err(),
            "private/internal URLs not allowed"
        );
    }

    #[test]
    fn resolution_failure_is_lenient_or_fail_closed() {
        // default: unresolved → [] (the fetch fails on its own)
        assert_eq!(
            resolve_pinned_addresses(&json!("ssrf-unresolved.test"), true, literal_dns()).unwrap(),
            Vec::new()
        );
        // allowUnresolved=false → fail closed
        assert_eq!(
            resolve_pinned_addresses(&json!("ssrf-unresolved.test"), false, literal_dns())
                .unwrap_err(),
            "unable to resolve host: ssrf-unresolved.test"
        );
    }

    #[test]
    fn bracked_ipv6_literals_are_validated_without_a_lookup() {
        assert_eq!(
            resolve_pinned_addresses(&json!("[2606:4700:4700::1111]"), true, literal_dns())
                .unwrap(),
            Vec::new()
        );
        assert_eq!(
            resolve_pinned_addresses(&json!("[::1]"), true, literal_dns()).unwrap_err(),
            "private/internal URLs not allowed"
        );
    }
}
