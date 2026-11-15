// scripts/rebalanceLp.cjs
//
// Снижение LP-экспозиции машины Slots (решение владельца: «оставь на
// контракте 100, остальное верни создателю»). Два шага:
//   1) LP-кошельки из TEST_PRIVATE_KEYS выводят ВСЕ доли (withdraw),
//      полученный USDT переводят в казну;
//   2) казна выводит свои доли так, чтобы equity машины остался ≈ KEEP USDT.
// Машина должна быть свободна (escrow=0) — coverage guard это не требует,
// но так безопаснее. Цена доли при выводах не меняется (пропорциональность).
//
// Запуск: node scripts/rebalanceLp.cjs [slotsAddr] [keepUsdt=100]
require("dotenv").config();
const { ethers } = require("ethers");

const USDT = "0x55d398326f99059fF775485246999027B3197955";

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const SLOTS_ABI = [
  "function totalEscrow() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function equity() view returns (uint256)",
  "function lpShares(address) view returns (uint256)",
  "function activePlayer() view returns (address)",
  "function withdraw(uint256 shares)",
];

(async () => {
  const slotsAddr = process.argv[2] || "0xC99caA15e1C3CDdBb458acdbBED584279766bCdb";
  const keep = ethers.utils.parseEther(process.argv[3] || "100"); // сколько USDT остаётся в LP

  const provider = new ethers.providers.JsonRpcProvider(
    process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org"
  );
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const slots = new ethers.Contract(slotsAddr, SLOTS_ABI, provider);
  const F = (x) => ethers.utils.formatEther(x);

  const busy = await slots.activePlayer();
  if (busy !== ethers.constants.AddressZero) throw new Error(`машина занята (${busy})`);

  const keys = (process.env.TEST_PRIVATE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const wallets = keys.map((k) => new ethers.Wallet(k, provider));

  // ── Шаг 1: LP-кошельки выводят всё, USDT → казна ──
  let walletsOut = ethers.constants.Zero;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const shares = await slots.lpShares(w.address);
    if (shares.isZero()) continue;
    const tag = `к${String(i + 1).padStart(2)} ${w.address.slice(0, 8)}`;
    const value = shares.mul(await slots.equity()).div(await slots.totalShares());
    await (await slots.connect(w).withdraw(shares)).wait();
    const bal = await usdt.balanceOf(w.address);
    await (await usdt.connect(w).transfer(treasury.address, bal)).wait();
    walletsOut = walletsOut.add(bal);
    console.log(`${tag}: withdraw ${F(shares)} долей (~${F(value)} USDT) → ${F(bal)} USDT в казну`);
  }
  if (walletsOut.gt(0)) console.log(`шаг 1 готов: от кошельков ${F(walletsOut)} USDT в казну`);

  // ── Шаг 2: казна выводит до остатка ≈ keep ──
  const eq = await slots.equity();       // после выводов кошельков
  const ts = await slots.totalShares();  // теперь только доли казны (+ прочие внешние LP, если есть)
  const tShares = await slots.lpShares(treasury.address);
  if (eq.gt(keep)) {
    // долей оставить: keep / (eq/ts); выводим всё сверх этого
    const keepShares = keep.mul(ts).div(eq);
    const burn = tShares.sub(keepShares);
    if (burn.gt(0)) {
      const value = burn.mul(eq).div(ts);
      await (await slots.connect(treasury).withdraw(burn)).wait();
      console.log(`казна: withdraw ${F(burn)} долей → ${F(value)} USDT (оставили в LP ${F(tShares.sub(burn))} долей ≈ ${F(eq.sub(value))} USDT)`);
    } else {
      console.log("казна: доли уже ниже целевого остатка — вывод не нужен");
    }
  } else {
    console.log("казна: equity уже <= keep — вывод не нужен");
  }

  const [eqAfter, tsAfter, tU, tB] = await Promise.all([
    slots.equity(), slots.totalShares(),
    usdt.balanceOf(treasury.address), provider.getBalance(treasury.address),
  ]);
  console.log("\n════════ ИТОГ ════════");
  console.log(`машина: equity ${F(eqAfter)} USDT (цель ≥ ${F(keep)}) | totalShares ${F(tsAfter)} | доля казны ${F(await slots.lpShares(treasury.address))}`);
  console.log(`казна : USDT ${F(tU)} | BNB ${F(tB)}`);
})().catch((e) => {
  console.error("FATAL:", (e && (e.reason || e.message)) || e);
  process.exitCode = 1;
});
