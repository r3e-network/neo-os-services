use serde::{Deserialize, Serialize};
use std::collections::HashMap;

/// Parsed intent from natural language input
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ParsedIntent {
    pub intent_type: IntentType,
    pub action: Action,
    pub asset: Asset,
    pub conditions: Option<Conditions>,
    pub constraints: Constraints,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IntentType {
    Swap,
    Limit,
    Conditional,
    Schedule,
    Strategy,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Action {
    Buy,
    Sell,
    Rebalance,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Asset {
    pub from: String,
    pub to: String,
    pub amount: Option<String>,
    pub percentage: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Conditions {
    pub price: Option<PriceCondition>,
    pub time: Option<TimeCondition>,
    pub portfolio: Option<PortfolioCondition>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PriceCondition {
    pub operator: PriceOperator,
    pub value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum PriceOperator {
    LessThan,
    GreaterThan,
    Equal,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeCondition {
    pub schedule: String, // cron format
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortfolioCondition {
    pub target: HashMap<String, f64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Constraints {
    pub max_slippage: String,
    pub gas_limit: Option<String>,
    pub deadline: Option<u64>,
}

/// Execution plan for an intent
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    pub routes: Vec<Route>,
    pub estimated_price: String,
    pub estimated_gas: String,
    pub slippage: String,
    pub confidence: Confidence,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Route {
    pub dex: String,
    pub path: Vec<String>,
    pub amount_in: String,
    pub amount_out: String,
    pub price_impact: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Confidence {
    High,
    Medium,
    Low,
}

/// DEX quote for routing
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DexQuote {
    pub dex: String,
    pub price: String,
    pub amount_out: String,
    pub gas_estimate: String,
    pub timestamp: i64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_parsed_intent_serialization() {
        let intent = ParsedIntent {
            intent_type: IntentType::Swap,
            action: Action::Buy,
            asset: Asset {
                from: "USDT".to_string(),
                to: "ETH".to_string(),
                amount: Some("100".to_string()),
                percentage: None,
            },
            conditions: None,
            constraints: Constraints {
                max_slippage: "0.5%".to_string(),
                gas_limit: None,
                deadline: Some(300),
            },
            confidence: 0.95,
        };

        let json = serde_json::to_string(&intent).unwrap();
        let deserialized: ParsedIntent = serde_json::from_str(&json).unwrap();

        assert_eq!(deserialized.confidence, 0.95);
        assert_eq!(deserialized.asset.from, "USDT");
    }

    #[test]
    fn test_conditional_intent() {
        let intent = ParsedIntent {
            intent_type: IntentType::Conditional,
            action: Action::Buy,
            asset: Asset {
                from: "USDT".to_string(),
                to: "ETH".to_string(),
                amount: Some("10".to_string()),
                percentage: None,
            },
            conditions: Some(Conditions {
                price: Some(PriceCondition {
                    operator: PriceOperator::LessThan,
                    value: "3000".to_string(),
                }),
                time: None,
                portfolio: None,
            }),
            constraints: Constraints {
                max_slippage: "1%".to_string(),
                gas_limit: None,
                deadline: None,
            },
            confidence: 0.90,
        };

        assert!(intent.conditions.is_some());
        let conditions = intent.conditions.unwrap();
        assert!(conditions.price.is_some());
    }
}
