// scripts/slotsKeeper.cjs
//
// Кипер машины Slots v3 (фаза 6s): дожим брошенных сессий + снятие протухших резерваций.
//
// Ð—Ð°Ñ‡ÐµÐ¼: ÑÐµÑÑÐ¸Ñ (escrow + exposure + busy-Ñ„Ð»Ð°Ð³) Ð¶Ð¸Ð²Ñ‘Ñ‚ Ð´Ð¾ settle. Ð˜Ð³Ñ€Ð¾Ðº Ð¼Ð¾Ð¶ÐµÑ‚
// Ð·Ð°ÐºÑ€Ñ‹Ñ‚ÑŒ ÑÑ‚Ñ€Ð°Ð½Ð¸Ñ†Ñƒ/Ð¿Ñ€Ð¾Ð¿Ð°ÑÑ‚ÑŒ â€” Ð¼Ð°ÑˆÐ¸Ð½Ð° Ð¾ÑÑ‚Ð°Ñ‘Ñ‚ÑÑ Ð·Ð°Ð½ÑÑ‚Ð¾Ð¹, LP-Ð¿ÑƒÐ» Ñ‚ÐµÑ€ÑÐµÑ‚
// Ð»Ð¸ÐºÐ²Ð¸Ð´Ð½Ð¾ÑÑ‚ÑŒ, Ð´Ñ€ÑƒÐ³Ð¸Ðµ Ð¸Ð³Ñ€Ð¾ÐºÐ¸ Ð»Ð¾Ð²ÑÑ‚ "machine busy". resolveFor/
// resolveSeriesFor permissionless: Ð»ÑŽÐ±Ð¾Ð¹ Ð°Ð´Ñ€ÐµÑ Ð¼Ð¾Ð¶ÐµÑ‚ Ð´Ð¾Ð¶Ð°Ñ‚ÑŒ Ñ‡ÑƒÐ¶Ð¾Ð¹ Ñ…Ð²Ð¾ÑÑ‚ â€”
// Ð²Ñ‹Ð¿Ð»Ð°Ñ‚Ð° Ð’Ð¡Ð•Ð“Ð”Ð ÑƒÑ…Ð¾Ð´Ð¸Ñ‚ Ð¸Ð³Ñ€Ð¾ÐºÑƒ (Ð¸ÑÑ…Ð¾Ð´ Ð´ÐµÑ‚ÐµÑ€Ð¼Ð¸Ð½Ð¸Ñ€Ð¾Ð²Ð°Ð½ blockhash), ÐºÐ¸Ð¿ÐµÑ€
// Ð»Ð¸ÑˆÑŒ Ð¿Ð»Ð°Ñ‚Ð¸Ñ‚ Ð³Ð°Ð· Ð¸ Ð¾ÑÐ²Ð¾Ð±Ð¾Ð¶Ð´Ð°ÐµÑ‚ Ð¼Ð°ÑˆÐ¸Ð½Ñƒ. Ð•ÑÐ»Ð¸ blockhash decayed (>256

// v3: settle НЕ освобождает машину — она уходит в пост-settle резервацию
// игрока на RESERVE_TTL=90с (сосед не перехватит автомат между спинами).
// Кипер делает две вещи: (1) дожимает брошенные in-flight сессии как раньше,
// (2) держатель без активной сессии = резервация: если TTL вышел — снимает
// её releaseExpired() (газ ~30k), иначе просто ждёт (idle-поллинг бесплатен).
// Ð±Ð»Ð¾ÐºÐ¾Ð²) â€” ÐºÐ¾Ð½Ñ‚Ñ€Ð°ÐºÑ‚ ÑÐ°Ð¼ Ð²Ð¾Ð·Ð²Ñ€Ð°Ñ‰Ð°ÐµÑ‚ ÑÑ‚Ð°Ð²ÐºÐ¸ (ÑÐ¿Ð¸Ð½Ñ‹ Ð½Ðµ Ð·Ð°ÑÑ‚Ñ€ÐµÐ²Ð°ÑŽÑ‚ Ð½Ð¸ÐºÐ¾Ð³Ð´Ð°).
//
// Ð¦Ð¸ÐºÐ»: poll activePlayer() ÐºÐ°Ð¶Ð´Ñ‹Ðµ POLL ÑÐµÐº (+jitter) â†’ ÐµÑÐ»Ð¸ Ð·Ð°Ð½ÑÑ‚Ð° Ð¸ Ñ…Ð²Ð¾ÑÑ‚
// Ð²Ð¸ÑÐ¸Ñ‚ Ð´Ð¾Ð»ÑŒÑˆÐµ GRACE ÑÐµÐºÑƒÐ½Ð´ (Ð¸ blockhash(bb+1) ÑƒÐ¶Ðµ Ð´Ð¾ÑÑ‚ÑƒÐ¿ÐµÐ½) â†’ resolveFor
// (solo) / resolveSeriesFor (ÑÐµÑ€Ð¸Ñ). ÐŸÐ¾Ð» Ñ€Ð°Ð±Ð¾Ñ‚Ð°ÐµÑ‚ 24/7 â€” ÑÑ‚Ñ€Ð°Ñ…Ð¾Ð²ÐºÐ° Ð½Ðµ Ð·Ð½Ð°ÐµÑ‚
// Ð½Ð¾Ñ‡Ð½Ñ‹Ñ… Ð¾ÐºÐ¾Ð½; "Ñ€ÐµÐ°Ð»Ð¸ÑÑ‚Ð¸Ñ‡Ð½Ð¾ÑÑ‚ÑŒ" Ð² Ñ‚Ð¾Ð¼, Ñ‡Ñ‚Ð¾ tx Ð¾Ñ‚Ð¿Ñ€Ð°Ð²Ð»ÑÑŽÑ‚ÑÑ Ð¢ÐžÐ›Ð¬ÐšÐž Ð¿Ñ€Ð¸
// Ð½Ð°Ð»Ð¸Ñ‡Ð¸Ð¸ Ñ…Ð²Ð¾ÑÑ‚Ð°, idle-Ð¿Ð¾Ð»Ð»Ð¸Ð½Ð³ Ð±ÐµÑÐ¿Ð»Ð°Ñ‚ÐµÐ½ (view-Ð²Ñ‹Ð·Ð¾Ð²Ñ‹).
//
// Ð“Ð°Ñ€Ð°Ð½Ñ‚Ð¸Ð¸ Ð±ÑŽÐ´Ð¶ÐµÑ‚Ð°: Ð³Ð°Ð·-ÐºÐ°Ð¿ (gwei), floor-BNB Ñƒ ÐºÐ¸Ð¿ÐµÑ€Ð° â€” Ð½Ð¸Ð¶Ðµ floor Ð´Ð¾Ð¶Ð¸Ð¼
// Ð¿Ñ€Ð¸Ð¾ÑÑ‚Ð°Ð½Ð°Ð²Ð»Ð¸Ð²Ð°ÐµÑ‚ÑÑ Ñ warning. RPC-Ñ€Ð¾Ñ‚Ð°Ñ†Ð¸Ñ Ð¿Ñ€Ð¸ ÑÐ±Ð¾ÑÑ… (dataseed â†’ dataseed2
// â†’ publicnode). ÐÐ½Ñ‚Ð¸-Ð³Ð¾Ð½ÐºÐ°: Ð¿ÐµÑ€ÐµÐ´ Ð¾Ñ‚Ð¿Ñ€Ð°Ð²ÐºÐ¾Ð¹ Ð¿Ð¾Ð²Ñ‚Ð¾Ñ€Ð½Ð¾ ÑÐ²ÐµÑ€ÑÐµÐ¼ betBlock/n
// ÑÐµÑÑÐ¸Ð¸ â€” ÐµÑÐ»Ð¸ Ð¸Ð³Ñ€Ð¾Ðº ÑÐ°Ð¼ Ð¿ÐµÑ€ÐµÐ²ÐµÑ€Ð½ÑƒÐ» ÑÐµÑÑÐ¸ÑŽ, Ð¶Ð´Ñ‘Ð¼ Ð·Ð°Ð½Ð¾Ð²Ð¾.
//
// Ð—Ð°Ð¿ÑƒÑÐº: node scripts/slotsKeeper.cjs [slotsAddr] [graceSec] [pollSec]
// ÐšÐ¸Ð¿ÐµÑ€ Ð¸Ð´ÐµÐ¼Ð¿Ð¾Ñ‚ÐµÐ½Ñ‚ÐµÐ½ â€” Ñ€ÐµÑÑ‚Ð°Ñ€Ñ‚ Ð±ÐµÐ·Ð¾Ð¿Ð°ÑÐµÐ½.
require("dotenv").config();
const { ethers } = require("ethers");

const MAINNET_DEFAULT = "0x83549454f838243bDB5C359EA85E6Fc6A68b10A9"; // v3 (6s), деплой 2026-11-17
const RPCS = [
  process.env.BSC_MAINNET_RPC,
  "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
].filter(Boolean);

const SLOTS_ABI = [
  "function activePlayer() view returns (address)",
  "function reservedUntil() view returns (uint64)",
  "function activeSession(address) view returns (uint256 bet, uint256 betBlock, uint256 n, bool active)",
  "function resolveFor(address player)",
  "function resolveSeriesFor(address player)",
  "function releaseExpired()",
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
  const MAX_MS = Number(process.env.KEEPER_MAX_MINUTES || 0) * 60 * 1000; // 0 = forever
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
    console.log(`${now()} âš  RPC â†’ ${RPCS[rpcIdx]}`);
  };

  let resolves = 0, released = 0, paidOut = ethers.constants.Zero, refunded = ethers.constants.Zero,
      gasSpent = ethers.constants.Zero, errors = 0, idleChecks = 0;

  const preflight = async () => {
    const bn = await provider.getBlockNumber();
    const [eq, fb, esc, busy, kbn, ru] = await Promise.all([
      slots.equity(), slots.freeBankroll(), slots.totalEscrow(),
      slots.activePlayer(), provider.getBalance(keeper.address),
      slots.reservedUntil(),
    ]);
    console.log(`${now()} ═══ КИПЕР СТАРТ ═══ ${slotsAddr}`);
    console.log(`${now()} блок ${bn} | RPC ${RPCS[rpcIdx]} | grace ${GRACE_SEC}s | poll ${POLL_SEC}s | газ-кап ${ethers.utils.formatUnits(GAS_CAP, "gwei")} gwei | floor ${F(BNB_FLOOR)} BNB`);
    console.log(`${now()} машина: equity ${F(eq)} | fb ${F(fb)} | escrow ${F(esc)} | busy ${busy === ethers.constants.AddressZero ? "свободна" : busy.slice(0, 10)}${Number(ru) > 0 ? ` | резервация до ${new Date(Number(ru) * 1000).toLocaleTimeString("ru-RU", { hour12: false })}` : ""}`);
    console.log(`${now()} ÐºÐ¸Ð¿ÐµÑ€ ${keeper.address}: BNB ${F(kbn)} | resolveFor(solo)/resolveSeriesFor(ÑÐµÑ€Ð¸Ñ) permissionless`);
  };
  await preflight();

  let t0 = Date.now();
  while (true) {
    if (MAX_MS && Date.now() - t0 > MAX_MS) { console.log(`${now()} ⏸ KEEPER_MAX_MINUTES - плановый выход для рестарта (hosted chain)`); process.exit(0); }
    try {
      const bn = await provider.getBlockNumber();
      const busy = await slots.activePlayer();

      if (busy === ethers.constants.AddressZero) {
        idleChecks += 1;
        if (idleChecks % 8 === 1) console.log(`${now()} â€¦Ð¼Ð°ÑˆÐ¸Ð½Ð° ÑÐ²Ð¾Ð±Ð¾Ð´Ð½Ð° (Ð¿Ñ€Ð¾Ð²ÐµÑ€Ð¾Ðº ${idleChecks})`);
        await sleep(POLL_SEC * 1000 + Math.floor(Math.random() * 5000));
        continue;
      }

      let [bet, bb, n, act] = await slots.activeSession(busy);
      if (!act) {
        // v3: держатель без сессии = пост-settle резервация игрока. Пока TTL
        // живёт — просто ждём (idle-поллинг бесплатен); после истечения —
        // permissionless releaseExpired (машина снова свободна для всех).
        const ru = Number(await slots.reservedUntil());
        const nowSec = Math.floor(Date.now() / 1000);
        if (ru !== 0 && nowSec < ru) {
          idleChecks += 1;
          if (idleChecks % 4 === 1) console.log(`${now()} …резервация ${busy.slice(0, 10)} живёт ещё ${ru - nowSec}с — ждём`);
          await sleep(POLL_SEC * 1000);
          continue;
        }
        const gp = await provider.getGasPrice();
        if (gp.gt(GAS_CAP)) {
          console.log(`${now()} ⚠ газ ${ethers.utils.formatUnits(gp, "gwei")} > капа — release отложен`);
          await sleep(30000);
          continue;
        }
        const kbn = await provider.getBalance(keeper.address);
        if (kbn.lt(BNB_FLOOR.add(gp.mul(120000)))) {
          console.log(`${now()} ⛔ BNB кипера ${F(kbn)} ниже floor — release отложен, нужна дозаливка`);
          await sleep(60000);
          continue;
        }
        const tx = await slots.connect(keeper).releaseExpired({ gasPrice: gp, gasLimit: 120000 });
        console.log(`${now()} 🔓 резервация ${busy.slice(0, 10)} протухла (TTL вышел ${ru ? new Date(ru * 1000).toLocaleTimeString("ru-RU", { hour12: false }) : "?"}) — releaseExpired tx ${tx.hash}`);
        const rec = await tx.wait();
        gasSpent = gasSpent.add(rec.gasUsed.mul(rec.effectiveGasPrice || gp));
        released += 1;
        console.log(`${now()} 📊 релизов ${released} | газ ${F(gasSpent)} BNB`);
        await sleep(POLL_SEC * 1000);
        continue;
      }
      bb = Number(bb); n = Number(n);
      const hashReady = bn > bb + 2; // blockhash(bb+1) ÑÑƒÑ‰ÐµÑÑ‚Ð²ÑƒÐµÑ‚ ÑÑ‚Ñ€Ð¾Ð³Ð¾ Ð¿Ð¾Ð·Ð°Ð´Ð¸
      const tBet = (await provider.getBlock(bb)).timestamp;
      const elapsed = Math.floor(Date.now() / 1000) - tBet;
      if (!hashReady || elapsed < GRACE_SEC) { await sleep(5000); continue; }

      // â”€â”€ ÐŸÑ€ÐµÐ´Ð¾Ñ…Ñ€Ð°Ð½Ð¸Ñ‚ÐµÐ»Ð¸ Ð±ÑŽÐ´Ð¶ÐµÑ‚Ð° â”€â”€
      const gasPrice = await provider.getGasPrice();
      if (gasPrice.gt(GAS_CAP)) {
        console.log(`${now()} âš  Ð³Ð°Ð· ${ethers.utils.formatUnits(gasPrice, "gwei")} gwei > ÐºÐ°Ð¿Ð° â€” Ð¿Ñ€Ð¾Ð¿ÑƒÑÐº Ñ†Ð¸ÐºÐ»Ð°`);
        await sleep(30000);
        continue;
      }
      const kbn = await provider.getBalance(keeper.address);
      if (kbn.lt(BNB_FLOOR.add(gasPrice.mul(300000)))) {
        console.log(`${now()} â›” BNB ÐºÐ¸Ð¿ÐµÑ€Ð° ${F(kbn)} Ð½Ð¸Ð¶Ðµ floor â€” Ð´Ð¾Ð¶Ð¸Ð¼ Ð¿Ñ€Ð¸Ð¾ÑÑ‚Ð°Ð½Ð¾Ð²Ð»ÐµÐ½, Ð½ÑƒÐ¶ÐµÐ½ Ð´Ð¾Ð·Ð°Ð»Ð¸Ð²`);
        await sleep(60000);
        continue;
      }

      // â”€â”€ ÐÐ½Ñ‚Ð¸-Ð³Ð¾Ð½ÐºÐ°: ÑÐµÑÑÐ¸Ñ Ð½Ðµ ÑÐ¼ÐµÐ½Ð¸Ð»Ð°ÑÑŒ, Ð¿Ð¾ÐºÐ° Ð¼Ñ‹ Ð¶Ð´Ð°Ð»Ð¸ grace â”€â”€
      const [, bb2, n2, act2] = await slots.activeSession(busy);
      if (!act2 || Number(bb2) !== bb || Number(n2) !== n) {
        console.log(`${now()} ÑÐµÑÑÐ¸Ñ ${busy.slice(0, 10)} ÑÐ¼ÐµÐ½Ð¸Ð»Ð°ÑÑŒ (Ð¸Ð³Ñ€Ð¾Ðº Ð¶Ð¸Ð²) â€” Ð¶Ð´Ñ‘Ð¼ Ð·Ð°Ð½Ð¾Ð²Ð¾`);
        await sleep(2000);
        continue;
      }

      // â”€â”€ Ð”Ð¾Ð¶Ð¸Ð¼ â”€â”€
      const fn = n === 1 ? "resolveFor" : "resolveSeriesFor";
      const gas = await slots.connect(keeper).estimateGas[fn](busy);
      const tx = await slots.connect(keeper)[fn](busy, {
        gasPrice, gasLimit: gas.mul(12).div(10),
      });
      console.log(`${now()} ðŸ”§ Ð´Ð¾Ð¶Ð¸Ð¼Ð°ÑŽ Ñ…Ð²Ð¾ÑÑ‚: Ð¸Ð³Ñ€Ð¾Ðº ${busy.slice(0, 10)} | bet ${F(bet)} Ã— ${n} | Ñ…Ð²Ð¾ÑÑ‚ ${elapsed}s | tx ${tx.hash}`);
      const rec = await tx.wait();
      gasSpent = gasSpent.add(rec.gasUsed.mul(rec.effectiveGasPrice || gasPrice));
      let line = `${now()} âœ… settle ${busy.slice(0, 10)}: `;
      for (const ev of rec.events || []) {
        try {
          if (ev.event === "SpinResolved") {
            if (ev.args.h === ethers.constants.HashZero) {
              refunded = refunded.add(ev.args.bet);
              line += `refund ${F(ev.args.bet)} (decay)`;
            } else {
              paidOut = paidOut.add(ev.args.payout);
              line += `ÑÐ¿Ð¸Ð½ [${ev.args.syms.join(",")}] â†’ Ð²Ñ‹Ð¿Ð»Ð°Ñ‚Ð° ${F(ev.args.payout)}`;
            }
          } else if (ev.event === "SeriesSettled") {
            paidOut = paidOut.add(ev.args.totalPayout);
            refunded = refunded.add(ev.args.totalRefunded);
            line += `ÑÐµÑ€Ð¸Ñ ${Number(ev.args.n)}: Ð²Ñ‹Ð¿Ð»Ð°Ñ‡ÐµÐ½Ð¾ ${F(ev.args.totalPayout)} | refund ${F(ev.args.totalRefunded)}`;
          }
        } catch { /* Ñ‡ÑƒÐ¶Ð¾Ðµ ÑÐ¾Ð±Ñ‹Ñ‚Ð¸Ðµ â€” Ð¸Ð³Ð½Ð¾Ñ€ */ }
      }
      resolves += 1;
      console.log(line);
      console.log(`${now()} ðŸ“Š Ð´Ð¾Ð¶Ð¸Ð¼Ð¾Ð² ${resolves} | Ð²Ñ‹Ð¿Ð»Ð°Ñ‡ÐµÐ½Ð¾ ${F(paidOut)} | refund ${F(refunded)} | Ð³Ð°Ð· ${F(gasSpent)} BNB`);
      const escAfter = await slots.totalEscrow();
      const [mh, mbusy, muntil] = await slots.machineStatus();
      const busyStr = mh === ethers.constants.AddressZero
        ? "свободна ✓"
        : mbusy
          ? (Number(muntil) > 0
            ? `резервация ${mh.slice(0, 10)} (до ${new Date(Number(muntil) * 1000).toLocaleTimeString("ru-RU", { hour12: false })})`
            : `in-flight ${mh.slice(0, 10)}`)
          : `протухла ${mh.slice(0, 10)} (снимем releaseExpired)`;
      console.log(`${now()} машина: escrow ${F(escAfter)} | busy ${busyStr}`);
      await sleep(POLL_SEC * 1000);
    } catch (e) {
      errors += 1;
      console.warn(`${now()} âœ— Ð¾ÑˆÐ¸Ð±ÐºÐ° Ñ†Ð¸ÐºÐ»Ð° (${errors}): ${String((e && (e.reason || e.message)) || e).slice(0, 140)}`);
      if (errors % 3 === 0) switchRpc();
      await sleep(10000);
    }
  }
})().catch((e) => {
  console.error("FATAL:", String(e && e.message ? e.message : e).slice(0, 200));
  process.exitCode = 1;
});
