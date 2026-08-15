// The on-chain callback method names the MorpheusOracle kernel dispatches to a requester's
// callback contract. These are the SINGLE SOURCE for off-chain JS/TS consumers (relayer
// dispatch, web request builders). The contracts themselves (Neo C# + EVM Solidity) define
// the golden literals and CANNOT import from here; a cross-language test pins the values.
//
// Golden literals (must stay byte-identical):
//   Neo C# MorpheusOracle.cs: CALLBACK_METHOD = "onMiniAppResult"
//                            LEGACY_CALLBACK_METHOD = "onOracleResult"
//   EVM MorpheusOracleEVM.sol: abi signature "onOracleResult(uint256,string,bool,bytes,string)"
//
// Rationale (Round-2 R2-3.2): these strings appeared as raw literals in ~48 files (relayer
// dispatch, 11 web components/docs, examples, scripts). A rename was an unbounded multi-
// layer edit with no compiler catching a miss. Centralizing the off-chain values bounds
// that; the contract literals stay as the cross-checked golden value.

/** Rich callback: carries appId + moduleId + operation + requester (8 args). The kernel's
 *  preferred dispatch (falls back to LEGACY_CALLBACK_METHOD if the consumer lacks it). */
export const CALLBACK_METHOD = 'onMiniAppResult';

/** Legacy 5-arg callback kept for already-deployed consumers. The relayer submits a request
 *  with this as the callback method when the consumer implements only the legacy ABI. */
export const LEGACY_CALLBACK_METHOD = 'onOracleResult';
