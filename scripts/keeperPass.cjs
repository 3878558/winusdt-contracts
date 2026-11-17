// scripts/keeperPass.cjs
//
// ONE-PASS hosted keeper for GitHub Actions (cron */5) - phase 6m.
// Unlike the daemon keepers (slotsKeeper.cjs / lotteryKeeper.cjs) this script
// makes exactly one pass over both systems and exits, which fits serverless
// scheduling. Safe to run alongside the local daemons: every action is
// permissionless, idempotent and a losing race simply reverts (caught below).
//
//   slots pass:   stuck session (grace 60s + blockhash ready) -> resolveFor /
//                 resolveSeriesFor; payout always goes to the player.
//                 v3 (6s): expired post-settle reservation -> releaseExpired
//                 (branch only fires on v3 contracts - v2-safe until deploy).
//   lottery pass: canRefund -> refundAll, canCommit -> commitHash,
//                 canDraw -> triggerDraw; winner gets the prize on-chain.
//
// Budget guards: gas cap 5 gwei, keeper BNB floor 0.005 (skip + warn).
// Skips politely when DEPLOYER_PRIVATE_KEY is absent (secret not yet set).
try { require("dotenv").config(); } catch { /* dotenv is dev-only - optional here */ }
const { ethers } = require("ethers");

const RPCS = [
  process.env.BSC_MAINNET_RPC,
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
].filter(Boolean);

const SLOTS = "0xC99caA15e1C3CDdBb458acdbBED584279766bCdb";
const TIERS = {
  5: "0xab3DB18131b21a1758EF5fb16fc157e7604E2a71",
  10: "0x165D7A1bAFAb74aa1fB595ab09633475264BE46D",
  25: "0xc6E473eaf7118Fa10397bE263C251084010d4ED6",
};

const SLOTS_ABI = [
  "function activePlayer() view returns (address)",
  "function reservedUntil() view returns (uint64)",
  "function activeSession(address) view returns (uint256 bet, uint256 betBlock, uint256 n, bool active)",
  "function releaseExpired()",
  "function resolveFor(address player)",
  "function resolveSeriesFor(address player)",
  "event SpinResolved(address indexed player, uint256 indexed betBlock, uint256 bet, bytes32 h, uint256 seed, uint8[3] syms, uint256 payout)",
  "event SeriesSettled(address indexed player, uint256 indexed betBlock, uint256 n, uint256 totalPayout, uint256 totalRefunded)",
];
const LOT_ABI = [
  "function state() view returns (uint8)",
  "function roundId() view returns (uint256)",
  "function getTotalTickets() view returns (uint256)",
  "function canRefund() view returns (bool)",
  "function canCommit() view returns (bool)",
  "function canDraw() view returns (bool)",
  "function refundAll()",
  "function commitHash()",
  "function triggerDraw()",
  "event RoundRefunded(uint256 indexed roundId, uint256 playersRefunded, uint256 totalRefunded)",
  "event WinnerDeclared(uint256 indexed roundId, address winner, uint256 prize, uint256 creatorFee)",
];

const now = () => new Date().toISOString().slice(11, 19);
const N = (x) => Number(String(x));
const F = (x) => ethers.utils.formatEther(x);
const GAS_CAP = ethers.utils.parseUnits("5", "gwei");
const BNB_FLOOR = ethers.utils.parseEther("0.005");
const GRACE_SEC = 60;

async function pickProvider() {
  for (const url of RPCS) {
    try {
      const p = new ethers.providers.JsonRpcProvider(url);
      await p.getBlockNumber();
      console.log(`${now()} RPC ok: ${url}`);
      return p;
    } catch (e) { console.log(`${now()} RPC fail: ${url}`); }
  }
  throw new Error("no working RPC");
}

async function sendTx(label, fn, gasPrice) {
  const gas = await fn.estimateGas();
  const tx = await fn({ gasPrice, gasLimit: gas.mul(12).div(10) });
  console.log(`${now()} ACTION ${label} | tx ${tx.hash}`);
  const rec = await tx.wait();
  console.log(`${now()}   ok, gas ${F(rec.gasUsed.mul(rec.effectiveGasPrice || gasPrice))} BNB`);
  return rec;
}

(async () => {
  if (!process.env.DEPLOYER_PRIVATE_KEY) {
    console.log(`${now()} DEPLOYER_PRIVATE_KEY not set - skip (add repo secret to activate)`);
    return;
  }
  const provider = await pickProvider();
  const wallet = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  console.log(`${now()} keeper ${wallet.address}`);

  // ── budget guards ──
  const gasPrice = await provider.getGasPrice();
  if (gasPrice.gt(GAS_CAP)) { console.log(`${now()} gas ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei > cap - skip pass`); return; }
  const bal = await provider.getBalance(wallet.address);
  if (bal.lt(BNB_FLOOR.add(gasPrice.mul(600000)))) { console.log(`${now()} keeper BNB ${F(bal)} below floor - refill needed`); return; }

  // ── slots pass ──
  try {
    const slots = new ethers.Contract(SLOTS, SLOTS_ABI, provider);
    const busy = await slots.activePlayer();
    if (busy === ethers.constants.AddressZero) {
      console.log(`${now()} slots: idle`);
    } else {
      const [bet, bb, n, act] = await slots.activeSession(busy);
      if (!act) {
        // v3 (6s): holder without a session = post-settle reservation. TTL
        // live -> wait (view calls are free); expired -> permissionless
        // releaseExpired. v2 contracts never reach this branch (settle frees
        // activePlayer), so the script stays v2-safe until the v3 deploy.
        const ru = N(await slots.reservedUntil());
        const nowSec = Math.floor(Date.now() / 1000);
        if (ru !== 0 && nowSec < ru) {
          console.log(`${now()} slots: reserved by ${busy.slice(0, 10)} for ${ru - nowSec}s - waiting`);
        } else {
          await sendTx(`slots releaseExpired (stale reservation ${busy.slice(0, 10)})`, slots.connect(wallet).releaseExpired.bind(slots.connect(wallet)), gasPrice);
        }
      } else {
        const bn = await provider.getBlockNumber();
        const bh = bn > bb ? await provider.getBlock(bb + 1) : null;
        const elapsed = Math.floor(Date.now() / 1000) - N(bb);
        if (bh && bn - (bb + 1) < 250 && elapsed >= GRACE_SEC) {
          const [, bb2, n2, act2] = await slots.activeSession(busy);
          if (!act2 || N(bb2) !== N(bb) || N(n2) !== N(n)) {
            console.log(`${now()} slots: session changed (player alive) - waiting`);
          } else {
            const fn = N(n) === 1 ? "resolveFor" : "resolveSeriesFor";
            const rec = await sendTx(`slots ${fn} player ${busy.slice(0, 10)} bet ${F(bet)} x${n} tail ${elapsed}s`, slots.connect(wallet)[fn].bind(slots.connect(wallet), busy), gasPrice);
            for (const ev of rec.events || []) {
              try {
                if (ev.event === "SpinResolved") console.log(`${now()}   spin [${ev.args.syms.join(",")}] payout ${F(ev.args.payout)} ${ev.args.h === ethers.constants.HashZero ? "(decay refund)" : ""}`);
                if (ev.event === "SeriesSettled") console.log(`${now()}   series x${N(ev.args.n)}: payout ${F(ev.args.totalPayout)} refund ${F(ev.args.totalRefunded)}`);
              } catch { /* foreign event */ }
            }
          }
        } else {
          console.log(`${now()} slots: busy ${busy.slice(0, 10)} tail ${elapsed}s, hash ${bh ? "ready" : "pending"} - not due yet`);
        }
      }
    }
  } catch (e) { console.log(`${now()} slots pass error: ${String(e && (e.reason || e.message) || e).slice(0, 140)}`); }

  // ── lottery pass ──
  for (const [t, addr] of Object.entries(TIERS)) {
    try {
      const c = new ethers.Contract(addr, LOT_ABI, provider);
      let act = null;
      if (await c.canRefund()) act = "refundAll";
      else if (await c.canCommit()) act = "commitHash";
      else if (await c.canDraw()) act = "triggerDraw";
      if (!act) { console.log(`${now()} lottery t${t}: nothing due`); continue; }
      const rid = N(await c.roundId());
      const tk = N(await c.getTotalTickets());
      const rec = await sendTx(`lottery t${t} ${act} round #${rid} tickets ${tk}/10`, c.connect(wallet)[act].bind(c.connect(wallet)), gasPrice);
      for (const ev of rec.events || []) {
        try {
          if (ev.event === "RoundRefunded") console.log(`${now()}   refunded round #${N(ev.args.roundId)}: ${N(ev.args.playersRefunded)} players, ${F(ev.args.totalRefunded)} USDT back`);
          if (ev.event === "WinnerDeclared") console.log(`${now()}   WINNER round #${N(ev.args.roundId)}: ${String(ev.args.winner).slice(0, 10)} takes ${F(ev.args.prize)} USDT (fee ${F(ev.args.creatorFee)})`);
        } catch { /* foreign event */ }
      }
    } catch (e) { console.log(`${now()} lottery t${t} pass error: ${String(e && (e.reason || e.message) || e).slice(0, 140)}`); }
  }
  console.log(`${now()} === PASS DONE ===`);
})().catch((e) => { console.error("FATAL:", String(e && e.message ? e.message : e).slice(0, 200)); process.exitCode = 1; });
