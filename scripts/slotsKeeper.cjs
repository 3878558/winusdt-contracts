// scripts/slotsKeeper.cjs
//
// Кипер машины Slots v2 (фаза 6d): страховочный дожим брошенных сессий.
//
// Зачем: сессия (escrow + exposure + busy-флаг) живёт до settle. Игрок может
// закрыть страницу/пропасть — машина остаётся занятой, LP-пул теряет
// ликвидность, другие игроки ловят "machine busy". resolveFor/
// resolveSeriesFor permissionless: любой адрес может дожать чужой хвост —
// выплата ВСЕГДА уходит игроку (исход детерминирован blockhash), кипер
// лишь платит газ и освобождает машину. Если blockhash decayed (>256
// блоков) — контракт сам возвращает ставки (спины не застревают никогда).
//
// Цикл: poll activePlayer() каждые POLL сек (+jitter) → если занята и хвост
// висит дольше GRACE секунд (и blockhash(bb+1) уже доступен) → resolveFor
// (solo) / resolveSeriesFor (серия). Пол работает 24/7 — страховка не знает
// ночных окон; "реалистичность" в том, что tx отправляются ТОЛЬКО при
// наличии хвоста, idle-поллинг бесплатен (view-вызовы).
//
// Гарантии бюджета: газ-кап (gwei), floor-BNB у кипера — ниже floor дожим
// приостанавливается с warning. RPC-ротация при сбоях (dataseed → dataseed2
// → publicnode). Анти-гонка: перед отправкой повторно сверяем betBlock/n
// сессии — если игрок сам перевернул сессию, ждём заново.
//
// Запуск: node scripts/slotsKeeper.cjs [slotsAddr] [graceSec] [pollSec]
// Кипер идемпотентен — рестарт безопасен.
require("dotenv").config();
const { ethers } = require("ethers");

const MAINNET_DEFAULT = "0xC99caA15e1C3CDdBb458acdbBED584279766bCdb";
const RPCS = [
  process.env.BSC_MAINNET_RPC,
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
].filter(Boolean);

const SLOTS_ABI = [
  "function activePlayer() view returns (address)",
  "function activeSession(address) view returns (uint256 bet, uint256 betBlock, uint256 n, bool active)",
  "function resolveFor(address player)",
  "function resolveSeriesFor(address player)",
  "function equity() view returns (uint256)",
  "function freeBankroll() view returns (uint256)",
  "function totalEscrow() view returns (uint256)",
  "event SpinResolved(address indexed player, uint256 indexed betBlock, uint256 bet, bytes32 h, uint256 seed, uint8[3] syms, uint256 payout)",
  "event SeriesSettled(address indexed player, uint256 indexed betBlock, uint256 n, uint256 totalPayout, uint256 totalRefunded)",
];
const ERC20_ABI = ["function balanceOf(address) view returns (uint256)"];
const USDT = "0x55d398326f99059fF775485246999027B3197955";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const now = () => new Date().toLocaleTimeString("ru-RU", { hour12: false });

(async () => {
  const slotsAddr = process.argv[2] || MAINNET_DEFAULT;
  const GRACE_SEC = Number(process.argv[3] || process.env.KEEPER_GRACE_SEC || 60);
  const POLL_SEC = Number(process.argv[4] || process.env.KEEPER_POLL_SEC || 15);
  const BNB_FLOOR = ethers.utils.parseEther(process.env.KEEPER_BNB_FLOOR || "0.005");
  const GAS_CAP = ethers.utils.parseUnits(process.env.KEEPER_GAS_CAP_GWEI || "5", "gwei");

  let rpcIdx = 0;
  let provider = new ethers.providers.JsonRpcProvider(RPCS[rpcIdx]);
  let slots = new ethers.Contract(slotsAddr, SLOTS_ABI, provider);
  let usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  let keeper = treasury.connect(provider);
  const F = (x) => ethers.utils.formatEther(x);
  const switchRpc = () => {
    rpcIdx = (rpcIdx + 1) % RPCS.length;
    provider = new ethers.providers.JsonRpcProvider(RPCS[rpcIdx]);
    slots = slots.connect(provider);
    usdt = usdt.connect(provider);
    keeper = treasury.connect(provider);
    console.log(`${now()} ⚠ RPC → ${RPCS[rpcIdx]}`);
  };

  let resolves = 0, paidOut = ethers.constants.Zero, refunded = ethers.constants.Zero,
      gasSpent = ethers.constants.Zero, errors = 0, idleChecks = 0;

  const preflight = async () => {
    const bn = await provider.getBlockNumber();
    const [eq, fb, esc, busy, kbn] = await Promise.all([
      slots.equity(), slots.freeBankroll(), slots.totalEscrow(),
      slots.activePlayer(), provider.getBalance(keeper.address),
    ]);
    console.log(`${now()} ══ КИПЕР СТАРТ ══ ${slotsAddr}`);
    console.log(`${now()} блок ${bn} | RPC ${RPCS[rpcIdx]} | grace ${GRACE_SEC}s | poll ${POLL_SEC}s | газ-кап ${ethers.utils.formatUnits(GAS_CAP, "gwei")} gwei | floor ${F(BNB_FLOOR)} BNB`);
    console.log(`${now()} машина: equity ${F(eq)} | fb ${F(fb)} | escrow ${F(esc)} | busy ${busy === ethers.constants.AddressZero ? "свободна" : busy.slice(0, 10)}`);
    console.log(`${now()} кипер ${keeper.address}: BNB ${F(kbn)} | resolveFor(solo)/resolveSeriesFor(серия) permissionless`);
  };
  await preflight();

  // eslint-disable-next-line no-constant-condition
  while (true) {
    try {
      const bn = await provider.getBlockNumber();
      const busy = await slots.activePlayer();

      if (busy === ethers.constants.AddressZero) {
        idleChecks += 1;
        if (idleChecks % 8 === 1) console.log(`${now()} …машина свободна (проверок ${idleChecks})`);
        await sleep(POLL_SEC * 1000 + Math.floor(Math.random() * 5000));
        continue;
      }

      let [bet, bb, n, act] = await slots.activeSession(busy);
      if (!act) { await sleep(2000); continue; } // только что освободилась
      bb = Number(bb); n = Number(n);
      const hashReady = bn > bb + 2; // blockhash(bb+1) существует строго позади
      const tBet = (await provider.getBlock(bb)).timestamp;
      const elapsed = Math.floor(Date.now() / 1000) - tBet;
      if (!hashReady || elapsed < GRACE_SEC) { await sleep(5000); continue; }

      // ── Предохранители бюджета ──
      const gasPrice = await provider.getGasPrice();
      if (gasPrice.gt(GAS_CAP)) {
        console.log(`${now()} ⚠ газ ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei > капа — пропуск цикла`);
        await sleep(30000);
        continue;
      }
      const kbn = await provider.getBalance(keeper.address);
      if (kbn.lt(BNB_FLOOR.add(gasPrice.mul(300000)))) {
        console.log(`${now()} ⛔ BNB кипера ${F(kbn)} ниже floor — дожим приостановлен, нужен дозалив`);
        await sleep(60000);
        continue;
      }

      // ── Анти-гонка: сессия не сменилась, пока мы ждали grace ──
      const [, bb2, n2, act2] = await slots.activeSession(busy);
      if (!act2 || Number(bb2) !== bb || Number(n2) !== n) {
        console.log(`${now()} сессия ${busy.slice(0, 10)} сменилась (игрок жив) — ждём заново`);
        await sleep(2000);
        continue;
      }

      // ── Дожим ──
      const fn = n === 1 ? "resolveFor" : "resolveSeriesFor";
      const gas = await slots.connect(keeper).estimateGas[fn](busy);
      const tx = await slots.connect(keeper)[fn](busy, {
        gasPrice, gasLimit: gas.mul(12).div(10),
      });
      console.log(`${now()} 🔧 дожимаю хвост: игрок ${busy.slice(0, 10)} | bet ${F(bet)} × ${n} | хвост ${elapsed}s | tx ${tx.hash}`);
      const rec = await tx.wait();
      gasSpent = gasSpent.add(rec.gasUsed.mul(rec.effectiveGasPrice || gasPrice));
      let line = `${now()} ✅ settle ${busy.slice(0, 10)}: `;
      for (const ev of rec.events || []) {
        try {
          if (ev.event === "SpinResolved") {
            if (ev.args.h === ethers.constants.HashZero) {
              refunded = refunded.add(ev.args.bet);
              line += `refund ${F(ev.args.bet)} (decay)`;
            } else {
              paidOut = paidOut.add(ev.args.payout);
              line += `спин [${ev.args.syms.join(",")}] → выплата ${F(ev.args.payout)}`;
            }
          } else if (ev.event === "SeriesSettled") {
            paidOut = paidOut.add(ev.args.totalPayout);
            refunded = refunded.add(ev.args.totalRefunded);
            line += `серия ${Number(ev.args.n)}: выплачено ${F(ev.args.totalPayout)} | refund ${F(ev.args.totalRefunded)}`;
          }
        } catch { /* чужое событие — игнор */ }
      }
      resolves += 1;
      console.log(line);
      console.log(`${now()} 📊 дожимов ${resolves} | выплачено ${F(paidOut)} | refund ${F(refunded)} | газ ${F(gasSpent)} BNB`);
      const [escAfter, busyAfter] = await Promise.all([slots.totalEscrow(), slots.activePlayer()]);
      console.log(`${now()} машина: escrow ${F(escAfter)} | busy ${busyAfter === ethers.constants.AddressZero ? "свободна ✓" : busyAfter}`);
      await sleep(POLL_SEC * 1000);
    } catch (e) {
      errors += 1;
      console.warn(`${now()} ✗ ошибка цикла (${errors}): ${String((e && (e.reason || e.message)) || e).slice(0, 140)}`);
      if (errors % 3 === 0) switchRpc();
      await sleep(10000);
    }
  }
})().catch((e) => {
  console.error("FATAL:", String(e && e.message ? e.message : e).slice(0, 200));
  process.exitCode = 1;
});
