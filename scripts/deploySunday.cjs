// Скрипт деплоя контракта SundayLottery на BSC Testnet/Mainnet (фаза 7).
// По образцу scripts/deployV2.cjs, но под 4-аргументный конструктор:
//   usdt, ticketPrice, treasury, firstDeadline (воскресенье 18:00 UTC).
// firstDeadline вычисляется автоматически: ближайшее воскресенье 18:00 UTC,
// строго дальше чем через 12 часов от текущего момента (контракт требует
// минимум 30 минут — 12ч даёт продажам полноценное окно до первого дедлайна).
//
// Запуск:
//   node scripts/deploySunday.cjs testnet
//   node scripts/deploySunday.cjs mainnet

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const USDT_ADDRESS_BY_NETWORK = {
  testnet: "0x2e5fD073A41826c72f229353aFA0558364C0dAcd", // TestUSDT (6 decimals)
  mainnet: "0x55d398326f99059fF775485246999027B3197955", // Binance-Peg USDT (18 decimals)
};

// Ближайшее воскресенье 18:00 UTC, строго > now + 12h.
function nextSunday1800UTC() {
  const nowMs = Date.now();
  const d = new Date(nowMs);
  d.setUTCHours(18, 0, 0, 0);
  const daysUntilSunday = (7 - d.getUTCDay()) % 7; // getUTCDay: 0 = воскресенье
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  if (d.getTime() <= nowMs + 12 * 3600 * 1000) d.setUTCDate(d.getUTCDate() + 7);
  return Math.floor(d.getTime() / 1000);
}

async function main() {
  const logFile = path.join(__dirname, "..", "..", "tools", "deploy-sunday.log");
  const log = (s) => {
    const line = typeof s === "string" ? s : JSON.stringify(s);
    fs.appendFileSync(logFile, line + "\n");
    process.stdout.write(line + "\n");
  };
  fs.writeFileSync(logFile, "");

  const network = process.argv[2] || "testnet";
  const TICKET_PRICE_USDT = "10"; // «клуб 100 мест × 10 USDT» — фикс, без аргумента
  const SEAT_CAP = 100;

  const rpcUrl = network === "mainnet"
    ? (process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org")
    : (process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545");

  const usdtAddress = USDT_ADDRESS_BY_NETWORK[network];
  if (!usdtAddress) { log(`Неизвестная сеть "${network}"`); process.exit(1); }

  const privateKey = process.env.DEPLOYER_PRIVATE_KEY;
  if (!privateKey) { log("DEPLOYER_PRIVATE_KEY не задан в .env"); process.exit(1); }

  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "SundayLottery.sol", "SundayLottery.json");
  if (!fs.existsSync(artifactPath)) {
    log("Артефакт не найден. Сначала: npx hardhat compile");
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf8"));

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const wallet = new ethers.Wallet(privateKey, provider);

  log("Сеть: " + network + " " + rpcUrl);
  log("Деплой с адреса: " + wallet.address);
  const balance = await wallet.getBalance();
  log("Баланс: " + ethers.utils.formatEther(balance) + " BNB");
  if (balance.eq(0)) { log("Нет BNB для газа."); process.exit(1); }

  const usdtDecimals = await new ethers.Contract(
    usdtAddress, ["function decimals() view returns (uint8)"], provider
  ).decimals();
  const ticketPrice = ethers.utils.parseUnits(TICKET_PRICE_USDT, usdtDecimals).toString();
  const firstDeadline = nextSunday1800UTC();

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  log("\nПараметры конструктора SundayLottery:");
  log("  USDT_ADDRESS: " + usdtAddress + " (decimals=" + usdtDecimals + ")");
  log("  TICKET_PRICE: " + ticketPrice + " (" + TICKET_PRICE_USDT + " USDT)");
  log("  TREASURY: " + wallet.address + " (деплойер)");
  log("  SEAT_CAP: " + SEAT_CAP + " × 10 USDT = 1000 USDT max pool");
  log("  FIRST_DEADLINE (воскресенье 18:00 UTC): " + firstDeadline);
  log("  = " + new Date(firstDeadline * 1000).toUTCString());

  log("\nОтправка транзакции деплоя...");
  const contract = await factory.deploy(usdtAddress, ticketPrice, wallet.address, firstDeadline);
  log("Tx hash: " + contract.deployTransaction.hash);
  await contract.deployed();

  log("\n=========================================");
  log("SundayLottery задеплоен: " + contract.address);
  log("=========================================");
  log("\nНе забудьте верифицировать на BscScan:");
  log(`npx hardhat verify --network ${network === "mainnet" ? "bscMainnet" : "bscTestnet"} ${contract.address} "${usdtAddress}" "${ticketPrice}" "${wallet.address}" "${firstDeadline}"`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});