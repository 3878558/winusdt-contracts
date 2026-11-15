// scripts/lotteryKeeper.cjs
//
// Duty keeper for FlexibleLotteryV2 tiers (phase 6k lesson): the V2 contract
// is fully permissionless for servicing actions, but in practice nobody else
// calls them - so real players' money would hang in stuck rounds until a
// stranger intervenes. This process polls all three tiers and fires:
//   - refundAll()   when canRefund()  (OPEN expired -> 100% refunds, or
//                                     FULL + fullGrace expired -> refunds)
//   - commitHash()  when canCommit()  (FULL, COMMIT_DELAY passed, in window)
//   - triggerDraw() when canDraw()    (hash committed -> draw, winner takes 95%)
//
// Keeper wallet pays gas only; prizes always go to players/winner on-chain.
// Budget guards: gas-price cap and keeper BNB floor (skip + warn when hit).
// RPC rotation on failures. Heartbeat every HEARTBEAT_SEC even when idle.
//
// Run (background, from lottery-frontend):
//   Start-Process node scripts\lotteryKeeper.cjs   (logs -> tools\lotteryKeeper.log)
// Poll interval and caps via CLI/env, same style as slotsKeeper.cjs:
//   node scripts/lotteryKeeper.cjs --poll 30 --gas-cap 5 --bnb-floor 0.005
// Idempotent and resume-safe: actions are state-derived, restarts are free.
require("dotenv").config();
const { ethers } = require("ethers");

const RPCS = [
  process.env.BSC_MAINNET_RPC,
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
].filter(Boolean);

const TIERS = {
  5: "0xab3DB18131b21a1758EF5fb16fc157e7604E2a71",
  10: "0x165D7A1bAFAb74aa1fB595ab09633475264BE46D",
  25: "0xc6E473eaf7118Fa10397bE263C251084010d4ED6",
};

const ABI = [
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("ru-RU", { hour12: false });
const N = (x) => Number(String(x));
const F = (x) => ethers.utils.formatEther(x);

// ── CLI / env ──
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const POLL_SEC = Number(arg("--poll", process.env.LOTTERY_KEEPER_POLL_SEC || 30));
const GAS_CAP = ethers.utils.parseUnits(String(arg("--gas-cap", process.env.LOTTERY_KEEPER_GAS_CAP_GWEI || 5)), "gwei");
const BNB_FLOOR = ethers.utils.parseEther(String(arg("--bnb-floor", process.env.LOTTERY_KEEPER_BNB_FLOOR || 0.005)));
const HEARTBEAT_SEC = Number(arg("--heartbeat", 600));
const MAX_MS = Number(arg("--max-minutes", process.env.KEEPER_MAX_MINUTES || 0)) * 60 * 1000; // 0 = forever

(async () => {
  // ── Provider with rotation ──
  let provider = new ethers.providers.JsonRpcProvider(RPCS[0]);
  let rpcIdx = 0;
  const tiers = {};
  for (const [t, addr] of Object.entries(TIERS)) tiers[t] = { addr, c: new ethers.Contract(addr, ABI, provider) };
  let keeper = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  function switchRpc(reason) {
    rpcIdx = (rpcIdx + 1) % RPCS.length;
    console.log(`${now()} RPC switch (${reason}) -> ${RPCS[rpcIdx]}`);
    provider = new ethers.providers.JsonRpcProvider(RPCS[rpcIdx]);
    for (const [, e] of Object.entries(tiers)) e.c = new ethers.Contract(e.addr, ABI, provider);
    keeper = keeper.connect(provider);
  }

  const stats = { refunds: 0, commits: 0, draws: 0, errors: 0, gasSpent: ethers.BigNumber.from(0) };
  let lastBeat = 0;

  console.log(`${now()} === LOTTERY KEEPER START === tiers ${Object.keys(TIERS).join("/")} | keeper ${keeper.address.slice(0, 10)} | poll ${POLL_SEC}s | gas cap ${ethers.utils.formatUnits(GAS_CAP, "gwei")} gwei | floor ${F(BNB_FLOOR)} BNB`);
  let t0 = Date.now();

  while (true) {
    if (MAX_MS && Date.now() - t0 > MAX_MS) {
      console.log(`${now()} \u23F8 KEEPER_MAX_MINUTES reached - planned exit for hosted restart chain`);
      process.exit(0);
    }
    try {
      let actions = 0;
      for (const [t, entry] of Object.entries(tiers)) {
        const c = entry.c;
        let act = null;
        if (await c.canRefund()) act = "refundAll";
        else if (await c.canCommit()) act = "commitHash";
        else if (await c.canDraw()) act = "triggerDraw";
        if (!act) continue;

        // ── budget guards before sending ──
        const gasPrice = await provider.getGasPrice();
        if (gasPrice.gt(GAS_CAP)) {
          console.log(`${now()} warning: gas ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei > cap - skip cycle`);
          break;
        }
        const bal = await provider.getBalance(keeper.address);
        if (bal.lt(BNB_FLOOR.add(gasPrice.mul(200000)))) {
          console.log(`${now()} STOP: keeper BNB ${F(bal)} below floor ${F(BNB_FLOOR)} - refill needed`);
          await sleep(60000);
          break;
        }

        // ── fire (view may have aged - revert is caught and retried next poll) ──
        const rid = N(await c.roundId());
        const tickets = N(await c.getTotalTickets());
        const tx = await c.connect(keeper)[act]({ gasPrice, gasLimit: 400000 });
        console.log(`${now()} ACTION tier ${t}: ${act} | round #${rid} | tickets ${tickets}/10 | tx ${tx.hash}`);
        const rec = await tx.wait();
        stats.gasSpent = stats.gasSpent.add(rec.gasUsed.mul(rec.effectiveGasPrice || gasPrice));
        if (act === "refundAll") stats.refunds += 1;
        if (act === "commitHash") stats.commits += 1;
        if (act === "triggerDraw") stats.draws += 1;
        for (const ev of rec.events || []) {
          try {
            if (ev.event === "RoundRefunded") console.log(`${now()}   refunded round #${N(ev.args.roundId)}: ${N(ev.args.playersRefunded)} players, ${F(ev.args.totalRefunded)} USDT back`);
            if (ev.event === "WinnerDeclared") console.log(`${now()}   WINNER round #${N(ev.args.roundId)}: ${String(ev.args.winner).slice(0, 10)} takes ${F(ev.args.prize)} USDT (fee ${F(ev.args.creatorFee)})`);
          } catch { /* foreign event */ }
        }
        actions += 1;
      }

      // ── heartbeat: quiet status so ops sees the process is alive ──
      if (Date.now() - lastBeat > HEARTBEAT_SEC * 1000) {
        lastBeat = Date.now();
        const parts = [];
        for (const [t, entry] of Object.entries(tiers)) {
          try {
            const st = N(await entry.c.state());
            const tk = N(await entry.c.getTotalTickets());
            parts.push(`t${t}:${["OPEN", "CALC", "CLOSED", "FULL"][st]} ${tk}/10`);
          } catch { parts.push(`t${t}: rpc?`); }
        }
        const bnb = F(await provider.getBalance(keeper.address));
        console.log(`${now()} heartbeat: ${parts.join(" | ")} | BNB ${bnb} | refunds ${stats.refunds} commits ${stats.commits} draws ${stats.draws} | gas ${F(stats.gasSpent)}`);
      }

      if (actions === 0) await sleep(POLL_SEC * 1000);
    } catch (e) {
      stats.errors += 1;
      console.warn(`${now()} error (${stats.errors}): ${String((e && (e.reason || e.message)) || e).slice(0, 140)}`);
      if (stats.errors % 3 === 0) switchRpc("errors");
      await sleep(10000);
    }
  }
})().catch((e) => {
  console.error("FATAL:", String(e && e.message ? e.message : e).slice(0, 200));
  process.exitCode = 1;
});
