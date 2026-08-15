---
wave: 2
depends_on: []
files_modified: []
autonomous: true
---

# Plan 04-03: Evaluate solc Upgrade to Latest 0.8.x

## Goal

Assess whether the Solidity contracts in `contracts-evm/` can be upgraded from the pinned `solc 0.8.24` to the latest 0.8.x release without breaking changes, and if safe, perform the upgrade.

## Context

- `contracts-evm/` currently pins `solc 0.8.24`.
- The roadmap noted this is a P2 suggestion; no immediate security or feature blocker.
- An upgrade could bring bug fixes, gas optimizations, and improved diagnostics, but also risks new compiler warnings or subtle semantic changes.

## Tasks

<task id="1" name="Identify current solc version and lockfile locations">
Find where `solc` 0.8.24 is pinned (package.json, foundry.toml, hardhat.config, CI, etc.). Document the exact files and commands used to compile and test EVM contracts.

<verify>
- List all files that reference `0.8.24` or `solc` version.
- Identify the test command for `contracts-evm`.
</verify>
</task>

<task id="2" name="Determine latest stable 0.8.x release">
Find the latest stable Solidity 0.8.x release (use web search or check npm/foundry releases). Note any relevant release notes, breaking changes, or required pragma adjustments.

<verify>
- Record the candidate version number.
- Summarize notable changes for 0.8.24 → latest 0.8.x that might affect the codebase.
</verify>
</task>

<task id="3" name="Attempt upgrade in isolated branch / files">
Update the compiler pin to the latest 0.8.x version. Run the EVM contract test suite and lint/static analysis if available. Capture any new warnings or errors.

<verify>
- `contracts-evm` tests pass after upgrade, or a list of blockers is documented.
- No new high-severity compiler warnings remain unaddressed.
</verify>
</task>

<task id="4" name="Document decision and update configuration">
If tests pass, commit the version bump and update any docs. If tests fail or blockers exist, document the findings in the plan summary and recommend whether to proceed, pin a newer known-good version, or defer.

<verify>
- Configuration files and docs reflect the final decision.
- Test count and result are recorded in the summary.
</verify>
</task>

## must_haves

- [ ] Current solc pinning and build/test commands are documented.
- [ ] Candidate latest 0.8.x version is identified with release-note summary.
- [ ] EVM contract tests are run against the candidate version.
- [ ] Final decision (upgrade / defer / partial upgrade) is documented.
- [ ] No broken contract tests remain.
