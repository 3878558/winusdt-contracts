// Скрипт деплоя контракта Slots (PvC-слоты) на BSC Testnet/Mainnet.
// По образцу scripts/deployV2.cjs. Децималы токена читаются динамически:
// TestUSDT testnet = 6, Binance-Peg USDT mainnet = 18 — Slots децимал-агностик.
//
// Bootstrap-параметры (docs/slots-design.md §3.4, §7):
//   minBet 0.5 USDT, maxBetCap 10 USDT, creatorFeeShare 0 (100% edge LP-ам,
//   монетизация поднимается владельцем позже через 24ч тимлок).
//
// Запуск:
//   node scripts/deploySlots.cjs testnet [minBetUSDT] [maxBetCapUSDT] [feeShareBps]
//     дефолты: 0.5, 10, 0
//   node scripts/deploySlots.cjs mainnet

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const USDT_ADDRESS_BY_NETWORK = {
  testnet: "0x2e5fD073A41826c72f229353aFA0558364C0dAcd", // TestUSDT (6 decimals)
  mainnet: "0x55d398326f99059fF775485246999027B3197955", // Binance-Peg USDT (18 decimals)
};

async function main() {
  const network = process.argv[2] || "testnet";
  const MIN_BET_USDT = process.argv[3] || "0.5";
  const MAX_BET_CAP_USDT = process.argv[4] || "10";
  const FEE_SHARE_BPS = process.argv[5] || "0";

  const rpcUrl = network === "mainnet"
    ? (process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org")
    : (process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545");

  const usdtAddress = USDT_ADDRESS_BY_NETWORK[network];
  if (!usdtAddress) {
    console.error(`Неизвестная сеть "${network}"`);
    process.exit(1);
  }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) {
    console.error("DEPLOYER_PRIVATE_KEY не задан в .env");
    process.exit(1);
  }

  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "Slots.sol", "Slots.json");
  if (!fs.existsSync(artifactPath)) {
    console.error("Артефакт не найден. Сначала: npx hardhat compile");
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  console.log("Сеть:", network, rpcUrl);
  console.log("Деплой с адреса:", wallet.address);

  const balance = await wallet.getBalance();
  console.log("Баланс:", ethers.utils.formatEther(balance), "BNB");
  if (balance.eq(0)) {
    console.error("Нет BNB для газа.");
    process.exit(1);
  }

  const usdtDecimals = await new ethers.Contract(
    usdtAddress, ["function decimals() view returns (uint8)"], provider
  ).decimals();
  const minBet = ethers.utils.parseUnits(MIN_BET_USDT, usdtDecimals).toString();
  const maxBetCap = ethers.utils.parseUnits(MAX_BET_CAP_USDT, usdtDecimals).toString();
  const feeShare = Number(FEE_SHARE_BPS);
  if (!Number.isInteger(feeShare) || feeShare < 0 || feeShare > 5000) {
    console.error("feeShareBps должен быть целым 0..5000 (FEE_SHARE_MAX)");
    process.exit(1);
  }

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log("\nПараметры конструктора Slots:");
  console.log("  USDT:", usdtAddress, `(decimals=${usdtDecimals})`);
  console.log("  minBet:", minBet, `(${MIN_BET_USDT} USDT)`);
  console.log("  maxBetCap:", maxBetCap, `(${MAX_BET_CAP_USDT} USDT; maxBet = fb/300, floor minBet)`);
  console.log("  creatorFeeShare:", feeShare, "bps (bootstrap 0 = 100% edge LP-ам)");

  console.log("\nОтправка транзакции деплоя...");
  const contract = await factory.deploy(usdtAddress, minBet, maxBetCap, feeShare);

  console.log("Tx hash:", contract.deployTransaction.hash);
  await contract.deployed();

  console.log("\n=========================================");
  console.log("Slots задеплоен:", contract.address);
  console.log("=========================================");
  console.log("\nДальше (смок живого цикла):");
  console.log(`  node scripts/smokeSlots.cjs ${network} ${contract.address} [bankrollUSDT=300]`);
  console.log("\nВерификация на BscScan:");
  console.log(`npx hardhat verify --network ${network === "mainnet" ? "bscMainnet" : "bscTestnet"} ${contract.address} "${usdtAddress}" "${minBet}" "${maxBetCap}" ${feeShare}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
