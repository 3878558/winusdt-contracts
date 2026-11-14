// Живой смоук-тест FlexibleLotteryV2 на BSC Testnet: полный цикл раунда
// с 10 эфемеральными кошельками (никогда не сохраняются — уйдут в никуда).
//
// Запуск: node scripts/smokeV2.cjs testnet 0x<адрес V2>
//
// Цикл: 10 игроков покупают билеты → FULL → ждём COMMIT_DELAY блоков →
// commitHash → triggerDraw → победитель claimPrize → проверки сумм.

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const network = process.argv[2];
const lotteryAddr = process.argv[3];

const USDT_ADDRESS_BY_NETWORK = {
  testnet: "0x2e5fD073A41826c72f229353aFA0558364C0dAcd", // TestUSDT, 6 dec
  mainnet: "0x55d398326f99059fF775485246999027B3197955", // 18 dec
};
const usdtAddress = USDT_ADDRESS_BY_NETWORK[network];
const rpcUrl = network === "mainnet"
  ? (process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org")
  : (process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545");

const ERC20_ABI = [
  "function decimals() view returns (uint8)",
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const artifact = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "artifacts", "contracts", "FlexibleLotteryV2.sol", "FlexibleLotteryV2.json"), "utf8"));

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const owner = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const lottery = new ethers.Contract(lotteryAddr, artifact.abi, owner);
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, owner);
  const dec = await usdt.decimals();

  console.log("Смоук V2:", lotteryAddr, "| сеть:", network, "| gas-спонсор:", owner.address);

  const status0 = await lottery.getRoundStatus();
  console.log("Старт: state=", status0.st, "round=", await lottery.roundId());

  // 10 эфемеральных игроков
  const players = [];
  for (let i = 0; i < 10; i++) players.push(ethers.Wallet.createRandom().connect(provider));
  const price = await lottery.ticketPrice();
  console.log("Цена билета:", ethers.utils.formatUnits(price, dec), "USDT");

  // Газ + tUSDT каждому
  console.log("Выдача газа и токенов 10 игрокам…");
  for (const w of players) {
    await (await owner.sendTransaction({ to: w.address, value: ethers.utils.parseEther("0.0012") })).wait();
    await (await usdt.transfer(w.address, price)).wait();
  }

  // approve + buy от каждого
  console.log("Покупка 10 билетов…");
  for (const w of players) {
    await (await usdt.connect(w).approve(lotteryAddr, price)).wait();
    await (await lottery.connect(w).buyTickets(1)).wait();
  }

  const full = await lottery.state();
  const fillBlock = await lottery.fillBlock();
  console.log("state:", full.toString(), "(3=FULL), fillBlock:", fillBlock.toString());

  // Ждём COMMIT_DELAY (20) блоков
  const target = Number(fillBlock) + 20 + 1;
  let bn = await provider.getBlockNumber();
  while (bn < target) { await sleep(2000); bn = await provider.getBlockNumber(); }
  console.log("Дождались блок", bn);

  // Захват хеша + розыгрыш
  await (await lottery.commitHash()).wait();
  console.log("committedHash:", (await lottery.committedHash()).slice(0, 18) + "…");
  const rec = await (await lottery.triggerDraw()).wait();
  console.log("Draw tx:", rec.transactionHash);

  const winnerAddr = await lottery.lastWinner();
  const winner = players.find((w) => w.address.toLowerCase() === winnerAddr.toLowerCase());
  console.log("Победитель:", winnerAddr, winner ? "(экспектед)" : "(?!)");
  const prize = await lottery.pendingPrizes(winnerAddr);
  console.log("Приз:", ethers.utils.formatUnits(prize, dec), "USDT");

  const balBefore = await usdt.balanceOf(winnerAddr);
  await (await lottery.connect(winner).claimPrize()).wait();
  const balAfter = await usdt.balanceOf(winnerAddr);
  console.log("Зачислено победителю:", ethers.utils.formatUnits(balAfter.sub(balBefore), dec), "USDT");

  console.log("Новый раунд:", (await lottery.roundId()).toString(), "state:", (await lottery.state()).toString());
  const res = await lottery.getRoundResult(1);
  console.log("getRoundResult(1): winner", res.winner, "prize", ethers.utils.formatUnits(res.prize, dec), "refunded", res.refunded);

  console.log("\n=== SMOKE OK ===");
}

main().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exitCode = 1; });
