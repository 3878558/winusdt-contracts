// Мейннет-тест FlexibleLotteryV2 с кошельками владельца.
// Ключи ТОЛЬКО из process.env.TEST_PRIVATE_KEYS (10 шт., через запятую) —
// никогда не печатаются. Деплойер (DEPLOYER_PRIVATE_KEY) — казначей:
// концентрирует фонд, выдаёт газ/ставки, запускает commit+draw,
// забирает комиссию; финальный sweep-out возвращает весь USDT на него.
//
// Команды:
//   node scripts/mainnetTestV2.cjs play 5    # полный раунд тира 5 (и т.д. 10/25)
//   node scripts/mainnetTestV2.cjs sweepout  # возврат всего USDT на казначея
//   node scripts/mainnetTestV2.cjs report    # балансы и статус всех трёх тиров
//
// Идемпотентность: каждый шаг проверяет ончейн-состояние; повторный запуск
// продолжается с того же места (купившие билет пропускаются).

require("dotenv").config();
const { ethers } = require("ethers");

const RPC = process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org";
const USDT_ADDR = "0x55d398326f99059fF775485246999027B3197955"; // 18 decimals
const TIERS = {
  5: "0xab3DB18131b21a1758EF5fb16fc157e7604E2a71",
  10: "0x165D7A1bAFAb74aa1fB595ab09633475264BE46D",
  25: "0xc6E473eaf7118Fa10397bE263C251084010d4ED6",
};
const GAS_PER_WALLET = "0.0004"; // BNB на кошелька за раунд
const COMMIT_DELAY = 20;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];
const LOTTERY_ABI = [
  "function buyTickets(uint256 quantity)",
  "function commitHash()",
  "function triggerDraw()",
  "function claimPrize()",
  "function lastWinner() view returns (address)",
  "function roundId() view returns (uint256)",
  "function state() view returns (uint8)",
  "function getTotalTickets() view returns (uint256)",
  "function ticketPrice() view returns (uint256)",
  "function fillBlock() view returns (uint256)",
  "function hashCommitted() view returns (bool)",
  "function committedHash() view returns (bytes32)",
  "function getMyTickets(address) view returns (uint256)",
  "function pendingPrizes(address) view returns (uint256)",
];

const provider = new ethers.providers.JsonRpcProvider(RPC);
const usdt = new ethers.Contract(USDT_ADDR, ERC20_ABI, provider);
const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
const usdtTreasury = usdt.connect(treasury);

function loadPlayers() {
  const raw = process.env.TEST_PRIVATE_KEYS || "";
  const keys = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (keys.length < 10) {
    console.error("В .env TEST_PRIVATE_KEYS — нужно 10 приватных ключей, найдено", keys.length);
    process.exit(1);
  }
  // Ровно 10 игроков: в раунде maxPlayers=10, лишние ключи ревертнули бы
  // buyTickets ("Max players reached"). Деплойер в списке не нужен — он казначей.
  return keys.slice(0, 10).map((k) => new ethers.Wallet(k, provider));
}
async function fundGas(players) {
  console.log("\n[0] FUND-GAS: газ первым (иначе узлы отказывают в estimateGas)…");
  for (const w of players) {
    const gasBal = await provider.getBalance(w.address);
    if (gasBal.lt(ethers.utils.parseEther("0.0001"))) {
      try {
        await (await treasury.sendTransaction({ to: w.address, value: ethers.utils.parseEther(GAS_PER_WALLET) })).wait();
        console.log("  ✅", w.address.slice(0, 8), "— газ выдан");
      } catch (e) { console.warn("  ⚠", w.address.slice(0, 8), "газ не выдан:", String(e.message).slice(0, 100)); }
    } else {
      console.log("  ", w.address.slice(0, 8), "— газ уже есть");
    }
  }
}

async function sweepIn(players) {
  console.log("\n[1] SWEEP-IN: игроки переводят USDT на казначея…");
  for (const w of players) {
    const bal = await usdt.balanceOf(w.address);
    if (Number(String(bal)) === 0) { console.log("  ", w.address.slice(0, 8), "— пусто"); continue; }
    try {
      await (await usdt.connect(w).transfer(treasury.address, bal)).wait();
      console.log("  ", w.address.slice(0, 8), "→", ethers.utils.formatUnits(bal, 18), "USDT");
    } catch (e) { console.warn("  ⚠", w.address.slice(0, 8), "не перевёл:", String(e.message).slice(0, 100)); }
  }
}

async function fund(players, price) {
  console.log("\n[2] FUND: ставки от казначея…");
  for (const w of players) {
    const uBal = await usdt.balanceOf(w.address);
    if (uBal.lt(price)) {
      try {
        await (await usdtTreasury.transfer(w.address, price.sub(uBal))).wait();
      } catch (e) { console.warn("  ⚠", w.address.slice(0, 8), "USDT не долиты:", String(e.message).slice(0, 100)); }
    }
    console.log("  ✅", w.address.slice(0, 8), "— готов:", ethers.utils.formatUnits(await usdt.balanceOf(w.address), 18), "USDT");
  }
}

async function buyAll(players, lottery) {
  console.log("\n[3] BUY: approve + buyTickets(1) у каждого…");
  const price = await lottery.ticketPrice();
  for (const w of players) {
    const mine = Number(String(await lottery.getMyTickets(w.address)));
    if (mine > 0) { console.log("  ", w.address.slice(0, 8), "— уже с билетом"); continue; }
    try {
      await (await usdt.connect(w).approve(lottery.address, price)).wait();
      await (await lottery.connect(w).buyTickets(1)).wait();
      console.log("  ✅", w.address.slice(0, 8), "купил билет");
    } catch (e) {
      console.warn("  ⚠", w.address.slice(0, 8), "не купил:", String(e.message).slice(0, 120));
    }
  }
}

async function waitFullAndDraw(players, lottery) {
  // В ethers v5.7.2 view uint8 неожиданно возвращается числом (не BigNumber),
  // поэтому везде работаем через строки: N() безопасно приводит любые
  // представления (BigNumber | number | string) к JS-числу.
  const N = (x) => Number(String(x));
  let state = N(await lottery.state());
  const roundId = N(await lottery.roundId());

  // CLOSED: приз уже разыгран, ждёт claim победителем.
  if (state === 2) {
    console.log("\n[6] Раунд", roundId, "уже разыгран — claim победителем…");
    const winnerAddr = await lottery.lastWinner();
    const winner = players.find((w) => w.address.toLowerCase() === winnerAddr.toLowerCase())
      || (winnerAddr.toLowerCase() === treasury.address.toLowerCase() ? treasury : null);
    if (!winner) { console.error("Победитель не из тестового списка — claim вручную"); process.exit(1); }
    const prize = await lottery.pendingPrizes(winnerAddr);
    console.log("  Приз:", ethers.utils.formatUnits(prize, 18), "USDT");
    const balBefore = await usdt.balanceOf(winner.address);
    const treasuryBefore = await usdt.balanceOf(treasury.address);
    await (await lottery.connect(winner).claimPrize()).wait();
    console.log("  Зачислено победителю:", ethers.utils.formatUnits((await usdt.balanceOf(winner.address)).sub(balBefore), 18), "USDT");
    console.log("  Комиссия вернулась казначею:", ethers.utils.formatUnits((await usdt.balanceOf(treasury.address)).sub(treasuryBefore), 18), "USDT");
    console.log("  Новый roundId:", N(await lottery.roundId()));
    console.log("\n=== РАУНД ПРОЙДЕН ===");
    return;
  }

  // FULL: ждём COMMIT_DELAY блоков от блока заполнения, затем commit+draw.
  if (state === 3) {
    const fillBlock = N(await lottery.fillBlock());
    console.log("\n[4] Раунд уже FULL, fillBlock:", fillBlock);
    const target = fillBlock + COMMIT_DELAY + 1;
    let bn = await provider.getBlockNumber();
    while (bn < target) { await sleep(1500); bn = await provider.getBlockNumber(); }
  } else {
    // OPEN: ждём заполнения раунда.
    console.log("\n[4] Ожидание заполнения раунда…");
    const deadline = Date.now() + 70 * 60 * 1000;
    while (state !== 3 && Date.now() < deadline) {
      await sleep(5000);
      state = N(await lottery.state());
    }
    if (state !== 3) { console.error("Раунд не заполнился за окно — запустите refundAll и повторите"); process.exit(1); }
    const fillBlock = N(await lottery.fillBlock());
    const target = fillBlock + COMMIT_DELAY + 1;
    let bn = await provider.getBlockNumber();
    while (bn < target) { await sleep(1500); bn = await provider.getBlockNumber(); }
  }

  console.log("\n[5] COMMIT + DRAW (казначей)…");
  if (!(await lottery.hashCommitted())) {
    await (await lottery.connect(treasury).commitHash()).wait();
    console.log("  committedHash:", (await lottery.committedHash()).slice(0, 18) + "…");
  } else {
    console.log("  хеш уже был зафиксирован");
  }
  const rec = await (await lottery.connect(treasury).triggerDraw()).wait();
  console.log("  Draw tx:", rec.transactionHash);

  const winnerAddr = await lottery.lastWinner();
  const prize = await lottery.pendingPrizes(winnerAddr);
  console.log("  Победитель:", winnerAddr, "| приз:", ethers.utils.formatUnits(prize, 18), "USDT");

  console.log("\n[6] CLAIM победителем…");
  const winner = players.find((w) => w.address.toLowerCase() === winnerAddr.toLowerCase())
    || (winnerAddr.toLowerCase() === treasury.address.toLowerCase() ? treasury : null);
  if (!winner) { console.error("Победитель не из тестового списка — claim вручную"); process.exit(1); }
  const balBefore = await usdt.balanceOf(winner.address);
  const treasuryBefore = await usdt.balanceOf(treasury.address);
  await (await lottery.connect(winner).claimPrize()).wait();
  console.log("  Зачислено:", ethers.utils.formatUnits((await usdt.balanceOf(winner.address)).sub(balBefore), 18), "USDT");
  // V2: комиссия 5% автоматически возвращается создателю (= деплойеру =
  // казначею этого теста) внутри того же claim — приз не «сгорает».
  console.log("  Комиссия вернулась казначею:", ethers.utils.formatUnits((await usdt.balanceOf(treasury.address)).sub(treasuryBefore), 18), "USDT");
  console.log("  Новый roundId:", N(await lottery.roundId()));
  console.log("\n=== РАУНД ПРОЙДЕН ===");
}

async function sweepOut(players) {
  console.log("\n[SWEEP-OUT] весь USDT → казначей…");
  for (const w of players) {
    const bal = await usdt.balanceOf(w.address);
    if (Number(String(bal)) === 0) continue;
    await (await usdt.connect(w).transfer(treasury.address, bal)).wait();
    console.log("  ", w.address.slice(0, 8), "→", ethers.utils.formatUnits(bal, 18), "USDT");
  }
  console.log("Казначей:", ethers.utils.formatUnits(await usdt.balanceOf(treasury.address), 18), "USDT");
}

async function report() {
  console.log("=== БАЛАНСЫ ===");
  const keyCount = (process.env.TEST_PRIVATE_KEYS || "").split(",").filter(Boolean).length;
  console.log("TEST_PRIVATE_KEYS в .env:", keyCount, "шт.");
  const addrs = [treasury.address];
  if (keyCount > 0) addrs.push(...loadPlayers().map((w) => w.address));
  for (const a of addrs) {
    console.log(a.slice(0, 10), "| USDT:", ethers.utils.formatUnits(await usdt.balanceOf(a), 18), "| BNB:", ethers.utils.formatEther(await provider.getBalance(a)));
  }
  for (const t of Object.keys(TIERS)) {
    const c = new ethers.Contract(TIERS[t], LOTTERY_ABI, provider);
    console.log("tier" + t + ": roundId", (await c.roundId()).toString(), "state", (await c.state()).toString(), "tickets", (await c.getTotalTickets()).toString());
  }
}

(async () => {
  const cmd = process.argv[2] || "report";
  const tier = process.argv[3];
  if (cmd === "report") await report();
  else if (cmd === "sweepout") await sweepOut(loadPlayers());
  else if (cmd === "play") {
    const lottery = new ethers.Contract(TIERS[tier], LOTTERY_ABI, provider);
    const players = loadPlayers();
    console.log("=== MAINNET ТЕСТ V2, тир", tier, "USDT ===");
    console.log("Контракт:", TIERS[tier]);
    const lotteryABI = lottery;
    await fundGas(players);
    const st = Number(String(await lotteryABI.state()));
    if (st === 0) {
      await sweepIn(players);
      await fund(players, await lotteryABI.ticketPrice());
      await buyAll(players, lotteryABI);
    } else {
      console.log("Раунд не OPEN (state=" + st + ") — пропускаю сбор/покупки, сразу розыгрыш/claim");
    }
    await waitFullAndDraw(players, lotteryABI);
  } else { console.error("Команды: play 5|10|25, sweepout, report"); process.exit(1); }
})().catch((e) => { console.error("FAILED:", e.message); process.exit(1); });
