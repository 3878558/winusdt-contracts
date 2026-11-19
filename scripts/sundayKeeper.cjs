// scripts/sundayKeeper.cjs
//
// Duty keeper для SundayLottery (фаза 7) — по образцу lotteryKeeper.cjs
// (урок 6k: сервисные действия контракта permissionless, но на практике их
// никто, кроме нас, не вызывает). Опрашивает контракт и запускает:
//   - sealWeek()      когда canSeal()   (воскресенье 18:00 UTC прошло,
//                                        состав ≥ 1 → заморозка продаж)
//   - skipWeek()      когда canSkip()   (дедлайн прошёл, состав 0 → неделя
//                                        пропускается без розыгрыша)
//   - commitHash()    когда canCommit() (SEALED, [seal+20, seal+250] блоков)
//   - triggerDraw()   когда canDraw()   (хеш закоммичен → победитель 95%,
//                                        казне 5% сразу в этой же tx)
//   - refundWeek()    когда canRefund() (страховка: розыгрыш не доехал →
//                                        всем 100%, неделя закрывается)
//   - openNextWeek()  когда canOpenNext()(SETTLED → неделя N+1 по якорю)
//
// Худший случай недели — цепочка seal→commit→draw→open занимает минуты
// (COMMIT_DELAY=20 блоков ≈ 1 мин на BSC), poll 30с перекрывает все окна.
// Keeper wallet платит только газ; призы всегда уходят игрокам on-chain.
// Бюджетные предохранители: газ-кап и BNB-флор. RPC-ротация на сбоях,
// heartbeat каждые HEARTBEAT_SEC даже в idle. Idempotent и resume-safe:
// действия выводятся из состояния контракта.
//
// Запуск (фоном, из lottery-frontend):
//   Start-Process node scripts\sundayKeeper.cjs   (логи -> tools\sundayKeeper.log)
// Интервалы/капы через CLI/env, как у остальных киперов:
//   node scripts/sundayKeeper.cjs --poll 30 --gas-cap 5 --bnb-floor 0.005
require("dotenv").config();
const { ethers } = require("ethers");

const RPCS = [
  process.env.BSC_MAINNET_RPC,
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
].filter(Boolean);

// Деплой 2026-11-19, tx 0xb271464c… (см. src/utils/sunday.js и docs).
const SUNDAY = "0xD0AF26f3bf0c61B5C9646d3402C3c1DE5B92D0b6";

const ABI = [
  "function state() view returns (uint8)",
  "function weekId() view returns (uint256)",
  "function seatCount() view returns (uint256)",
  "function currentDeadline() view returns (uint256)",
  "function canSeal() view returns (bool)",
  "function canSkip() view returns (bool)",
  "function canCommit() view returns (bool)",
  "function canDraw() view returns (bool)",
  "function canRefund() view returns (bool)",
  "function canOpenNext() view returns (bool)",
  "function sealWeek()",
  "function skipWeek()",
  "function commitHash()",
  "function triggerDraw()",
  "function refundWeek()",
  "function openNextWeek()",
  "event WeekOpened(uint256 indexed weekId, uint256 deadline)",
  "event WeekSealed(uint256 indexed weekId, uint256 sealBlock)",
  "event WinnerDeclared(uint256 indexed weekId, address winner, uint256 winnerSeat, uint256 prize, uint256 treasuryFee)",
  "event WeekSkipped(uint256 indexed weekId, uint256 nextWeekId)",
  "event WeekRefunded(uint256 indexed weekId, uint256 playersRefunded, uint256 totalRefunded)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("ru-RU", { hour12: false });
const N = (x) => Number(String(x));
const F = (x) => ethers.utils.formatEther(x);
const STATE_NAMES = ["OPEN", "SEALED", "SETTLED"];

// ── CLI / env ──
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 && process.argv[i + 1] !== undefined ? process.argv[i + 1] : def;
}
const POLL_SEC = Number(arg("--poll", process.env.SUNDAY_KEEPER_POLL_SEC || 30));
const GAS_CAP = ethers.utils.parseUnits(String(arg("--gas-cap", process.env.SUNDAY_KEEPER_GAS_CAP_GWEI || 5)), "gwei");
const BNB_FLOOR = ethers.utils.parseEther(String(arg("--bnb-floor", process.env.SUNDAY_KEEPER_BNB_FLOOR || 0.005)));
const HEARTBEAT_SEC = Number(arg("--heartbeat", 600));
const MAX_MS = Number(arg("--max-minutes", process.env.KEEPER_MAX_MINUTES || 0)) * 60 * 1000; // 0 = forever

(async () => {
  // ── Provider с ротацией ──
  let provider = new ethers.providers.JsonRpcProvider(RPCS[0]);
  let rpcIdx = 0;
  let sunday = new ethers.Contract(SUNDAY, ABI, provider);
  let keeper = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  function switchRpc(reason) {
    rpcIdx = (rpcIdx + 1) % RPCS.length;
    provider = new ethers.providers.JsonRpcProvider(RPCS[rpcIdx]);
    sunday = new ethers.Contract(SUNDAY, ABI, provider);
    keeper = keeper.connect(provider);
    console.log(`${now()} switchRpc (${reason}): -> ${RPCS[rpcIdx]}`);
  }

  const stats = { seals: 0, skips: 0, commits: 0, draws: 0, refunds: 0, opens: 0, errors: 0, gasSpent: ethers.BigNumber.from(0) };
  let lastBeat = 0;
  const t0 = Date.now();

  while (true) {
    if (MAX_MS && Date.now() - t0 > MAX_MS) {
      console.log(`${now()} \u23F8 KEEPER_MAX_MINUTES reached - planned exit for hosted restart chain`);
      process.exit(0);
    }
    try {
      let act = null;
      if (await sunday.canSeal()) act = "sealWeek";
      else if (await sunday.canSkip()) act = "skipWeek";
      else if (await sunday.canCommit()) act = "commitHash";
      else if (await sunday.canDraw()) act = "triggerDraw";
      else if (await sunday.canRefund()) act = "refundWeek";
      else if (await sunday.canOpenNext()) act = "openNextWeek";

      if (act) {
        // ── бюджетные предохранители перед отправкой ──
        const gasPrice = await provider.getGasPrice();
        if (gasPrice.gt(GAS_CAP)) {
          console.log(`${now()} warning: gas ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei > cap - skip cycle`);
          await sleep(POLL_SEC * 1000);
          continue;
        }
        const bal = await provider.getBalance(keeper.address);
        if (bal.lt(BNB_FLOOR.add(gasPrice.mul(400000)))) {
          console.log(`${now()} STOP: keeper BNB ${F(bal)} below floor ${F(BNB_FLOOR)} - refill needed`);
          await sleep(60000);
          continue;
        }

        // ── запуск (view мог состариться за один полл — revert ловим и
        //     ретраим на следующем цикле: действия выводятся из состояния) ──
        const wid = N(await sunday.weekId());
        const seats = N(await sunday.seatCount());
        const tx = await sunday.connect(keeper)[act]({ gasPrice, gasLimit: 400000 });
        console.log(`${now()} ACTION week #${wid} (seats ${seats}): ${act} | tx ${tx.hash}`);
        const rec = await tx.wait();
        stats.gasSpent = stats.gasSpent.add(rec.gasUsed.mul(rec.effectiveGasPrice || gasPrice));
        if (act === "sealWeek") stats.seals += 1;
        if (act === "skipWeek") stats.skips += 1;
        if (act === "commitHash") stats.commits += 1;
        if (act === "triggerDraw") stats.draws += 1;
        if (act === "refundWeek") stats.refunds += 1;
        if (act === "openNextWeek") stats.opens += 1;
        for (const ev of rec.events || []) {
          try {
            if (ev.event === "WinnerDeclared") console.log(`${now()}   WINNER week #${N(ev.args.weekId)}: seat #${N(ev.args.winnerSeat)} ${String(ev.args.winner).slice(0, 10)} takes ${F(ev.args.prize)} USDT (treasury ${F(ev.args.treasuryFee)})`);
            if (ev.event === "WeekSkipped") console.log(`${now()}   week #${N(ev.args.weekId)} skipped (0 seats) -> week #${N(ev.args.nextWeekId)}`);
            if (ev.event === "WeekRefunded") console.log(`${now()}   week #${N(ev.args.weekId)} REFUNDED: ${N(ev.args.playersRefunded)} players, ${F(ev.args.totalRefunded)} USDT back`);
            if (ev.event === "WeekOpened") console.log(`${now()}   week #${N(ev.args.weekId)} opened, deadline ${new Date(N(ev.args.deadline) * 1000).toUTCString()}`);
          } catch { /* чужой лог (USDT Transfer) */ }
        }
        // активная неделя: цепочку seal→commit→draw→open продолжаем сразу
        continue;
      }

      // ── heartbeat: тихий статус, чтобы ops видел живость процесса ──
      if (Date.now() - lastBeat > HEARTBEAT_SEC * 1000) {
        lastBeat = Date.now();
        let part = "sunday: rpc?";
        try {
          const wid = N(await sunday.weekId());
          const st = N(await sunday.state());
          const seats = N(await sunday.seatCount());
          const dl = N(await sunday.currentDeadline());
          const mins = Math.max(0, Math.round((dl * 1000 - Date.now()) / 60000));
          part = `sunday: week #${wid} ${STATE_NAMES[st]} ${seats}/100, draw in ${Math.floor(mins / 60)}h${mins % 60}m`;
        } catch { /* rpc hiccup */ }
        const bnb = F(await provider.getBalance(keeper.address));
        console.log(`${now()} heartbeat: ${part} | BNB ${bnb} | seals ${stats.seals} skips ${stats.skips} commits ${stats.commits} draws ${stats.draws} refunds ${stats.refunds} opens ${stats.opens} | gas ${F(stats.gasSpent)}`);
      }

      await sleep(POLL_SEC * 1000);
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
