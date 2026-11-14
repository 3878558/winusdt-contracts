// Скрипт деплоя контракта FlexibleLotteryV2 на BSC Testnet/Mainnet.
// По образцу scripts/deploy.cjs, но для 7-аргументного конструктора V2
// (добавлены roundDuration и fullGrace).
//
// Запуск:
//   node scripts/deployV2.cjs testnet [ticketPriceUSDT] [roundDurationSec] [fullGraceSec]
//     дефолты: 10 USDT, 3600 с (1 час), 3600 с
//   node scripts/deployV2.cjs mainnet 5

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
  const TICKET_PRICE_USDT = process.argv[3] || "10";
  const ROUND_DURATION = process.argv[4] || "3600";
  const FULL_GRACE = process.argv[5] || "3600";
  const MAX_TICKETS_TOTAL = "10";
  const MAX_TICKETS_PER_PLAYER = "1";
  const MAX_PLAYERS = "10";

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

  const artifactPath = path.join(__dirname, "..", "artifacts", "contracts", "FlexibleLotteryV2.sol", "FlexibleLotteryV2.json");
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
  const ticketPrice = ethers.utils.parseUnits(TICKET_PRICE_USDT, usdtDecimals).toString();

  const factory = new ethers.ContractFactory(artifact.abi, artifact.bytecode, wallet);

  console.log("\nПараметры конструктора V2:");
  console.log("  USDT_ADDRESS:", usdtAddress, `(decimals=${usdtDecimals})`);
  console.log("  TICKET_PRICE:", ticketPrice, `(${TICKET_PRICE_USDT} USDT)`);
  console.log("  MAX_*: total=10 perPlayer=1 players=10");
  console.log("  roundDuration:", ROUND_DURATION, "сек");
  console.log("  fullGrace:", FULL_GRACE, "сек");

  console.log("\nОтправка транзакции деплоя...");
  const contract = await factory.deploy(
    usdtAddress, ticketPrice,
    MAX_TICKETS_TOTAL, MAX_TICKETS_PER_PLAYER, MAX_PLAYERS,
    ROUND_DURATION, FULL_GRACE
  );

  console.log("Tx hash:", contract.deployTransaction.hash);
  await contract.deployed();

  console.log("\n=========================================");
  console.log("FlexibleLotteryV2 задеплоен:", contract.address);
  console.log("=========================================");
  console.log("\nНе забудьте верифицировать на BscScan:");
  console.log(`npx hardhat verify --network ${network === "mainnet" ? "bscMainnet" : "bscTestnet"} ${contract.address} "${usdtAddress}" "${ticketPrice}" 10 1 10 ${ROUND_DURATION} ${FULL_GRACE}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
