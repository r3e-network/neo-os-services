use crate::types::*;
use anyhow::Result;
use std::collections::HashMap;

pub struct IntentParser {
    // For now, rule-based parsing; LLM integration in Week 42
    patterns: HashMap<String, IntentPattern>,
}

struct IntentPattern {
    keywords: Vec<String>,
    intent_type: IntentType,
    action: Action,
}

impl IntentParser {
    pub fn new() -> Self {
        let mut patterns = HashMap::new();

        // Simple swap patterns
        patterns.insert(
            "simple_buy".to_string(),
            IntentPattern {
                keywords: vec!["buy".to_string(), "purchase".to_string()],
                intent_type: IntentType::Swap,
                action: Action::Buy,
            },
        );

        patterns.insert(
            "simple_sell".to_string(),
            IntentPattern {
                keywords: vec!["sell".to_string()],
                intent_type: IntentType::Swap,
                action: Action::Sell,
            },
        );

        Self { patterns }
    }

    /// Parse natural language intent into structured format
    pub async fn parse(&self, input: &str) -> Result<ParsedIntent> {
        let input_lower = input.to_lowercase();

        // Detect action
        let action = self.detect_action(&input_lower)?;

        // Detect assets
        let (from_asset, to_asset, amount) = self.extract_assets(&input_lower, &action)?;

        // Detect conditions
        let conditions = self.extract_conditions(&input_lower)?;

        // Determine intent type
        let intent_type = if conditions.is_some() {
            IntentType::Conditional
        } else {
            IntentType::Swap
        };

        // Extract constraints
        let constraints = self.extract_constraints(&input_lower)?;

        // Calculate confidence based on pattern matches
        let confidence = self.calculate_confidence(&input_lower, &action, &from_asset, &to_asset);

        Ok(ParsedIntent {
            intent_type,
            action,
            asset: Asset {
                from: from_asset,
                to: to_asset,
                amount: Some(amount),
                percentage: None,
            },
            conditions,
            constraints,
            confidence,
        })
    }

    fn detect_action(&self, input: &str) -> Result<Action> {
        if input.contains("buy") || input.contains("purchase") {
            Ok(Action::Buy)
        } else if input.contains("sell") {
            Ok(Action::Sell)
        } else if input.contains("rebalance") {
            Ok(Action::Rebalance)
        } else {
            anyhow::bail!("Could not detect action from input: {}", input)
        }
    }

    fn extract_assets(&self, input: &str, action: &Action) -> Result<(String, String, String)> {
        // Pattern: "buy X [amount] of [asset]" or "buy [amount] [asset]"
        // Pattern: "sell [amount] [asset]"

        let tokens: Vec<&str> = input.split_whitespace().collect();

        // Find amount (number, possibly with $ prefix)
        let amount = tokens
            .iter()
            .find_map(|t| {
                let cleaned = t.trim_start_matches('$').replace(",", "");
                cleaned.parse::<f64>().ok().map(|_| cleaned)
            })
            .ok_or_else(|| anyhow::anyhow!("No amount found"))?;

        // Find asset symbols
        let assets: Vec<&str> = tokens
            .iter()
            .filter(|t| self.is_asset_symbol(t))
            .copied()
            .collect();

        match action {
            Action::Buy => {
                // "buy 100 USDT of ETH" -> from: USDT, to: ETH
                if assets.len() >= 2 {
                    Ok((assets[0].to_uppercase(), assets[1].to_uppercase(), amount))
                } else if assets.len() == 1 {
                    // "buy 100 ETH" -> assume from USDT
                    Ok(("USDT".to_string(), assets[0].to_uppercase(), amount))
                } else {
                    anyhow::bail!("Could not extract assets")
                }
            }
            Action::Sell => {
                // "sell 10 ETH" -> from: ETH, to: USDT (default)
                if assets.len() >= 1 {
                    let to_asset = if assets.len() >= 2 { assets[1] } else { "USDT" };
                    Ok((assets[0].to_uppercase(), to_asset.to_uppercase(), amount))
                } else {
                    anyhow::bail!("Could not extract assets")
                }
            }
            Action::Rebalance => {
                anyhow::bail!("Rebalance not yet implemented")
            }
        }
    }

    fn extract_conditions(&self, input: &str) -> Result<Option<Conditions>> {
        if input.contains("when") || input.contains("if") {
            // Price condition: "when ETH < $3000"
            if let Some(price_cond) = self.extract_price_condition(input)? {
                return Ok(Some(Conditions {
                    price: Some(price_cond),
                    time: None,
                    portfolio: None,
                }));
            }
        }

        Ok(None)
    }

    fn extract_price_condition(&self, input: &str) -> Result<Option<PriceCondition>> {
        // Pattern: "when [asset] < $3000" or "if price < 3000"
        let operators = [("<", PriceOperator::LessThan), (">", PriceOperator::GreaterThan)];

        for (symbol, op) in &operators {
            if input.contains(symbol) {
                // Extract price value
                let parts: Vec<&str> = input.split(symbol).collect();
                if parts.len() >= 2 {
                    let cleaned = parts[1]
                        .trim()
                        .replace("$", "")
                        .replace(",", "");
                    let price_str = cleaned
                        .split_whitespace()
                        .next()
                        .unwrap_or("0");

                    return Ok(Some(PriceCondition {
                        operator: op.clone(),
                        value: price_str.to_string(),
                    }));
                }
            }
        }

        Ok(None)
    }

    fn extract_constraints(&self, _input: &str) -> Result<Constraints> {
        // Default constraints for now
        Ok(Constraints {
            max_slippage: "0.5%".to_string(),
            gas_limit: None,
            deadline: Some(300), // 5 minutes
        })
    }

    fn calculate_confidence(
        &self,
        input: &str,
        _action: &Action,
        from: &str,
        to: &str,
    ) -> f64 {
        let mut confidence: f64 = 0.5;

        // Increase confidence if we found clear patterns
        if input.contains("buy") || input.contains("sell") {
            confidence += 0.2;
        }

        if !from.is_empty() && !to.is_empty() {
            confidence += 0.2;
        }

        if input.split_whitespace().any(|t| t.parse::<f64>().is_ok()) {
            confidence += 0.1;
        }

        confidence.min(1.0)
    }

    fn is_asset_symbol(&self, token: &str) -> bool {
        let known_assets = [
            "eth", "btc", "neo", "gas", "usdt", "usdc", "dai", "bneo", "bnb",
        ];
        known_assets.contains(&token.to_lowercase().as_str())
    }
}

impl Default for IntentParser {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn test_simple_buy_intent() {
        let parser = IntentParser::new();
        let result = parser.parse("buy 100 USDT of ETH").await;

        assert!(result.is_ok());
        let intent = result.unwrap();
        assert!(matches!(intent.action, Action::Buy));
        assert_eq!(intent.asset.from, "USDT");
        assert_eq!(intent.asset.to, "ETH");
        assert_eq!(intent.asset.amount.unwrap(), "100");
        assert!(intent.confidence > 0.8);
    }

    #[tokio::test]
    async fn test_simple_sell_intent() {
        let parser = IntentParser::new();
        let result = parser.parse("sell 10 ETH").await;

        assert!(result.is_ok());
        let intent = result.unwrap();
        assert!(matches!(intent.action, Action::Sell));
        assert_eq!(intent.asset.from, "ETH");
        assert_eq!(intent.asset.to, "USDT");
        assert_eq!(intent.asset.amount.unwrap(), "10");
    }

    #[tokio::test]
    async fn test_conditional_buy() {
        let parser = IntentParser::new();
        let result = parser.parse("when ETH < 3000 buy 10 USDT of ETH").await;

        assert!(result.is_ok());
        let intent = result.unwrap();
        assert!(matches!(intent.intent_type, IntentType::Conditional));
        assert!(intent.conditions.is_some());

        let conditions = intent.conditions.unwrap();
        assert!(conditions.price.is_some());

        let price = conditions.price.unwrap();
        assert_eq!(price.value, "3000");
        assert!(matches!(price.operator, PriceOperator::LessThan));
    }

    #[tokio::test]
    async fn test_buy_with_dollar_sign() {
        let parser = IntentParser::new();
        let result = parser.parse("buy $100 of ETH").await;

        assert!(result.is_ok());
        let intent = result.unwrap();
        assert_eq!(intent.asset.amount.unwrap(), "100");
    }

    #[tokio::test]
    async fn test_invalid_input() {
        let parser = IntentParser::new();
        let result = parser.parse("hello world").await;

        assert!(result.is_err());
    }
}
