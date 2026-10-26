//! Explicit network contexts for a shared enclave process. The measured
//! profile map supplies complete per-network configuration: no ambient token,
//! RPC, key ID or state is inherited from another profile. Only process-wide
//! boot policy is copied. Provisioning still changes only its selected overlay.

use std::collections::BTreeMap;
use std::fmt;

use serde::de::{Deserialize, Deserializer, MapAccess, Visitor};

use crate::overlay::EnvOverlay;
use crate::routes::{classify, Target};
use crate::{http_error, RuntimeError};

pub const PROFILES_ENV: &str = "MORPHEUS_NETWORK_PROFILES_JSON";
const BOOT_POLICY: [&str; 4] = [
    "MORPHEUS_EMBEDDED_RELAYER",
    "NODE_ENV",
    "MORPHEUS_ATTESTED_BOOT",
    "MORPHEUS_ALLOW_EPHEMERAL_KEY",
];

// serde_json::Value/BTreeMap alone silently replace duplicate object keys.
// Reject them at both map levels before choosing an identity or boot policy.
struct UniqueMap<T>(BTreeMap<String, T>);
impl<'de, T: Deserialize<'de>> Deserialize<'de> for UniqueMap<T> {
    fn deserialize<D: Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
        struct MapVisitor<T>(std::marker::PhantomData<T>);
        impl<'de, T: Deserialize<'de>> Visitor<'de> for MapVisitor<T> {
            type Value = UniqueMap<T>;
            fn expecting(&self, f: &mut fmt::Formatter) -> fmt::Result {
                f.write_str("an object with unique keys")
            }
            fn visit_map<M: MapAccess<'de>>(self, mut map: M) -> Result<Self::Value, M::Error> {
                let mut result = BTreeMap::new();
                while let Some((key, value)) = map.next_entry::<String, T>()? {
                    if result.insert(key, value).is_some() {
                        return Err(serde::de::Error::custom("duplicate configuration key"));
                    }
                }
                Ok(UniqueMap(result))
            }
        }
        deserializer.deserialize_map(MapVisitor(std::marker::PhantomData))
    }
}

pub struct NetworkProfiles {
    pub overlays: BTreeMap<String, EnvOverlay>,
    pub explicit: bool,
}

impl NetworkProfiles {
    pub fn from_overlay(base: &EnvOverlay) -> Result<Self, RuntimeError> {
        let Some(raw) = base.get(PROFILES_ENV) else {
            let network =
                crate::normalize_network(base.get("MORPHEUS_NETWORK")).map_err(|message| {
                    http_error(500, format!("invalid runtime network: {message}"))
                })?;
            return Ok(Self {
                overlays: BTreeMap::from([(network, base.clone())]),
                explicit: false,
            });
        };
        // Never include serde's error or input: it can contain configuration values.
        let parsed: UniqueMap<UniqueMap<String>> = serde_json::from_str(raw)
            .map_err(|_| http_error(500, "invalid network profiles configuration"))?;
        if parsed.0.len() != 2
            || !parsed.0.contains_key("mainnet")
            || !parsed.0.contains_key("testnet")
        {
            return Err(http_error(
                500,
                "network profiles must contain exactly mainnet and testnet",
            ));
        }
        let mut overlays = BTreeMap::new();
        for (network, UniqueMap(mut values)) in parsed.0 {
            if BOOT_POLICY.iter().any(|key| values.contains_key(*key))
                || values.contains_key(PROFILES_ENV)
            {
                return Err(http_error(
                    500,
                    "network profiles cannot override process boot policy",
                ));
            }
            if values
                .get("MORPHEUS_NETWORK")
                .is_some_and(|value| value != &network)
            {
                return Err(http_error(500, "network profile identity mismatch"));
            }
            for key in BOOT_POLICY {
                if let Some(value) = base.get(key) {
                    values.insert(key.to_string(), value.to_string());
                }
            }
            values.insert("MORPHEUS_NETWORK".to_string(), network.clone());
            overlays.insert(network, EnvOverlay::new(values));
        }
        Ok(Self {
            overlays,
            explicit: true,
        })
    }
}

pub struct SelectedRequest {
    pub network: String,
    pub raw_url: String,
}

fn checked_label(value: &str) -> Result<&str, RuntimeError> {
    match value {
        "mainnet" | "testnet" => Ok(value),
        _ => Err(http_error(
            400,
            "network must be exactly mainnet or testnet",
        )),
    }
}

/// Select once before dispatch/auth/provisioning. Path or header selects the
/// context; all other supplied selectors are assertions and must agree. A
/// missing network never falls back to the other network or global defaults.
pub fn select_request(
    method: &str,
    raw_url: &str,
    headers: &http::HeaderMap,
    body: &str,
) -> Result<SelectedRequest, RuntimeError> {
    let (path, query) = raw_url.split_once('?').unwrap_or((raw_url, ""));
    // Do not normalize ambiguous encoded/dot paths into an authorized route.
    if !path.starts_with('/')
        || path.contains('%')
        || path.contains('\\')
        || path.contains("//")
        || path.split('/').any(|s| s == "." || s == "..")
    {
        return Err(http_error(400, "noncanonical network route"));
    }
    let mut selected = None;
    let (first, rest) = path[1..].split_once('/').unwrap_or((&path[1..], ""));
    let canonical = if matches!(first, "mainnet" | "testnet") {
        selected = Some(first);
        format!("/{rest}")
    } else {
        path.to_string()
    };
    let mut header_values = headers.get_all("x-morpheus-network").iter();
    if let Some(value) = header_values.next() {
        if header_values.next().is_some() {
            return Err(http_error(400, "duplicate network header"));
        }
        let network = checked_label(
            value
                .to_str()
                .map_err(|_| http_error(400, "invalid network header"))?,
        )?;
        if selected.is_some_and(|s| s != network) {
            return Err(http_error(400, "conflicting network selectors"));
        }
        selected = Some(network);
    }
    let network = selected.ok_or_else(|| http_error(400, "explicit network required"))?;
    let route_path = canonical.strip_suffix('/').unwrap_or(&canonical);
    let target = classify(method, route_path);
    let exact = match target {
        Target::Health => Some("/health"),
        Target::Attestation => Some("/attestation"),
        Target::Provision => Some("/provision"),
        Target::ProvisionCredentials => Some("/provision/credentials"),
        Target::ProvisionRelayerAuth => Some("/provision/relayer-auth"),
        _ => target.canonical_path(),
    };
    if exact != Some(route_path) && crate::custody_bootstrap::native_path(route_path).is_none() {
        return Err(http_error(404, "unknown network route"));
    }
    let mut query_names = std::collections::BTreeSet::new();
    for (key, value) in url::form_urlencoded::parse(query.as_bytes()) {
        if NETWORK_ALIASES.contains(&key.as_ref())
            && (!query_names.insert(key.to_string()) || checked_label(&value)? != network)
        {
            return Err(http_error(
                400,
                "query network disagrees with selected context",
            ));
        }
    }
    if !body.trim().is_empty() {
        let parsed: UniqueMap<serde_json::Value> = serde_json::from_str(body)
            .map_err(|_| http_error(400, "request body must be an object with unique fields"))?;
        let payload = serde_json::Value::Object(parsed.0.into_iter().collect());
        assert_payload_network(network, route_path, &payload)?;
    }
    let raw_url = if query.is_empty() {
        canonical
    } else {
        format!("{canonical}?{query}")
    };
    Ok(SelectedRequest {
        network: network.to_string(),
        raw_url,
    })
}

const NETWORK_ALIASES: [&str; 4] = [
    "network",
    "morpheus_network",
    "runtime_network",
    "environment",
];

/// All deployment aliases are assertions, including lower-priority aliases.
/// Recovery and the two oracle message routes also historically use `network`
/// for a chain family; the AA v3 callbacks instead carry its opaque on-chain
/// text. Neither form selects a deployment or exempts another assertion.
pub(crate) fn assert_payload_network(
    network: &str,
    route: &str,
    payload: &serde_json::Value,
) -> Result<(), RuntimeError> {
    for alias in NETWORK_ALIASES {
        if let Some(value) = payload.get(alias) {
            let nonempty_text = value.as_str().is_some_and(|s| !s.trim().is_empty());
            let is_recovery_chain = alias == "network"
                && route == "/neodid/recovery-ticket"
                && nonempty_text
                && (value.as_str().is_some_and(|s| {
                    matches!(s.trim().to_ascii_lowercase().as_str(), "neo_n3" | "neox")
                }) || neo_os_compute::neodid::is_aa_recovery_v3_payload(payload));
            let is_aa_action_chain = alias == "network"
                && route == "/neodid/action-ticket"
                && nonempty_text
                && neo_os_compute::neodid::is_aa_action_v3_payload(payload);
            let is_oracle_chain = alias == "network"
                && matches!(route, "/oracle/decrypt" | "/oracle/message-reveal")
                && value.as_str().is_some_and(|s| {
                    neo_os_compute::oracle::message_reveal::is_neox_chain_alias(
                        &neo_os_compute::js::js_trim(s).to_ascii_lowercase(),
                    )
                });
            if is_recovery_chain || is_aa_action_chain || is_oracle_chain {
                continue;
            }
            if checked_label(
                value
                    .as_str()
                    .ok_or_else(|| http_error(400, "invalid payload network"))?,
            )? != network
            {
                return Err(http_error(
                    400,
                    "payload network disagrees with selected context",
                ));
            }
        }
    }
    Ok(())
}

#[cfg(test)]
#[path = "../tests/unit/network_profiles.rs"]
mod tests;
