# WinUSDT — lottery contracts (BNB Chain)

Verified smart contracts, deployment scripts and the test suite behind
[winusdt.io](https://www.winusdt.io) — a provably fair on-chain lottery with a
"fill-or-refund" model on BNB Chain.

## Contracts (BSC mainnet, verified)

| Tier | Address |
|---|---|
| 5 USDT | [0xab3DB18131b21a1758EF5fb16fc157e7604E2a71](https://bscscan.com/address/0xab3DB18131b21a1758EF5fb16fc157e7604E2a71) |
| 10 USDT | [0x165D7A1bAFAb74aa1fB595ab09633475264BE46D](https://bscscan.com/address/0x165D7A1bAFAb74aa1fB595ab09633475264BE46D) |
| 25 USDT | [0xc6E473eaf7118Fa10397bE263C251084010d4ED6](https://bscscan.com/address/0xc6E473eaf7118Fa10397bE263C251084010d4ED6) |

## How fairness works

A round collects up to 10 players for one hour. When the **last ticket** is
sold, the randomness seed is locked to `blockhash(fillBlock)` — a value that
does not exist while tickets are being bought, so nobody can predict or
simulate an outcome. After a 20-block delay (~15 s) anyone can trigger the
draw — it's permissionless, there is no admin key. If a round doesn't fill
within its window, anyone can trigger a **100% refund** — permissionless,
fee-free, paid by the contract itself.

The adversarial replay suite (`contracts/SniperBots.sol`) contains hostile
strategies from the V1 era — atomic "buy → draw → revert if lost" attacks —
and the test suite verifies they are **blocked** on V2.

## Repository layout

```
contracts/FlexibleLottery.sol   # V1 (kept for history — vulnerable, retired)
contracts/FlexibleLotteryV2.sol # V2 (active on mainnet)
contracts/SniperBots.sol        # adversarial replay suite
test/v2.test.cjs                # 5 tests incl. the adversarial replay
scripts/                        # deploy, smoke checks, keeper helpers
```

## Run the tests

```bash
npm install
npx hardhat test test/v2.test.cjs
```

## Fee model

One winner receives **95%** of the pool; a fixed **5%** is the creator fee,
transferred automatically inside the winner's claim transaction. Refunds are
100% and fee-free. The contracts never accept BNB.

---

18+. Gambling involves risk — losses are expected and the house edge is 5%.
Not available in restricted jurisdictions. Play responsibly.
