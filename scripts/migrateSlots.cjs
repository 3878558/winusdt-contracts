// scripts/migrateSlots.cjs
//
// Миграция LP-банкролла со старого контракта Slots на новый (v2 эксклюзив).
// Шаги: 1) убедиться, что в СТАРОМ контракте нет активных сессий (escrow=0);
// 2) treasury (единственный LP) withdraw ВСЕХ долей; 3) approve новому;
// 4) deposit всей полученной суммы (в пустой пул — 1:1); 5) отчёт.
//
// Запуск: node scripts/migrateSlots.cjs mainnet <oldAddr> <newAddr>
require("dotenv").config();
const { ethers } = require("ethers");

async function main() {
  const [, , network, oldAddr, newAddr] = process.argv;
  if (!oldAddr || !newAddr) throw new Error("usage: node scripts/migrateSlots.cjs <net> <oldAddr> <newAddr>");
  const rpc = network === "mainnet"
    ? process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org"
    : process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";
  const provider = new ethers.providers.JsonRpcProvider(rpc);
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);

  const ERC20_ABI = [
    "function balanceOf(address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ];
  const SLOTS_ABI = [
    "function totalEscrow() view returns (uint256)",
    "function totalShares() view returns (uint256)",
    "function lpShares(address) view returns (uint256)",
    "function lpValue(address) view returns (uint256)",
    "function equity() view returns (uint256)",
    "function freeBankroll() view returns (uint256)",
    "function maxBetNow() view returns (uint256)",
    "function activePlayer() view returns (address)",
    "function sessions(address) view returns (uint128 bet, uint32 betBlock, uint16 n, bool active)",
    "function withdraw(uint256 shares)",
    "function deposit(uint256 amount)",
  ];
  const usdtAddr = await new ethers.Contract(oldAddr, ["function usdt() view returns (address)"], provider).usdt();
  const usdt = new ethers.Contract(usdtAddr, ERC20_ABI, treasury);
  const oldSlots = new ethers.Contract(oldAddr, SLOTS_ABI, treasury);
  const newSlots = new ethers.Contract(newAddr, SLOTS_ABI, treasury);
  const F = (x) => ethers.utils.formatEther(x);

  console.log(`миграция ${network}: ${oldAddr} → ${newAddr}`);
  console.log(`казна: ${treasury.address}`);

  // 1) Старый пул должен быть пуст от игроков
  const oldEscrow = await oldSlots.totalEscrow();
  if (oldEscrow.gt(0)) throw new Error(`в старом контракте активные сессии (escrow ${F(oldEscrow)}) — миграция отменена`);
  // 2) Вывод всех долей казны (если есть; повторный запуск = только отчёт)
  const shares = await oldSlots.lpShares(treasury.address);
  if (shares.isZero()) {
    console.log("у казны нет долей в старом контракте — миграция уже выполнена, только отчёт");
  } else {
    const value = await oldSlots.lpValue(treasury.address);
    console.log(`withdraw ${F(shares)} долей ≈ ${F(value)} USDT из старого…`);
    await (await oldSlots.withdraw(shares)).wait();
    const got = await usdt.balanceOf(treasury.address);
    console.log(`получено: ${F(got)} USDT | старый контракт: equity ${F(await oldSlots.equity())} (должен быть 0)`);
    // 3-4) approve + deposit в новый (пустой пул → доли 1:1)
    await (await usdt.approve(newAddr, got)).wait();
    await (await newSlots.deposit(got)).wait();
  }

  // 5) Отчёт
  const [newShares, newEq, newFb, active] = await Promise.all([
    newSlots.totalShares(), newSlots.equity(), newSlots.freeBankroll(), newSlots.activePlayer(),
  ]);
  console.log("\n════════ ИТОГ ════════");
  console.log(`новый контракт: totalShares ${F(newShares)} | equity ${F(newEq)} | fb ${F(newFb)} | activePlayer ${active}`);
  console.log(`maxBet = fb/300 = ${F(newFb.div(300))} USDT`);
}

main().catch((e) => { console.error("FATAL:", (e && (e.reason || e.message)) || e); process.exitCode = 1; });
