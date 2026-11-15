// scripts/sweepWallets.cjs
//
// Обратная раздаче (disperseSlots.cjs): после марафона собираем тестовые
// деньги с кошельков TEST_PRIVATE_KEYS — USDT депозитом в машину Slots
// (approve + deposit), BNB (сверх держания на газ) — в казну.
// Кошельки с EIP-7702 делегацией: исходящие tx работают штатно.
//
// Запуск: node scripts/sweepWallets.cjs [slotsAddr] [keepUsdt=1] [keepBnb=0.003] [minSweepUsdt=0.5]
require("dotenv").config();
const { ethers } = require("ethers");

const USDT = "0x55d398326f99059fF775485246999027B3197955"; // Binance-Peg BSC mainnet

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
];
const SLOTS_ABI = [
  "function totalEscrow() view returns (uint256)",
  "function totalShares() view returns (uint256)",
  "function equity() view returns (uint256)",
  "function freeBankroll() view returns (uint256)",
  "function lpShares(address) view returns (uint256)",
  "function activePlayer() view returns (address)",
  "function deposit(uint256 amount)",
];

(async () => {
  const slotsAddr = process.argv[2] || "0xC99caA15e1C3CDdBb458acdbBED584279766bCdb";
  const keepUsdt = ethers.utils.parseEther(process.argv[3] || "1");   // держание USDT на кошельке
  const keepBnb = ethers.utils.parseEther(process.argv[4] || "0.003"); // держание BNB (газ-запас)
  const minSweep = ethers.utils.parseEther(process.argv[5] || "0.5"); // меньше — не трогаем

  const provider = new ethers.providers.JsonRpcProvider(
    process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org"
  );
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const usdt = new ethers.Contract(USDT, ERC20_ABI, provider);
  const slots = new ethers.Contract(slotsAddr, SLOTS_ABI, provider);
  const F = (x) => ethers.utils.formatEther(x);

  const keys = (process.env.TEST_PRIVATE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!keys.length) throw new Error("TEST_PRIVATE_KEYS пуст");
  const wallets = keys.map((k) => new ethers.Wallet(k, provider));

  // машина должна быть свободна: deposit при активной сессии не запрещён,
  // но escrow != 0 означает незакрытую сессию — лучше дожать сначала
  const busy = await slots.activePlayer();
  const esc = await slots.totalEscrow();
  if (busy !== ethers.constants.AddressZero) throw new Error(`машина занята (${busy}) — сначала дожмите сессию`);
  if (esc.gt(0)) throw new Error(`escrow не пуст (${F(esc)})`);

  const eqBefore = await slots.equity();
  console.log(`машина ${slotsAddr}: equity до свипа ${F(eqBefore)} USDT`);

  let sweptUsdt = ethers.constants.Zero;
  let sweptBnb = ethers.constants.Zero;
  for (let i = 0; i < wallets.length; i++) {
    const w = wallets[i];
    const tag = `к${String(i + 1).padStart(2)} ${w.address.slice(0, 8)}`;
    const [uBal, nBal] = await Promise.all([usdt.balanceOf(w.address), provider.getBalance(w.address)]);

    // USDT → deposit в машину
    const sweepUsdt = uBal.sub(keepUsdt);
    if (sweepUsdt.gte(minSweep)) {
      const wUsdt = usdt.connect(w);
      const wSlots = slots.connect(w);
      await (await wUsdt.approve(slotsAddr, sweepUsdt)).wait();
      await (await wSlots.deposit(sweepUsdt)).wait();
      sweptUsdt = sweptUsdt.add(sweepUsdt);
      console.log(`${tag}: deposit ${F(sweepUsdt)} USDT → LP`);
    } else {
      console.log(`${tag}: USDT ${F(uBal)} — пропущен (ниже порога/держание)`);
    }

    // BNB → казна (сверх держания)
    const sweepBnb = nBal.sub(keepBnb);
    if (sweepBnb.gte(ethers.utils.parseEther("0.005"))) {
      try {
        await (await w.sendTransaction({ to: treasury.address, value: sweepBnb, gasLimit: 30000 })).wait();
        sweptBnb = sweptBnb.add(sweepBnb);
        console.log(`${tag}: BNB ${F(sweepBnb)} → казна`);
      } catch (e) {
        console.warn(`${tag}: BNB не ушёл (${(e && (e.reason || e.message)) || e}) — оставлен на месте`);
      }
    }
  }

  const [eqAfter, fbAfter, ts] = await Promise.all([slots.equity(), slots.freeBankroll(), slots.totalShares()]);
  console.log("\n════════ ИТОГ ════════");
  console.log(`машина: equity ${F(eqAfter)} | fb ${F(fbAfter)} | maxBet = ${F(fbAfter.div(300))} USDT`);
  console.log(`казна : USDT ${F(await usdt.balanceOf(treasury.address))} | BNB ${F(await provider.getBalance(treasury.address))}`);
  console.log(`собрано: ${F(sweptUsdt)} USDT в LP + ${F(sweptBnb)} BNB в казну`);
})().catch((e) => {
  console.error("FATAL:", (e && (e.reason || e.message)) || e);
  process.exitCode = 1;
});
