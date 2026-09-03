//! Port of `workers/nitro-worker/src/oracle/aggregation.js` — the
//! multi-source price aggregation engine (median, trimmed mean, deviation
//! based outlier rejection), with the JS result-object key order preserved.

use serde_json::{json, Value as Json};

use crate::js::{js_math_round, js_number_value, js_stringify, js_to_number, js_trim};
use std::collections::HashSet;

/// C2 — the minimum number of independent providers that must contribute to a
/// canonical aggregated record before it is anchored. A single-source value is
/// exactly the integrity gap the canonical record closes, so it must never be
/// written from fewer than two providers.
pub const CANONICAL_AGGREGATE_MIN_PROVIDERS: usize = 2;

/// `median(values)` — sorted copy; even lengths average the two middles.
pub fn median(values: &[f64]) -> Result<f64, String> {
    if values.is_empty() {
        return Err("median requires at least one value".to_string());
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let mid = sorted.len() / 2;
    Ok(if sorted.len().is_multiple_of(2) {
        (sorted[mid - 1] + sorted[mid]) / 2.0
    } else {
        sorted[mid]
    })
}

/// `trimmedMean(values, trimPct = 0.1)` — trims `floor(len * trimPct)` from
/// each end; when the trim would consume everything, falls back to the median.
pub fn trimmed_mean(values: &[f64], trim_pct: f64) -> Result<f64, String> {
    if values.is_empty() {
        return Err("trimmedMean requires at least one value".to_string());
    }
    let mut sorted = values.to_vec();
    sorted.sort_by(f64::total_cmp);
    let trim_count = (sorted.len() as f64 * trim_pct).floor() as usize;
    if trim_count * 2 >= sorted.len() {
        return median(&sorted);
    }
    let trimmed = &sorted[trim_count..sorted.len() - trim_count];
    Ok(trimmed.iter().sum::<f64>() / trimmed.len() as f64)
}

/// `countDistinctProviders(aggregation)` — the number of DISTINCT non-empty
/// `String(provider).trim().toLowerCase()` ids in `providers_used`. C2 —
/// counting unique ids closes the masquerade where a duplicated provider id
/// (`twelvedata,twelvedata`) would pose as a multi-provider aggregate.
pub fn count_distinct_providers(aggregation: &Json) -> usize {
    let Some(used) = aggregation.get("providers_used").and_then(Json::as_array) else {
        return 0;
    };
    let mut distinct = HashSet::new();
    for provider in used {
        let id = match provider {
            Json::Null => String::new(), // String(provider == null ? '' : provider)
            other => js_stringify(other),
        };
        let id = js_trim(&id).to_lowercase();
        if !id.is_empty() {
            distinct.insert(id);
        }
    }
    distinct.len()
}

/// `meetsMinProviders(aggregation, minProviders)` — whether the aggregation is
/// backed by at least `minProviders` independent sources, counted over the
/// DISTINCT ids that actually contributed.
pub fn meets_min_providers(aggregation: &Json, min_providers: usize) -> bool {
    // JS gate is `!aggregation || typeof !== 'object'` — arrays pass typeof,
    // so object-likes only.
    if !aggregation.is_object() && !aggregation.is_array() {
        return false;
    }
    count_distinct_providers(aggregation) >= min_providers
}

/// The `{ method, maxDeviationPct, minProviders }` options bag of
/// `aggregateQuotes`; defaults mirror the JS destructuring defaults.
pub struct AggregateOptions<'a> {
    pub method: &'a str,
    pub max_deviation_pct: f64,
    pub min_providers: usize,
}

impl Default for AggregateOptions<'_> {
    fn default() -> Self {
        Self {
            method: "median",
            max_deviation_pct: 25.0,
            min_providers: 1,
        }
    }
}

/// `aggregateQuotes(quotes, options)` — single-source passthrough, two-source
/// mean with the divergent pair collapsing to the lower price, and 3+ median
/// with deviation-based outlier rejection (median-fallback when everything is
/// rejected). The result object copies the JS literal key order: price,
/// method, providers_used, providers_rejected, deviation_pct, confidence.
pub fn aggregate_quotes(quotes: &Json, options: AggregateOptions<'_>) -> Result<Json, String> {
    let AggregateOptions {
        method,
        max_deviation_pct,
        min_providers,
    } = options;

    let Some(quote_list) = quotes.as_array() else {
        return Err("aggregateQuotes requires at least one quote".to_string());
    };
    if quote_list.is_empty() {
        return Err("aggregateQuotes requires at least one quote".to_string());
    }

    // q.price !== null && q.price !== undefined && Number.isFinite(Number(q.price))
    let valid: Vec<&Json> = quote_list
        .iter()
        .filter(|q| {
            q.get("price")
                .map(|p| !p.is_null() && js_to_number(p).is_finite())
                .unwrap_or(false)
        })
        .collect();

    if valid.is_empty() {
        return Err("no valid quotes to aggregate".to_string());
    }
    if valid.len() < min_providers {
        return Err(format!(
            "only {} providers available, minimum {} required",
            valid.len(),
            min_providers
        ));
    }

    let prices: Vec<f64> = valid.iter().map(|q| js_to_number(&q["price"])).collect();

    // JS `validQuotes[i].provider` — absent renders as null inside the result
    // arrays once JSON.stringify runs.
    let provider_of = |q: &Json| q.get("provider").cloned().unwrap_or(Json::Null);

    // Single source — return as-is
    if prices.len() == 1 {
        return Ok(json!({
            "price": js_number_value(prices[0]),
            "method": "single-source",
            "providers_used": [provider_of(valid[0])],
            "providers_rejected": [],
            "deviation_pct": 0,
            "confidence": "single-source",
        }));
    }

    // Two sources — average with deviation check
    if prices.len() == 2 {
        let avg = (prices[0] + prices[1]) / 2.0;
        let deviation = (prices[0] - prices[1]).abs() / avg * 100.0;
        if deviation > max_deviation_pct {
            // Can't determine which is the outlier with 2 sources — the
            // lower-priced quote wins.
            let idx = if prices[0] <= prices[1] { 0 } else { 1 };
            let rejected = valid
                .iter()
                .enumerate()
                .filter(|(i, _)| *i != idx)
                .map(|(_, q)| provider_of(q))
                .collect::<Vec<_>>();
            return Ok(json!({
                "price": js_number_value(prices[idx]),
                "method": "two-source-divergent",
                "providers_used": [provider_of(valid[idx])],
                "providers_rejected": rejected,
                "deviation_pct": js_number_value(js_math_round(deviation * 100.0) / 100.0),
                "confidence": "low",
            }));
        }
        let used = valid.iter().map(|q| provider_of(q)).collect::<Vec<_>>();
        return Ok(json!({
            "price": js_number_value(avg),
            "method": "mean",
            "providers_used": used,
            "providers_rejected": [],
            "deviation_pct": js_number_value(js_math_round(deviation * 100.0) / 100.0),
            "confidence": "medium",
        }));
    }

    // 3+ sources — median with outlier rejection
    let med = median(&prices)?;
    let mut rejected: Vec<&Json> = Vec::new();
    let mut kept: Vec<&Json> = Vec::new();
    for (i, price) in prices.iter().enumerate() {
        let deviation = if med > 0.0 {
            (price - med).abs() / med * 100.0
        } else {
            0.0
        };
        if deviation > max_deviation_pct {
            rejected.push(valid[i]);
        } else {
            kept.push(valid[i]);
        }
    }

    // If all rejected, fall back to median of all
    if kept.is_empty() {
        let used = valid.iter().map(|q| provider_of(q)).collect::<Vec<_>>();
        return Ok(json!({
            "price": js_number_value(med),
            "method": "median-fallback",
            "providers_used": used,
            "providers_rejected": [],
            "deviation_pct": 0,
            "confidence": "low",
        }));
    }

    let kept_prices: Vec<f64> = kept.iter().map(|q| js_to_number(&q["price"])).collect();
    let aggregated_price = if method == "trimmed-mean" {
        trimmed_mean(&kept_prices, 0.1)?
    } else {
        median(&kept_prices)?
    };

    // Compute deviation among kept quotes
    let kept_med = median(&kept_prices)?;
    let max_deviation = kept_prices.iter().fold(0.0f64, |max, p| {
        let dev = if kept_med > 0.0 {
            (p - kept_med).abs() / kept_med * 100.0
        } else {
            0.0
        };
        max.max(dev)
    });

    let confidence = if kept.len() >= 3 {
        "high"
    } else if kept.len() == 2 {
        "medium"
    } else {
        "low"
    };

    let used = kept.iter().map(|q| provider_of(q)).collect::<Vec<_>>();
    let rejected = rejected.iter().map(|q| provider_of(q)).collect::<Vec<_>>();
    Ok(json!({
        "price": js_number_value(aggregated_price),
        "method": if method == "trimmed-mean" { "trimmed-mean" } else { "median" },
        "providers_used": used,
        "providers_rejected": rejected,
        "deviation_pct": js_number_value(js_math_round(max_deviation * 100.0) / 100.0),
        "confidence": confidence,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn quote(provider: &str, price: f64) -> Json {
        json!({ "provider": provider, "price": price })
    }

    fn quotes_list(entries: &[Json]) -> Json {
        Json::Array(entries.to_vec())
    }

    #[test]
    fn median_matches_the_js_suite() {
        assert_eq!(median(&[42.0]).unwrap(), 42.0);
        assert_eq!(median(&[1.0, 3.0]).unwrap(), 2.0);
        assert_eq!(median(&[1.0, 5.0, 9.0]).unwrap(), 5.0);
        assert_eq!(median(&[9.0, 1.0, 5.0]).unwrap(), 5.0); // sorts unsorted input
        assert_eq!(
            median(&[]).unwrap_err(),
            "median requires at least one value"
        );
    }

    #[test]
    fn trimmed_mean_matches_the_js_suite() {
        // 2 values, trimPct 0.5 → trimCount = 1, 1*2 >= 2 → fallback to median
        assert_eq!(trimmed_mean(&[10.0, 20.0], 0.5).unwrap(), 15.0);
        // [1, 2, 3, 4, 100] with trimPct 0.2 → trimCount=1 → (2+3+4)/3
        assert_eq!(
            trimmed_mean(&[1.0, 2.0, 3.0, 4.0, 100.0], 0.2).unwrap(),
            3.0
        );
        assert_eq!(
            trimmed_mean(&[], 0.1).unwrap_err(),
            "trimmedMean requires at least one value"
        );
    }

    #[test]
    fn single_source_passthrough() {
        let result = aggregate_quotes(
            &quotes_list(&[quote("a", 100.0)]),
            AggregateOptions::default(),
        )
        .unwrap();
        assert_eq!(
            result,
            json!({
                "price": 100,
                "method": "single-source",
                "providers_used": ["a"],
                "providers_rejected": [],
                "deviation_pct": 0,
                "confidence": "single-source",
            })
        );
    }

    #[test]
    fn two_agreeing_sources_average() {
        let result = aggregate_quotes(
            &quotes_list(&[quote("a", 100.0), quote("b", 102.0)]),
            AggregateOptions::default(),
        )
        .unwrap();
        assert_eq!(result["price"], json!(101));
        assert_eq!(result["confidence"], json!("medium"));
        assert_eq!(result["method"], json!("mean"));
        // deviation (2/101)*100 = 1.980198… → Math.round(*100)/100
        assert_eq!(result["deviation_pct"], json!(1.98));
        assert_eq!(result["providers_used"], json!(["a", "b"]));
    }

    #[test]
    fn divergent_two_source_quotes_collapse_to_the_lower_price() {
        let result = aggregate_quotes(
            &quotes_list(&[quote("a", 100.0), quote("b", 200.0)]),
            AggregateOptions {
                max_deviation_pct: 25.0,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["confidence"], json!("low"));
        assert_eq!(result["providers_rejected"].as_array().unwrap().len(), 1);
        assert_eq!(result["price"], json!(100)); // the lower-priced one
        assert_eq!(result["method"], json!("two-source-divergent"));
    }

    #[test]
    fn three_agreeing_sources_take_the_median() {
        let result = aggregate_quotes(
            &quotes_list(&[quote("a", 100.0), quote("b", 101.0), quote("c", 102.0)]),
            AggregateOptions::default(),
        )
        .unwrap();
        assert_eq!(result["price"], json!(101));
        assert_eq!(result["confidence"], json!("high"));
        assert_eq!(result["method"], json!("median"));
    }

    #[test]
    fn outliers_above_max_deviation_are_rejected() {
        let result = aggregate_quotes(
            &quotes_list(&[
                quote("a", 100.0),
                quote("b", 101.0),
                quote("c", 102.0),
                quote("outlier", 500.0),
            ]),
            AggregateOptions {
                max_deviation_pct: 25.0,
                ..Default::default()
            },
        )
        .unwrap();
        let rejected: Vec<&str> = result["providers_rejected"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(rejected.contains(&"outlier"));
        let used: Vec<&str> = result["providers_used"]
            .as_array()
            .unwrap()
            .iter()
            .map(|v| v.as_str().unwrap())
            .collect();
        assert!(!used.contains(&"outlier"));
        assert_eq!(result["confidence"], json!("high"));
    }

    #[test]
    fn divergent_pair_below_three_sources_lands_low_confidence() {
        let result = aggregate_quotes(
            &quotes_list(&[quote("a", 1.0), quote("b", 1000.0)]),
            AggregateOptions {
                max_deviation_pct: 10.0,
                min_providers: 1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["confidence"], json!("low"));
    }

    #[test]
    fn trimmed_mean_method_is_selected_end_to_end() {
        let result = aggregate_quotes(
            &quotes_list(&[
                quote("a", 100.0),
                quote("b", 101.0),
                quote("c", 102.0),
                quote("d", 103.0),
                quote("e", 104.0),
            ]),
            AggregateOptions {
                method: "trimmed-mean",
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["method"], json!("trimmed-mean"));
        assert!(result["price"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn empty_quotes_and_short_provider_counts_error() {
        assert_eq!(
            aggregate_quotes(&quotes_list(&[]), AggregateOptions::default()).unwrap_err(),
            "aggregateQuotes requires at least one quote"
        );
        assert_eq!(
            aggregate_quotes(
                &quotes_list(&[quote("a", 100.0)]),
                AggregateOptions {
                    min_providers: 2,
                    ..Default::default()
                }
            )
            .unwrap_err(),
            "only 1 providers available, minimum 2 required"
        );
    }

    #[test]
    fn non_finite_prices_are_filtered_before_aggregating() {
        // JSON cannot carry JS `NaN`; the string "NaN" hits the same
        // Number.isFinite(Number(price)) filter branch.
        let result = aggregate_quotes(
            &quotes_list(&[
                quote("a", 100.0),
                json!({ "provider": "b", "price": "NaN" }),
            ]),
            AggregateOptions::default(),
        )
        .unwrap();
        assert_eq!(result["providers_used"].as_array().unwrap().len(), 1);
        assert_eq!(result["confidence"], json!("single-source"));
    }

    #[test]
    fn median_fallback_when_every_quote_is_rejected() {
        // 4 prices: median of [1,2,98,99] = (2+98)/2 = 50; all deviate >96% → all rejected
        let result = aggregate_quotes(
            &quotes_list(&[
                quote("a", 1.0),
                quote("b", 2.0),
                quote("c", 98.0),
                quote("d", 99.0),
            ]),
            AggregateOptions {
                max_deviation_pct: 0.1,
                ..Default::default()
            },
        )
        .unwrap();
        assert_eq!(result["method"], json!("median-fallback"));
        assert_eq!(result["price"], json!(50));
    }

    #[test]
    fn distinct_provider_counting_dedupes_ids() {
        let aggregation = json!({
            "providers_used": ["TwelveData", " twelvedata ", "binance", null, ""]
        });
        assert_eq!(count_distinct_providers(&aggregation), 2);
        assert_eq!(count_distinct_providers(&json!({})), 0);
        assert_eq!(count_distinct_providers(&json!(null)), 0);
        assert_eq!(count_distinct_providers(&json!([])), 0);
        assert!(meets_min_providers(&aggregation, 2));
        assert!(!meets_min_providers(&aggregation, 3));
        assert!(!meets_min_providers(&json!("x"), 0));
    }
}
