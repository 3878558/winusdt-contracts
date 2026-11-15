// scripts/slotsLoop.cjs
//
// Нагрузочный/лайвнес-тест Slots на живой цепи: N спинов подряд от кошелька
// казны (DEPLOYER_PRIVATE_KEY). Режим continuous play (§3.1 п.5):
// spin(bet, resolvePrev=true) закрывает прошлый спин и открывает следующий
// в ОДНОЙ транзакции — 1 tx на спин вместо двух (плюс первый spin и
// финальный resolve). Это же — прототип extension activityLoop (фаза 6).
//
// Стопы безопасности: стены адмиссии (fb < 99×bet+bet), нехватка BNB/USDT,
// пауза контракта; при любом аварийном выходе активная сессия ДОЖИМАЕТСЯ
// (resolve) — застревание ставок исключено.
//
// Запуск:
//   node scripts/slotsLoop.cjs mainnet <slotsAddr> [spins=100] [betUSDT=0.5] [playerWallet=0]
// playerWallet: 0 = казна (DEPLOYER_PRIVATE_KEY); 1..N = кошелёк №N из
// TEST_PRIVATE_KEYS (.env) — при нехватке BNB/USDT казна доливает автоматически.
require("dotenv").config();
const { ethers } = require("ethers");

const USDT_BY_NETWORK = {
  testnet: "0x2e5fD073A41826c72f229353aFA0558364C0dAcd",
  mainnet: "0x55d398326f99059fF775485246999027B3197955",
};

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address,address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

const SLOTS_ABI = [
  "function minBet() view returns (uint256)",
  "function maxBetNow() view returns (uint256)",
  "function paused() view returns (bool)",
  "function freeBankroll() view returns (uint256)",
  "function equity() view returns (uint256)",
  "function sessions(address) view returns (uint128 bet, uint32 betBlock, uint16 n, bool active)",
  "function deposit(uint256 amount)",
  "function spin(uint256 bet)",
  "function spin(uint256 bet, bool resolvePrev)",
  "function resolve()",
  "function resolveSeries()",
  "event SpinStarted(address indexed player, uint256 indexed betBlock, uint256 bet, uint256 n)",
  "event SpinResolved(address indexed player, uint256 indexed betBlock, uint256 bet, bytes32 blockHash, uint256 seed, uint8[3] symbols, uint256 payout)",
];

const SYMS = ["🍒", "🍋", "🍇", "🔔", "⭐", "💎", "7️⃣"];
// Реальный газ мейннета: ~0.00013 BNB/tx (замер 101 tx прогона) — пол берём
// ниже фонда кошелька (0.02), чтобы тест не обрывался на старте
const BNB_FLOOR = ethers.utils.parseEther("0.008");
const WAIT_TIMEOUT_MS = 90_000;

function findEvent(receipt, name) {
  const iface = new ethers.utils.Interface(SLOTS_ABI);
  for (const log of receipt.logs || []) {
    try {
      const ev = iface.parseLog(log);
      if (ev.name === name) return ev;
    } catch { /* чужой лог */ }
  }
  return null;
}

async function waitHead(provider, target) {
  const t0 = Date.now();
  for (;;) {
    const head = await provider.getBlockNumber();
    if (head >= target) return head;
    if (Date.now() - t0 > WAIT_TIMEOUT_MS) throw new Error(`head не дошёл до ${target}`);
    await new Promise((r) => setTimeout(r, 1000));
  }
}

async function main() {
  const network = process.argv[2] || "mainnet";
  const addr = process.argv[3];
  const spins = Number(process.argv[4] || 100);
  const betArg = process.argv[5] || "0.5";
  if (!addr) throw new Error("usage: node scripts/slotsLoop.cjs <network> <slotsAddr> [spins] [betUSDT]");

  const rpc = network === "mainnet"
    ? process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org"
    : process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  // Игрок: казна (0) или кошелёк №N из TEST_PRIVATE_KEYS (1-based)
  const playerIdx = Number(process.argv[6] || 0);
  let player;
  if (playerIdx > 0) {
    const keys = (process.env.TEST_PRIVATE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
    if (playerIdx > keys.length) {
      throw new Error(`кошелёк №${playerIdx} отсутствует в TEST_PRIVATE_KEYS (всего ${keys.length})`);
    }
    player = new ethers.Wallet(keys[playerIdx - 1], provider);
  } else {
    player = treasury;
  }
  const wallet = player; // все игровые операции — от игрока
  const slots = new ethers.Contract(addr, SLOTS_ABI, wallet);
  const usdt = new ethers.Contract(USDT_BY_NETWORK[network], ERC20_ABI, wallet);
  const me = wallet.address;

  const dec = await usdt.decimals();
  const F = (x) => ethers.utils.formatUnits(x, dec);
  const bet = ethers.utils.parseUnits(betArg, dec);

  // ── Автофандинг игрока из казны (если игрок ≠ казна) ──
  if (player.address.toLowerCase() !== treasury.address.toLowerCase()) {
    // консервативно-реалистичный газ: ~0.0002 BNB/tx (замер 0.00013)
    const gasNeed = ethers.utils.parseEther("0.00015").mul(spins + 4).add(ethers.utils.parseEther("0.002"));
    const usdtNeed = bet.mul(10); // выигрыши рециркулируют в кошелёк — буфер ~10 спинов, не весь план
    const [bnbBal, usdtBal0] = await Promise.all([
      provider.getBalance(player.address),
      usdt.balanceOf(player.address),
    ]);
    console.log(
      `кошелёк №${playerIdx} ${player.address} | BNB ${ethers.utils.formatEther(bnbBal)} | USDT ${F(usdtBal0)}`
    );
    const tBnb = await provider.getBalance(treasury.address);
    if (bnbBal.lt(gasNeed)) {
      let top = gasNeed.sub(bnbBal);
      const reserve = ethers.utils.parseEther("0.005");
      if (tBnb.lte(reserve)) {
        console.log(`казна без BNB (${F(tBnb)}) — едем на фонде кошелька`);
      } else {
        if (top.gt(tBnb.sub(reserve))) top = tBnb.sub(reserve);
        console.log(`доливаю газ из казны: ${F(top)} BNB…`);
        await (await treasury.sendTransaction({ to: player.address, value: top })).wait();
      }
    }
    if (usdtBal0.lt(usdtNeed)) {
      const tUsdtBal = await usdt.balanceOf(treasury.address);
      let top = usdtNeed.sub(usdtBal0);
      if (top.gt(tUsdtBal)) {
        console.log(`казна не может долить USDT полностью (${F(tUsdtBal)}) — едем на имеющемся (выигрыши рециркулируют)`);
        top = tUsdtBal;
      }
      if (top.gt(0)) {
        console.log(`доливаю USDT из казны: ${F(top)}…`);
        await (await usdt.connect(treasury).transfer(player.address, top)).wait();
      }
    }
  }

  const t0 = Date.now();
  const bnb0 = await wallet.getBalance();

  console.log(`slotsLoop: ${network} ${addr}`);
  console.log(
    `игрок: ${me}${playerIdx > 0 ? ` (кошелёк №${playerIdx})` : " (казна)"} | план: ${spins} спинов × ${F(bet)} USDT (continuous play, 1 tx/спин)`
  );
  console.log(`BNB старт: ${ethers.utils.formatEther(bnb0)}`);

  // ── Префлайт ──
  const [paused, minBet, maxBet, fb, usdtBal] = await Promise.all([
    slots.paused(), slots.minBet(), slots.maxBetNow(), slots.freeBankroll(), usdt.balanceOf(me),
  ]);
  console.log(`лимиты: min ${F(minBet)} | max ${F(maxBet)} | fb ${F(fb)} | USDT ${F(usdtBal)} | paused=${paused}`);
  if (paused) throw new Error("контракт на паузе");
  if (bet.lt(minBet) || bet.gt(maxBet)) throw new Error(`ставка вне лимитов ${F(minBet)}–${F(maxBet)}`);
  // Префлайт: выигрыши рециркулируют в кошелёк по ходу прогона, поэтому
  // требуется БУФЕР (~10 спинов), а не весь план
  if (usdtBal.lt(bet.mul(10))) throw new Error(`USDT-буфер меньше 10 ставок: ${F(usdtBal)} < ${F(bet.mul(10))}`);
  const admissionNeed = ethers.BigNumber.from(99).mul(bet).add(bet);
  if (fb.lt(admissionNeed)) throw new Error(`стена адмиссии уже сейчас: fb ${F(fb)} < 99×bet+bet`);

  // ── Allowance на весь прогон (+маржа) ──
  const need = bet.mul(spins).add(bet.mul(5));
  const allow = await usdt.allowance(me, addr);
  if (allow.lt(need)) {
    console.log("approve на объём прогона…");
    await (await usdt.approve(addr, ethers.constants.MaxUint256)).wait();
  }

  // ── Статистика ──
  const st = {
    spins: 0,
    wagered: ethers.BigNumber.from(0),
    paid: ethers.BigNumber.from(0),
    refunded: ethers.BigNumber.from(0),
    wins: 0, losses: 0, pairs: 0, triples: 0, refunds: 0,
  };
  function tally(args) {
    const [, , sbet, blockHash, , symbols, payout] = args;
    st.spins += 1;
    st.wagered = st.wagered.add(sbet);
    if (blockHash === ethers.constants.HashZero) { st.refunds += 1; st.refunded = st.refunded.add(sbet); }
    else if (payout.gt(0)) {
      st.wins += 1; st.paid = st.paid.add(payout);
      const [a, b, c] = symbols;
      if (a === b && b === c) st.triples += 1; else st.pairs += 1;
    } else st.losses += 1;
  }
  const pct = (x, base) =>
    base.gt(0) ? Number(ethers.utils.formatEther(x.mul(ethers.utils.parseEther("1")).div(base))) * 100 : 0;
  const line = (args) => {
    const [, , , blockHash, , symbols, payout] = args;
    const s = symbols.map((i) => SYMS[i]).join("");
    const net = st.wagered.sub(st.paid);
    return `#${String(st.spins).padStart(3)} ${s} ${
      blockHash === ethers.constants.HashZero ? "↩refund" : payout.gt(0) ? `+${F(payout)}` : "—"
    } | дом нетто ${F(net)} USDT`;
  };

  // ── Восстановление брошенной сессии (идемпотентный рестарт) ──
  // ВАЖНО: ethers v5 возвращает малые uint-типы (uint16/uint32) как plain
  // numbers, а не BigNumber — .toNumber() на них не существует (урок
  // мейннет-прогона: FATAL s.n.toNumber). Работаем с Number()/позиционно.
  async function settlePending() {
    const s = await slots.sessions(me);
    if (!s.active) return;
    const bb0 = Number(s.betBlock);
    const n = Number(s.n);
    console.log(`найдена незакрытая сессия (bet ${F(s.bet)}, bb ${bb0}, n ${n}) — дожимаю…`);
    const target = n > 1 ? bb0 + n + 1 : bb0 + 2;
    await waitHead(provider, target);
    const tx = n > 1 ? await slots.resolveSeries() : await slots.resolve();
    const rec = await tx.wait();
    const ev = findEvent(rec, "SpinResolved");
    if (ev) { tally(ev.args); console.log(line(ev.args)); }
  }
  await settlePending();

  // ── Режим восстановления: spins=0 → только дожим сессии и отчёт ──
  if (spins <= 0) {
    console.log("spins=0 — режим восстановления, новые спины не открываются");
    await settlePending();
    const net = st.wagered.sub(st.paid).sub(st.refunded);
    console.log("\n════════ ИТОГ ════════");
    console.log(`спинов (закрыто сейчас): ${st.spins} | оборот ${F(st.wagered)} | выплачено ${F(st.paid)} | дом нетто ${F(net)}`);
    return;
  }

  // ── Спин 1 (открывает сессию) ──
  console.log("старт…");
  let tx = await slots["spin(uint256)"](bet);
  let rec = await tx.wait();
  let started = findEvent(rec, "SpinStarted");
  if (!started) throw new Error("нет SpinStarted в первой tx");
  let bb = started.args.betBlock.toNumber();

  // ── Спины 2..N: каждый закрывает прошлый и открывает новый (1 tx) ──
  let stopReason = null;
  for (let i = 2; i <= spins; i++) {
    await waitHead(provider, bb + 2);
    const [bnb, eqNow, myUsdt] = await Promise.all([
      wallet.getBalance(), slots.equity(), usdt.balanceOf(me),
    ]);
    if (bnb.lt(BNB_FLOOR)) { stopReason = `мало газа (${ethers.utils.formatEther(bnb)} BNB)`; break; }
    if (myUsdt.lt(bet)) { stopReason = `кошелёк опустел (USDT ${F(myUsdt)})`; break; }
    // СТЕНА для chained-play не проверяется по fb: пока открыта своя сессия,
    // fb заранее занижен на собственный escrow+exposure (49.5) — ложные
    // срабатывания. Реальную стену отсечёт контракт ("admission" → мягкий
    // стоп ниже); страхуемся эквити: оно покрывает худший исход.
    if (eqNow.lt(ethers.BigNumber.from(99).mul(bet))) {
      stopReason = `equity не покрывает худший исход (${F(eqNow)})`;
      break;
    }
    let ok = false;
    let wall = false;
    for (let attempt = 0; attempt < 3 && !ok; attempt++) {
      try {
        tx = await slots["spin(uint256,bool)"](bet, true); // resolve прошлый + открыть новый
        rec = await tx.wait();
        ok = true;
      } catch (e) {
        const reason = String((e && (e.reason || e.message)) || "");
        if (/wait betBlock\+1/.test(reason)) { await waitHead(provider, bb + 2 + attempt); continue; }
        if (/admission/.test(reason)) { wall = true; break; } // реальная стена — мягкий стоп
        throw e;
      }
    }
    if (wall) { stopReason = "стена адмиссии — свип вернёт выигрыш в банкролл"; break; }
    if (!ok) { stopReason = "не удалось отправить chained spin"; break; }
    const ev = findEvent(rec, "SpinResolved");
    if (ev) { tally(ev.args); console.log(line(ev.args)); }
    started = findEvent(rec, "SpinStarted");
    if (!started) { stopReason = "нет SpinStarted в chained tx"; break; }
    bb = started.args.betBlock.toNumber();
    if (i % 10 === 0) {
      console.log(
        `── ${i}/${spins} | спинов ${st.spins} | W/L ${st.wins}/${st.losses} | ` +
        `RTP ${pct(st.paid, st.wagered).toFixed(1)}% | дом нетто ${F(st.wagered.sub(st.paid))} USDT`
      );
    }
  }

  // ── Финальный resolve последней сессии (и при аварийном выходе тоже) ──
  await settlePending();

  // ── Пост-ран свип (только тест-кошельки): выигрыш кошелька вносится
  // обратно в банкролл как LP — машина не истощается между прогонами
  // разных кошельков, следующий стартует с полным буфером ──
  if (playerIdx > 0) {
    const bal = await usdt.balanceOf(me);
    const keep = ethers.utils.parseEther("1"); // кошельку оставляем 1 USDT
    const sweep = bal.sub(keep);
    if (sweep.gt(ethers.utils.parseEther("0.1"))) {
      try {
        await (await slots.deposit(sweep)).wait();
        console.log(`свип: ${F(sweep)} USDT игрока → LP-банкролл (для следующего кошелька)`);
      } catch (e) {
        console.log(`свип не удался: ${String((e && (e.reason || e.message)) || e).slice(0, 120)}`);
      }
    }
  }

  // ── Отчёт ──
  const net = st.wagered.sub(st.paid).sub(st.refunded);
  const bnb1 = await wallet.getBalance();
  const [eqAfter, fbAfter] = await Promise.all([slots.equity(), slots.freeBankroll()]);
  const min = Math.round((Date.now() - t0) / 60000);
  console.log("\n════════ ИТОГ ════════");
  console.log(`причина остановки : ${stopReason || "план выполнен"}`);
  console.log(`спинов            : ${st.spins} (план ${spins}) за ~${min} мин`);
  console.log(`оборот (wagered)  : ${F(st.wagered)} USDT`);
  console.log(`выплачено игрокам : ${F(st.paid)} | refund-ов: ${st.refunds} (${F(st.refunded)})`);
  console.log(`дом нетто         : ${F(net)} USDT (${net.gte(0) ? "+" : ""}${pct(net.abs(), st.wagered).toFixed(1)}%)`);
  console.log(`RTP наблюдаемый   : ${pct(st.paid, st.wagered).toFixed(2)}% (ожидание 94.98%)`);
  console.log(`W/L               : ${st.wins}/${st.losses} | пары ${st.pairs} | тройки ${st.triples}`);
  console.log(`газ               : ${ethers.utils.formatEther(bnb0.sub(bnb1))} BNB`);
  console.log(`банкролл после    : equity ${F(eqAfter)} | fb ${F(fbAfter)}`);
  if (stopReason && st.spins < spins) process.exitCode = 2;
}

main().catch((e) => {
  console.error("FATAL:", (e && (e.reason || e.message)) || e);
  process.exitCode = 1;
});
