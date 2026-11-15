// scripts/disperseSlots.cjs
//
// Раздача тестовых средств: withdraw заданной суммы из машины Slots (казна —
// единственный LP) и раскладка по первым N кошелькам TEST_PRIVATE_KEYS
// (USDT на ставки + BNB на газ). Проверяет, что машина свободна и escrow пуст.
//
// Запуск: node scripts/disperseSlots.cjs [slotsAddr] [amountUSDT=650] [wallets=10] [bnbEach=0.02]
require("dotenv").config();
const { ethers } = require("ethers");

const USDT = "0x55d398326f99059fF775485246999027B3197955"; // Binance-Peg BSC mainnet

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
];
const SLOTS_ABI = [
  "function totalEscrow() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function equity() view returns (uint256)",
  "function freeBankroll() view returns (uint256)",
  "function lpShares(address) view returns (uint256)",
  "function activePlayer() view returns (address)",
  "function withdraw(uint256 shares)",
];

(async () => {
  const slotsAddr = process.argv[2] || "0xC99caA15e1C3CDdBb458acdbBED584279766bCdb";
  const amountStr = process.argv[3] || "650";
  const count = Number(process.argv[4] || 10);
  const bnbEachStr = process.argv[5] || "0.02";

  const provider = new ethers.providers.JsonRpcProvider(
    process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org"
  );
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, treasury);
  const slots = new ethers.Contract(slotsAddr, SLOTS_ABI, treasury);
  const F = (x) => ethers.utils.formatEther(x);

  const keys = (process.env.TEST_PRIVATE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean).slice(0, count);
  if (keys.length < count) throw new Error(`в TEST_PRIVATE_KEYS только ${keys.length} кошельков`);
  const wallets = keys.map((k) => new ethers.Wallet(k, provider));

  const busy = await slots.activePlayer();
  if (busy !== ethers.constants.AddressZero) throw new Error(`машина занята (${busy}) — сначала дожмите сессию`);
  const esc = await slots.totalEscrow();
  if (esc.gt(0)) throw new Error(`escrow не пуст (${F(esc)})`);

  const amt = ethers.utils.parseEther(amountStr);
  const ts = await slots.totalShares();
  const eq = await slots.equity();
  if (eq.gte(amt)) {
    const shares = amt.mul(ts).div(eq);
    console.log(`вывод ${amountStr} USDT (доли ${F(shares)}) из машины ${slotsAddr}…`);
    await (await slots.withdraw(shares)).wait();
  } else {
    console.log(`вывод пропущен: в пуле ${F(eq)} < ${amountStr} (уже выводили?) — раздаём из баланса казны`);
  }
  const tUsdt = await usdt.balanceOf(treasury.address);
  if (tUsdt.lt(amt)) throw new Error(`USDT казны меньше плана: ${F(tUsdt)} < ${amountStr}`);

  const per = amt.div(count);
  const rem = amt.sub(per.mul(count)); // остаток от округления остаётся казне
  const bnbEach = ethers.utils.parseEther(bnbEachStr);
  const tBnb = await provider.getBalance(treasury.address);
  if (tBnb.lt(bnbEach.mul(count).add(ethers.utils.parseEther("0.02")))) {
    throw new Error(`BNB казны не хватает на раздачу: ${F(tBnb)} < ${bnbEachStr}×${count} + резерв 0.02`);
  }
  console.log(`раздача: ${F(per)} USDT + ${bnbEachStr} BNB × ${count} кошельков (остаток округления казне ${F(rem)})`);

  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    await (await usdt.transfer(w.address, per)).wait();
    await (await treasury.sendTransaction({ to: w.address, value: bnbEach })).wait();
    const [b, n] = await Promise.all([usdt.balanceOf(w.address), provider.getBalance(w.address)]);
    console.log(`кошелёк ${String(i + 1).padStart(2)} ${w.address}: USDT ${F(b)} | BNB ${F(n)}`);
  }

  const [eqAfter, fbAfter] = await Promise.all([slots.equity(), slots.freeBankroll()]);
  console.log("\n════════ ИТОГ ════════");
  console.log(`машина: equity ${F(eqAfter)} | fb ${F(fbAfter)} | maxBet = fb/300 = ${F(fbAfter.div(300))} USDT`);
  console.log(`казна : USDT ${F(await usdt.balanceOf(treasury.address))} | BNB ${F(await provider.getBalance(treasury.address))}`);
  console.log(`игрокам роздано: ${F(per.mul(count))} USDT + ${bnbEachStr}×${count} BNB`);
})().catch((e) => {
  console.error("FATAL:", (e && (e.reason || e.message)) || e);
  process.exitCode = 1;
});
