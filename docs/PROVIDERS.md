# Providers

NeoOS Oracle supports two provider modes:

- **Built-in providers** — selected by `provider` and configured per project in Supabase
- **Custom source requests** — user-supplied `url`, optional encrypted token/payload, and optional compute script

Current production architecture:

- provider configuration and project defaults are resolved outside the TEE first when possible
- the Oracle runtime executes only the confidential fetch or compute step
- DataFeed publication uses the same provider registry model but a separate runtime lane

## Built-in Providers

Current built-ins:

- `twelvedata`
- `binance-spot`
- `coinbase-spot`

Built-ins are intentionally **raw**:

- no aggregation
- no smoothing
- no medianization
- no extra normalization beyond provider-specific request formatting and response extraction

### TwelveData

Required env:

- `TWELVEDATA_API_KEY`

Typical config:

```json
{
  "symbol": "NEO-USD",
  "endpoint": "price",
  "interval": "1min"
}
```

### Binance Spot

Required env:

- none

Typical config:

```json
{
  "pair": "NEO-USD",
  "symbol": "NEOUSDT",
  "base_url": "https://api1.binance.com"
}
```

### Coinbase Spot

Required env:

- none

Typical config:

```json
{
  "symbol": "NEO-USD"
}
```

## Provider Config Control Plane

Project-level provider configs are stored in `morpheus_provider_configs`.

Management endpoint:

- `GET /api/provider-configs?project_slug=morpheus`
- `POST /api/provider-configs`
- `DELETE /api/provider-configs?project_slug=morpheus&provider_id=twelvedata`

Recommended production protection:

- set `MORPHEUS_PROVIDER_CONFIG_API_KEY`
- send it via `x-admin-api-key` or `Authorization: Bearer ...`

The dashboard includes a Provider Configs panel that can manage these records directly.

## Request-Time Resolution

Both the web API layer and the Oracle runtime can resolve provider defaults from Supabase when `project_slug` and `provider` are present.

The web API layer resolves provider defaults **before** proxying to the Nitro runtime:

- `GET /api/feeds/:symbol?provider=twelvedata&project_slug=morpheus`
- `POST /api/oracle/query` with `{ "provider": "twelvedata", "project_slug": "morpheus" }`
- `POST /api/oracle/smart-fetch` with the same fields

Resolution rules:

- request-level `provider_params` override stored project config keys
- stored project config fills in missing provider defaults
- disabled project providers are rejected before the request reaches the Nitro runtime

## Custom Source Requests

Users can bypass built-ins and send direct Oracle requests with:

- `url`
- optional `encrypted_token` or `encrypted_payload`
- optional `script` or `script_base64`

This supports three useful modes:

- **plain fetch** — URL only
- **fetch + compute** — URL plus script
- **private fetch + compute** — URL plus encrypted payload plus script

## PriceFeed Pair Catalog

Default built-in USD pairs now cover:

- Core crypto:
  - `TWELVEDATA:NEO-USD`
  - `TWELVEDATA:GAS-USD`
  - `TWELVEDATA:BTC-USD`
  - `TWELVEDATA:ETH-USD`
  - `TWELVEDATA:SOL-USD`
  - `TWELVEDATA:TRX-USD`
  - `TWELVEDATA:BNB-USD`
  - `TWELVEDATA:XRP-USD`
  - `TWELVEDATA:DOGE-USD`
  - `TWELVEDATA:USDT-USD`
  - `TWELVEDATA:USDC-USD`
- Commodity / hard-asset:
  - `TWELVEDATA:PAXG-USD`
  - `TWELVEDATA:WTI-USD`
  - `TWELVEDATA:BRENT-USD`
  - `TWELVEDATA:NATGAS-USD`
  - `TWELVEDATA:WHEAT-USD`
  - `TWELVEDATA:CORN-USD`
  - `TWELVEDATA:SOY-USD`
- Equities / ETFs:
  - `TWELVEDATA:AAPL-USD`
  - `TWELVEDATA:GOOGL-USD`
  - `TWELVEDATA:MSFT-USD`
  - `TWELVEDATA:AMZN-USD`
  - `TWELVEDATA:TSLA-USD`
  - `TWELVEDATA:META-USD`
  - `TWELVEDATA:NVDA-USD`
  - `TWELVEDATA:SPY-USD`
  - `TWELVEDATA:QQQ-USD`
  - `TWELVEDATA:GLD-USD`
- FX:
  - `TWELVEDATA:EUR-USD`
  - `TWELVEDATA:GBP-USD`
  - `TWELVEDATA:JPY-USD` (inverted from `USD/JPY`)
  - `TWELVEDATA:CNY-USD` (inverted from `USD/CNY`)

Production sync defaults to `twelvedata` only. Other built-in providers remain available for Oracle fetch flows and project-specific overrides.

Inspect at runtime with:

- `GET /api/feeds/catalog`
- or worker `GET /feeds/catalog`

On-chain storage is provider-scoped, for example:

- `TWELVEDATA:NEO-USD`
- `BINANCE-SPOT:NEO-USD`

### Canonical pair table

Use these names exactly in contracts, automation jobs, and documentation.
The canonical key format is provider-scoped. For the current main catalog, `TWELVEDATA:<PAIR>` is the official storage key and user-facing key.

| Pair                    | Category  | Meaning                                 | TwelveData symbol | On-chain unit                      | Note                                |
| ----------------------- | --------- | --------------------------------------- | ----------------- | ---------------------------------- | ----------------------------------- |
| `TWELVEDATA:NEO-USD`    | Crypto    | price of 1 NEO in USD                   | `NEO/USD`         | `1 NEO`                            |                                     |
| `TWELVEDATA:GAS-USD`    | Crypto    | price of 1 GAS in USD                   | `GAS/USD`         | `1 GAS`                            |                                     |
| `TWELVEDATA:BTC-USD`    | Crypto    | price of 1 BTC in USD                   | `BTC/USD`         | `1 BTC`                            |                                     |
| `TWELVEDATA:ETH-USD`    | Crypto    | price of 1 ETH in USD                   | `ETH/USD`         | `1 ETH`                            |                                     |
| `TWELVEDATA:SOL-USD`    | Crypto    | price of 1 SOL in USD                   | `SOL/USD`         | `1 SOL`                            |                                     |
| `TWELVEDATA:TRX-USD`    | Crypto    | price of 1 TRX in USD                   | `TRX/USD`         | `1 TRX`                            |                                     |
| `TWELVEDATA:PAXG-USD`   | Crypto    | price of 1 PAXG in USD                  | `PAXG/USD`        | `1 PAXG`                           | gold-backed token                   |
| `TWELVEDATA:USDT-USD`   | Crypto    | price of 1 USDT in USD                  | `USDT/USD`        | `1 USDT`                           |                                     |
| `TWELVEDATA:USDC-USD`   | Crypto    | price of 1 USDC in USD                  | `USDC/USD`        | `1 USDC`                           |                                     |
| `TWELVEDATA:BNB-USD`    | Crypto    | price of 1 BNB in USD                   | `BNB/USD`         | `1 BNB`                            |                                     |
| `TWELVEDATA:XRP-USD`    | Crypto    | price of 1 XRP in USD                   | `XRP/USD`         | `1 XRP`                            |                                     |
| `TWELVEDATA:DOGE-USD`   | Crypto    | price of 1 DOGE in USD                  | `DOGE/USD`        | `1 DOGE`                           |                                     |
| `TWELVEDATA:WTI-USD`    | Commodity | WTI crude oil spot, USD per barrel      | `WTI/USD`         | `1 barrel`                         |                                     |
| `TWELVEDATA:BRENT-USD`  | Commodity | Brent crude spot, USD per barrel        | `XBR/USD`         | `1 barrel`                         |                                     |
| `TWELVEDATA:NATGAS-USD` | Commodity | natural gas, USD per MMBtu              | `NG/USD`          | `1 MMBtu`                          |                                     |
| `TWELVEDATA:WHEAT-USD`  | Commodity | CBOT wheat front-month, US cents/bushel | `W_1`             | `1 bushel (US cents)`              | front-month futures                 |
| `TWELVEDATA:CORN-USD`   | Commodity | CBOT corn front-month, US cents/bushel  | `C_1`             | `1 bushel (US cents)`              | front-month futures, NOT the `CORN` ETF |
| `TWELVEDATA:SOY-USD`    | Commodity | CBOT soybean front-month, US cents/bu   | `S_1`             | `1 bushel (US cents)`              | front-month futures                 |
| `TWELVEDATA:AAPL-USD`   | Equity    | price of 1 AAPL share in USD            | `AAPL`            | `1 share`                          |                                     |
| `TWELVEDATA:GOOGL-USD`  | Equity    | price of 1 GOOGL share in USD           | `GOOGL`           | `1 share`                          |                                     |
| `TWELVEDATA:MSFT-USD`   | Equity    | price of 1 MSFT share in USD            | `MSFT`            | `1 share`                          |                                     |
| `TWELVEDATA:AMZN-USD`   | Equity    | price of 1 AMZN share in USD            | `AMZN`            | `1 share`                          |                                     |
| `TWELVEDATA:TSLA-USD`   | Equity    | price of 1 TSLA share in USD            | `TSLA`            | `1 share`                          |                                     |
| `TWELVEDATA:META-USD`   | Equity    | price of 1 META share in USD            | `META`            | `1 share`                          |                                     |
| `TWELVEDATA:NVDA-USD`   | Equity    | price of 1 NVDA share in USD            | `NVDA`            | `1 share`                          |                                     |
| `SPY-USD`               | ETF       | price of 1 SPY share in USD             | `SPY`             | `1 ETF share`                      |                                     |
| `QQQ-USD`               | ETF       | price of 1 QQQ share in USD             | `QQQ`             | `1 ETF share`                      |                                     |
| `GLD-USD`               | ETF       | price of 1 GLD share in USD             | `GLD`             | `1 ETF share`                      |                                     |
| `EUR-USD`               | FX        | price of 1 EUR in USD                   | `EUR/USD`         | `1 EUR`                            |                                     |
| `GBP-USD`               | FX        | price of 1 GBP in USD                   | `GBP/USD`         | `1 GBP`                            |                                     |
| `TWELVEDATA:JPY-USD`    | FX        | price of 1 JPY in USD                   | `USD/JPY`         | `1 JPY`                            | fetched as `USD/JPY`, then inverted |
| `CNY-USD`               | FX        | price of 1 CNY in USD                   | `USD/CNY`         | `1 CNY`                            | fetched as `USD/CNY`, then inverted |

## Selection Model

- **PriceFeed** can use a built-in provider directly
- **Privacy Oracle** can use either a built-in provider or a custom URL flow
- **Provider configs** let each project pin defaults without hardcoding them into requests
