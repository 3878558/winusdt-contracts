# WinUSDT — lottery & slots contracts (BNB Chain)

Verified smart contracts, deployment scripts and the test suite behind
[winusdt.io](https://www.winusdt.io) — a provably fair on-chain lottery with a
"fill-or-refund" model, plus **Slots PvC** — a player-vs-casino slot machine
where anyone can be the house (LP).

## Contracts (BSC mainnet, verified)

| Game | Contract | Address |
|---|---|---|
| Lottery 5 USDT | FlexibleLottery | [0xab3DB18131b21a1758EF5fb16fc157e7604E2a71](https://bscscan.com/address/0xab3DB18131b21a1758EF5fb16fc157e7604E2a71) |
| Lottery 10 USDT | FlexibleLottery | [0x165D7A1bAFAb74aa1fB595ab09633475264BE46D](https://bscscan.com/address/0x165D7A1bAFAb74aa1fB595ab09633475264BE46D) |
| Lottery 25 USDT | FlexibleLottery | [0xc6E473eaf7118Fa10397bE263C251084010d4ED6](https://bscscan.com/address/0xc6E473eaf7118Fa10397bE263C251084010d4ED6) |
| Lottery (V2, active) | FlexibleLotteryV2 | [0x822b3e24c92689DF53aF6E0f0a64299219dD0c6f](https://bscscan.com/address/0x822b3e24c92689DF53aF6E0f0a64299219dD0c6f) |
| Slots PvC (v2, active) | Slots | [0xC99caA15e1C3CDdBb458acdbBED584279766bCdb](https://bscscan.com/address/0xC99caA15e1C3CDdBb458acdbBED584279766bCdb) |

## How lottery fairness works

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

## How Slots fairness works

`seed = keccak256(abi.encode(blockhash(betBlock+1), player, bet))`

The bet transaction commits funds into escrow while the future blockhash is
**not yet known** — neither the player, nor a validator, nor a sandwich bot
can predict or influence the outcome. Resolution is permissionless and
deterministic: anyone may call `resolveFor()` one block later. If the
blockhash decays (>256 blocks), the spin auto-refunds — spins can never
strand. The paytable is immutable and yields **RTP 94.98%**
(`docs/slots-math.md`, frozen by a 5M-spin Monte Carlo).

The LP side is open: anyone can `deposit()` USDT, mint shares and earn the
house edge; `withdraw(shares)` exits. One active session per player
("exclusive machine") keeps the bankroll wall honest under chained play —
see `docs/slots-design.md`.

## Repository layout

```
contracts/FlexibleLottery.sol    # V1 lottery (kept for history — vulnerable, retired)
contracts/FlexibleLotteryV2.sol  # V2 lottery (active on mainnet)
contracts/SniperBots.sol         # adversarial replay suite
contracts/Slots.sol              # Slots PvC v2 (active on mainnet)
contracts/test/SlotsMocks.sol    # test doubles (RNG harness, mock token)
test/v2.test.cjs                 # 5 lottery tests incl. the adversarial replay
test/slots.test.cjs              # 33 slots tests (RNG, escrow, LP math, admission)
scripts/                         # deploy, smoke checks, sim, keeper/sweep helpers
docs/slots-design.md             # Slots PvC design record (phases 1–6)
docs/slots-math.md               # paytable coefficients + Monte Carlo freeze
```

## Run the tests

```bash
npm install
npx hardhat test test/v2.test.cjs
npx hardhat test test/slots.test.cjs
```

## Fee model

**Lottery:** one winner receives **95%** of the pool; a fixed **5%** is the
creator fee, transferred automatically inside the winner's claim transaction.
Refunds are 100% and fee-free. The contracts never accept BNB.

**Slots:** the 5% house edge is **virtual** — it is baked into the immutable
paytable and accrues to the LP pool statistically, spin by spin. No fee
transaction exists. `creatorFeeShare` starts at 0 and can only be raised by
the creator through a 24h-timelocked tier table, capped at 20%.

---


18+. Gambling involves risk — losses are expected and the house edge is 5%.
Not available in restricted jurisdictions. Play responsibly.
