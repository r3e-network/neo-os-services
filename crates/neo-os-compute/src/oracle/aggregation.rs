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

/// `twap(samples, window)` — the time-weighted average price over an observation
/// window. Each sample is a `(timestamp, price)` pair; the timestamps may be in
/// any unit (seconds, milliseconds, block height) as long as `window` uses the
/// same unit.
///
/// The samples are sorted into a deterministic order — timestamp first, then
/// price as a stable secondary key — so unordered input is handled and an
/// identical logical set of samples always yields an identical TWAP regardless
/// of the order it arrives in (a canonical oracle price must be reproducible).
/// Each price is weighted by the duration it was the prevailing price: from its
/// own timestamp until the next sample's timestamp, or until the end of the
/// window for the last sample. `window` is the total span measured forward from
/// the earliest timestamp; every duration is clamped to `[earliest, earliest +
/// window]`, so samples that fall on or beyond the window edge contribute no
/// weight and a `window` shorter than the sample span truncates the tail. A
/// non-positive `window` leaves the last sample with no forward duration (the
/// classic TWAP where only the intervals between fills count).
///
/// Returns `Σ(price·duration) / Σ(duration)`. When the total duration collapses
/// to zero — a single sample, every sample sharing one timestamp, or a window
/// that ends at the earliest sample — the samples carry equal weight and the
/// plain mean of the prices is returned, so the result degrades gracefully
/// instead of dividing by zero.
///
/// Input validation: `window` must be finite and every sample's timestamp and
/// price must be finite. A NaN or infinite price/timestamp would poison the
/// weighted sum and let a caller force a bogus canonical price, so it is
/// rejected rather than propagated; this function never returns `Ok(NaN)` or
/// `Ok(Inf)`. Negative prices are permitted, matching [`median`] and
/// [`aggregate_quotes`], which reject only non-finite values.
///
/// Integration point: [`aggregate_quotes`] receives a flat list of *concurrent*
/// provider quotes (`price` + `provider`, no timestamps), so TWAP is not a
/// drop-in arm of [`AggregateOptions::method`]. The natural wiring, once quotes
/// carry a per-sample timestamp, is the `method == "trimmed-mean"` dispatch in
/// the 3+ branch of [`aggregate_quotes`]: a `method == "twap"` arm would build
/// `(timestamp, price)` pairs from the kept quotes and call this function.
pub fn twap(samples: &[(f64, f64)], window: f64) -> Result<f64, String> {
    if samples.is_empty() {
        return Err("twap requires at least one sample".to_string());
    }
    if !window.is_finite() {
        return Err("twap requires a finite window".to_string());
    }
    // Reject non-finite timestamps/prices before they can poison the weighted
    // sum: NaN or +/-Inf here would surface as a bogus Ok(NaN)/Ok(Inf) price.
    for &(timestamp, price) in samples {
        if !timestamp.is_finite() {
            return Err("twap sample timestamp must be finite".to_string());
        }
        if !price.is_finite() {
            return Err("twap sample price must be finite".to_string());
        }
    }

    // Deterministic order: timestamp first, then price as a stable secondary key
    // so tied timestamps resolve identically for any input permutation.
    let mut sorted = samples.to_vec();
    sorted.sort_by(|a, b| a.0.total_cmp(&b.0).then_with(|| a.1.total_cmp(&b.1)));

    // Equal-weight mean of the (finite) prices — the graceful fallback whenever
    // there is no usable duration information. Always finite.
    let mean = || sorted.iter().map(|&(_, price)| price).sum::<f64>() / sorted.len() as f64;

    // All timestamps identical → no duration information; equal-weight mean.
    let start = sorted[0].0;
    let last = sorted[sorted.len() - 1].0;
    if start == last {
        return Ok(mean());
    }

    let window_end = if window > 0.0 { start + window } else { start };

    let mut weighted_sum = 0.0f64;
    let mut total_weight = 0.0f64;
    for (i, &(timestamp, price)) in sorted.iter().enumerate() {
        // The price holds until the next sample, or until the window edge for the
        // last sample; both ends are clamped to the window so out-of-window tails
        // contribute nothing.
        let next = if i + 1 < sorted.len() {
            sorted[i + 1].0
        } else if window > 0.0 {
            window_end
        } else {
            timestamp
        };
        let end_time = if window > 0.0 {
            next.min(window_end)
        } else {
            next
        };
        let duration = (end_time - timestamp).max(0.0);
        weighted_sum += price * duration;
        total_weight += duration;
    }

    // A positive, finite weighted sum gives the time-weighted result; otherwise
    // (zero total duration, or a pathological window_end overflow to Inf) fall
    // back to the finite equal-weight mean so we never return NaN/Inf.
    if total_weight > 0.0 && weighted_sum.is_finite() {
        return Ok(weighted_sum / total_weight);
    }
    Ok(mean())
}

/// `slippage(expected, executed)` — the signed percentage difference between the
/// price a trade expected and the price it actually executed at:
/// `(executed - expected) / expected * 100`. A positive result means the fill was
/// worse than expected (paid more), a negative result means it was better.
///
/// This is a *trade-execution* metric and is deliberately distinct from the
/// `deviation_pct` outlier guard emitted by [`aggregate_quotes`], which measures
/// the spread among concurrent provider quotes rather than an executed fill
/// against its expectation.
///
/// Input validation: `expected` must be finite and strictly positive (a zero or
/// negative expectation has no defined percentage slippage and would divide by
/// zero or flip the sign), and `executed` must be finite and non-negative.
/// NaN/infinite inputs are rejected rather than propagated: a `NaN` slippage
/// would silently pass any `slippage > max_slippage` guard (NaN comparisons are
/// always false), so this function never returns `Ok(NaN)` or `Ok(Inf)`.
pub fn slippage(expected: f64, executed: f64) -> Result<f64, String> {
    if !expected.is_finite() || expected <= 0.0 {
        return Err("slippage requires a finite, positive expected price".to_string());
    }
    if !executed.is_finite() || executed < 0.0 {
        return Err("slippage requires a finite, non-negative executed price".to_string());
    }
    Ok((executed - expected) / expected * 100.0)
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

    #[test]
    fn twap_errors_on_empty_samples() {
        assert_eq!(
            twap(&[], 60.0).unwrap_err(),
            "twap requires at least one sample"
        );
    }

    #[test]
    fn twap_single_sample_returns_that_price() {
        // No forward duration exists, so the equal-weight fallback returns the
        // lone price regardless of window.
        assert_eq!(twap(&[(0.0, 42.0)], 60.0).unwrap(), 42.0);
        assert_eq!(twap(&[(5.0, 99.5)], 0.0).unwrap(), 99.5);
    }

    #[test]
    fn twap_equal_time_weights_reduces_to_the_mean() {
        // Two samples equally spaced across a window twice the gap: price 100
        // holds for [0,10) and price 200 holds for [10,20) → equal weight → 150.
        assert_eq!(twap(&[(0.0, 100.0), (10.0, 200.0)], 20.0).unwrap(), 150.0);
    }

    #[test]
    fn twap_weights_each_price_by_its_duration() {
        // price 100 valid for 30 units [0,30), price 400 valid for 10 units
        // [30,40) → (100·30 + 400·10) / 40 = 7000/40 = 175.
        assert_eq!(twap(&[(0.0, 100.0), (30.0, 400.0)], 40.0).unwrap(), 175.0);
    }

    #[test]
    fn twap_sorts_unordered_samples_by_timestamp() {
        // Same data as twap_weights_each_price_by_its_duration but shuffled; the
        // result must be identical because samples are sorted by timestamp.
        let shuffled = [(30.0, 400.0), (0.0, 100.0)];
        assert_eq!(twap(&shuffled, 40.0).unwrap(), 175.0);
    }

    #[test]
    fn twap_window_boundary_truncates_the_tail() {
        // window ends at 10, so the price-200 sample at t=10 lands on the edge and
        // contributes zero duration; only price 100 over [0,10) counts.
        assert_eq!(twap(&[(0.0, 100.0), (10.0, 200.0)], 10.0).unwrap(), 100.0);
        // A window shorter than the span truncates the second sample's interval:
        // price 100 over [0,3) and price 200 over [3,5) → (100·3 + 200·2)/5 = 140.
        assert_eq!(twap(&[(0.0, 100.0), (3.0, 200.0)], 5.0).unwrap(), 140.0);
    }

    #[test]
    fn twap_non_positive_window_uses_intervals_only() {
        // window <= 0 gives the last sample no forward duration; only the gap
        // between the two samples counts, so price 100 over [0,10) → 100.
        assert_eq!(twap(&[(0.0, 100.0), (10.0, 200.0)], 0.0).unwrap(), 100.0);
    }

    #[test]
    fn twap_identical_timestamps_fall_back_to_the_mean() {
        // Total duration collapses to zero → equal-weight mean of the prices.
        assert_eq!(
            twap(&[(5.0, 100.0), (5.0, 200.0), (5.0, 300.0)], 60.0).unwrap(),
            200.0
        );
    }

    #[test]
    fn twap_handles_zero_and_negative_prices() {
        // price 0 over [0,10) and price -50 over [10,20) → (0·10 + -50·10)/20 = -25.
        assert_eq!(twap(&[(0.0, 0.0), (10.0, -50.0)], 20.0).unwrap(), -25.0);
    }

    #[test]
    fn slippage_is_positive_when_the_fill_is_worse() {
        // Executed above expected → paid more → positive slippage.
        assert_eq!(slippage(100.0, 105.0).unwrap(), 5.0);
    }

    #[test]
    fn slippage_is_negative_when_the_fill_is_better() {
        // Executed below expected → paid less → negative slippage.
        assert_eq!(slippage(100.0, 95.0).unwrap(), -5.0);
    }

    #[test]
    fn slippage_of_an_exact_fill_is_zero() {
        assert_eq!(slippage(100.0, 100.0).unwrap(), 0.0);
    }

    #[test]
    fn slippage_rejects_a_zero_expected_price() {
        // Divide-by-zero is rejected rather than yielding inf/NaN.
        assert_eq!(
            slippage(0.0, 100.0).unwrap_err(),
            "slippage requires a finite, positive expected price"
        );
        assert_eq!(
            slippage(0.0, 0.0).unwrap_err(),
            "slippage requires a finite, positive expected price"
        );
    }

    #[test]
    fn slippage_handles_a_zero_executed_price() {
        // A fill to zero is a total loss → -100%.
        assert_eq!(slippage(100.0, 0.0).unwrap(), -100.0);
    }

    #[test]
    fn twap_rejects_a_nan_price_sample() {
        // A NaN price would poison the weighted sum and surface as Ok(NaN).
        assert_eq!(
            twap(&[(0.0, f64::NAN), (10.0, 100.0)], 20.0).unwrap_err(),
            "twap sample price must be finite"
        );
    }

    #[test]
    fn twap_rejects_an_infinite_price_sample() {
        assert_eq!(
            twap(&[(0.0, f64::INFINITY), (10.0, 200.0)], 20.0).unwrap_err(),
            "twap sample price must be finite"
        );
        assert_eq!(
            twap(&[(0.0, 100.0), (10.0, f64::NEG_INFINITY)], 20.0).unwrap_err(),
            "twap sample price must be finite"
        );
    }

    #[test]
    fn twap_rejects_a_non_finite_timestamp() {
        assert_eq!(
            twap(&[(f64::NAN, 100.0), (10.0, 200.0)], 20.0).unwrap_err(),
            "twap sample timestamp must be finite"
        );
    }

    #[test]
    fn twap_rejects_an_infinite_window() {
        // The HIGH 'infinite window -> NaN' finding: window must be finite.
        assert_eq!(
            twap(&[(0.0, 100.0), (10.0, 200.0)], f64::INFINITY).unwrap_err(),
            "twap requires a finite window"
        );
        assert_eq!(
            twap(&[(0.0, 100.0), (10.0, 200.0)], f64::NAN).unwrap_err(),
            "twap requires a finite window"
        );
    }

    #[test]
    fn twap_never_returns_nan_or_inf_on_the_documented_repro() {
        // Both empirical repros from the review must now be rejected, not Ok(NaN).
        assert!(twap(&[(0.0, f64::NAN), (10.0, 100.0)], 20.0).is_err());
        assert!(twap(&[(0.0, f64::INFINITY), (10.0, 200.0)], f64::INFINITY).is_err());
    }

    #[test]
    fn twap_allows_negative_prices_per_the_crate_convention() {
        // median/aggregate_quotes reject only non-finite values, so negatives are
        // permitted here too; a fully negative series stays negative and finite.
        let result = twap(&[(0.0, -100.0), (10.0, -50.0)], 20.0).unwrap();
        assert!(result.is_finite() && result < 0.0);
    }

    #[test]
    fn twap_is_deterministic_across_tied_timestamp_input_orders() {
        // Mid-list tie at t=5: the SAME logical sample set in ANY input order must
        // produce the SAME twap (price is the stable secondary sort key).
        let ascending = [(0.0, 100.0), (5.0, 200.0), (5.0, 300.0)];
        let descending = [(0.0, 100.0), (5.0, 300.0), (5.0, 200.0)];
        let a = twap(&ascending, 10.0).unwrap();
        let b = twap(&descending, 10.0).unwrap();
        assert_eq!(a, b);
        // The tie resolves to the higher price (300) holding the forward interval
        // [5,10): (100·5 + 300·5) / 10 = 200.
        assert_eq!(a, 200.0);
    }

    #[test]
    fn slippage_rejects_a_nan_expected_price() {
        // NaN expected must not slip through as Ok(NaN) (which would pass any
        // `slippage > max` guard because NaN comparisons are always false).
        assert_eq!(
            slippage(f64::NAN, 100.0).unwrap_err(),
            "slippage requires a finite, positive expected price"
        );
    }

    #[test]
    fn slippage_rejects_a_negative_expected_price() {
        assert_eq!(
            slippage(-100.0, 105.0).unwrap_err(),
            "slippage requires a finite, positive expected price"
        );
    }

    #[test]
    fn slippage_rejects_an_infinite_executed_price() {
        assert_eq!(
            slippage(100.0, f64::INFINITY).unwrap_err(),
            "slippage requires a finite, non-negative executed price"
        );
        assert_eq!(
            slippage(100.0, f64::NAN).unwrap_err(),
            "slippage requires a finite, non-negative executed price"
        );
    }

    #[test]
    fn slippage_rejects_a_negative_executed_price() {
        assert_eq!(
            slippage(100.0, -1.0).unwrap_err(),
            "slippage requires a finite, non-negative executed price"
        );
    }
}
