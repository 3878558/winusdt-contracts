// Живой смоук-тест Slots (PvC) на BSC Testnet/Mainnet: полный цикл спина
// с офчейн-детерминизм-пруфом (повтор урока test/slots.test.cjs).
//
// Запуск: node scripts/smokeSlots.cjs testnet 0x<адрес Slots> [bankrollUSDT=300]
//
// Цикл: owner заливает LP-банкролл (адмиссия требует fb ≥ 99×bet) →
// эфемерный игрок approve+spin(minBet) → ждём betBlock+2 (окно blockhash
// ≤256 — торопиться некуда, тянуть тоже нельзя) → resolve() →
// ОФЧЕН-ПЕРЕСЧЁТ seed и сверка с событием SpinResolved + on-chain
// evaluate() и JS-зеркалом → бухгалтерия (escrow 0, сессия закрыта,
// дельта баланса игрока = payout − bet).

require("dotenv").config();
const fs = require("fs");
const path = require("path");
const { ethers } = require("ethers");

const network = process.argv[2];
const slotsAddr = process.argv[3];
const BANKROLL_USDT = process.argv[4] || "300";

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
  "function approve(address,uint256) returns (bool)",
  "function transfer(address,uint256) returns (bool)",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── JS-зеркало математики (§2.2/2.3) — как в test/slots.test.cjs ──
function symbolOf(r) {
  if (r < 20) return 0; // 🍒
  if (r < 36) return 1; // 🍋
  if (r < 49) return 2; // 🍇
  if (r < 59) return 3; // 🔔
  if (r < 66) return 4; // ⭐
  if (r < 70) return 5; // 💎
  return 6;             // 7️⃣
}
const TRIPLE_BPS = [30000, 50000, 80000, 120000, 200000, 400000, 1000000];
const PAIR_BPS = [16000, 14000, 10000, 12000, 25000, 40000, 250000];

function evaluateJs(seedHex, betBN) {
  const seedBN = ethers.BigNumber.from(seedHex);
  const W = ethers.BigNumber.from(72);
  const r1 = seedBN.mod(W).toNumber();
  const r2 = seedBN.div(W).mod(W).toNumber();
  const r3 = seedBN.div(W.mul(W)).mod(W).toNumber();
  const syms = [symbolOf(r1), symbolOf(r2), symbolOf(r3)];
  let bps = 0;
  if (syms[0] === syms[1] && syms[1] === syms[2]) bps = TRIPLE_BPS[syms[0]];
  else if (syms[0] === syms[1]) bps = PAIR_BPS[syms[0]];
  else if (syms[0] === syms[2]) bps = PAIR_BPS[syms[0]];
  else if (syms[1] === syms[2]) bps = PAIR_BPS[syms[1]];
  return { syms, payout: betBN.mul(bps).div(10000) };
}

// ВАЖНО (урок фазы 3): контракт считает seed через abi.encode — PADDED
// (address = 32 байта). solidityKeccak256 тут ДАЁТ ДРУГОЙ хеш (packed).
const seedFor = (h, player, bet) =>
  ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "uint256"], [h, player, bet])
  );

async function main() {
  if (!network || !slotsAddr || !USDT_ADDRESS_BY_NETWORK[network]) {
    console.error("Запуск: node scripts/smokeSlots.cjs testnet 0x<Slots> [bankrollUSDT=300]");
    process.exit(1);
  }
  const artifact = JSON.parse(fs.readFileSync(
    path.join(__dirname, "..", "artifacts", "contracts", "Slots.sol", "Slots.json"), "utf8"));

  const provider = new ethers.providers.JsonRpcProvider(rpcUrl);
  const owner = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const slots = new ethers.Contract(slotsAddr, artifact.abi, owner);
  const usdt = new ethers.Contract(usdtAddress, ERC20_ABI, owner);
  const dec = await usdt.decimals();
  const U = (n) => ethers.utils.parseUnits(String(n), dec);
  const F = (n) => ethers.utils.formatUnits(n, dec);

  console.log("Смоук Slots:", slotsAddr, "| сеть:", network, "| спонсор:", owner.address);

  // ── 0. Preflight ──
  const [minBet, maxBetCap, feeShare, paused] = await Promise.all([
    slots.minBet(), slots.maxBetCap(), slots.creatorFeeShare(), slots.paused(),
  ]);
  console.log("Параметры: minBet", F(minBet), "| maxBetCap", F(maxBetCap),
    "| feeShare", feeShare.toString(), "bps | paused", paused.toString());
  const ownerUsdt = await usdt.balanceOf(owner.address);
  const ownerBnb = await owner.getBalance();
  console.log("Спонсор: tUSDT", F(ownerUsdt), "| BNB", ethers.utils.formatEther(ownerBnb));
  const bankroll = U(BANKROLL_USDT);
  if (ownerUsdt.lt(bankroll.add(U(1)))) {
    console.error(`Нужно ≥ ${BANKROLL_USDT}+1 USDT у спонсора, есть ${F(ownerUsdt)}`);
    process.exit(1);
  }
  const bet = minBet; // спин на минимальной ставке
  // Адмиссия (§3.4 слой 2): fb ≥ 99×bet — банкролл обязан это покрывать
  if (bankroll.lt(ethers.BigNumber.from(99).mul(bet))) {
    console.error(`Банкролл ${F(bankroll)} < 99×bet — адмиссия отлонит спин`);
    process.exit(1);
  }

  // ── 1. LP-банкролл (идемпотентно: депозит только в пустой пул) ──
  const totalShares0 = await slots.totalShares();
  if (totalShares0.eq(0)) {
    await (await usdt.approve(slotsAddr, bankroll.add(U(1)))).wait();
    await (await slots.deposit(bankroll)).wait();
    const [totalShares, equity, lpVal] = await Promise.all([
      slots.totalShares(), slots.equity(), slots.lpValue(owner.address),
    ]);
    console.log("LP: totalShares", F(totalShares), "| equity", F(equity), "| lpValue", F(lpVal));
    if (!totalShares.eq(bankroll)) throw new Error("первый LP не 1:1");
    if (!lpVal.eq(equity)) throw new Error("lpValue != equity для единственного LP");
  } else {
    console.log("LP-пул уже существует (totalShares", F(totalShares0) + ") — депозит пропущен");
  }
  // Адмиссия смотрит на КОНТРАКТНЫЙ fb (§3.4 слой 2): fb ≥ 99×bet + bet на escrow
  const fbNow = await slots.freeBankroll();
  if (fbNow.lt(ethers.BigNumber.from(99).mul(bet).add(bet))) {
    console.error(`fb контракта ${F(fbNow)} < 99×bet+bet — пополните LP-пул`);
    process.exit(1);
  }

  // ── 2. Эфемерный игрок: газ + ставка ──
  const player = ethers.Wallet.createRandom().connect(provider);
  console.log("Игрок (эфемерный):", player.address);
  await (await owner.sendTransaction({ to: player.address, value: ethers.utils.parseEther("0.0012") })).wait();
  await (await usdt.connect(owner).transfer(player.address, bet)).wait();
  const before = await usdt.balanceOf(player.address);

  // Игрок одобряет контракту списание ставки (в _startSession — transferFrom)
  await (await usdt.connect(player).approve(slotsAddr, bet)).wait();

  // ── 3. spin(minBet): tx 1 из 2 (spin перегружен — ethers v5 требует
  // явную сигнатуру "spin(uint256)", иначе .spin не резолвится) ──
  const spinRec = await (await slots.connect(player)["spin(uint256)"](bet)).wait();
  const betBlock = spinRec.blockNumber;
  console.log("Spin tx:", spinRec.transactionHash, "| betBlock:", betBlock,
    "| escrow:", F(await slots.totalEscrow()), "| exposure:", F(await slots.totalExposure()));

  // ── 4. Ждём betBlock+2 (в betBlock+1 blockhash ещё не существует) ──
  let head = await provider.getBlockNumber();
  while (head < betBlock + 2) { await sleep(3000); head = await provider.getBlockNumber(); }
  console.log("Голова цепи:", head);

  // ── 5. resolve(): tx 2 из 2, от самого игрока ──
  const resRec = await (await slots.connect(player).resolve()).wait();
  console.log("Resolve tx:", resRec.transactionHash);
  const ev = resRec.logs
    .map((l) => { try { return slots.interface.parseLog(l); } catch { return null; } })
    .filter(Boolean)
    .find((p) => p.name === "SpinResolved");
  if (!ev) throw new Error("SpinResolved не найден в receipt");
  const [, eBetBlock, eBet, eBlockHash, eSeed, eSyms, ePayout] = ev.args;

  // ── 6. ОФЧЕН-ПЕРЕСЧЁТ (детерминизм-пруф на живой цепи) ──
  const bbN = eBetBlock.toNumber(); // BigNumber + 1 — конкатенация строк!
  const h = (await provider.getBlock(bbN + 1)).hash;
  const wantSeed = seedFor(h, player.address, eBet);
  const want = evaluateJs(wantSeed, eBet);
  const onchain = await slots.evaluate(eSeed, eBet); // pure: (payout, syms)
  console.log("  blockHash(betBlock+1):", h);
  console.log("  seed событие  :", ethers.BigNumber.from(eSeed).toString());
  console.log("  seed офчейн   :", ethers.BigNumber.from(wantSeed).toString());
  if (eBlockHash !== h) throw new Error("blockHash события != RPC-хешу betBlock+1");
  if (!ethers.BigNumber.from(eSeed).eq(ethers.BigNumber.from(wantSeed))) throw new Error("ОФЧЕН-СИД НЕ СОВПАЛ");
  if (JSON.stringify(eSyms) !== JSON.stringify(want.syms)) throw new Error("символы != JS-зеркалу");
  if (!ePayout.eq(want.payout)) throw new Error("выплата != JS-зеркалу");
  if (!onchain.payout.eq(ePayout) || JSON.stringify(onchain.syms) !== JSON.stringify(eSyms)) {
    throw new Error("on-chain evaluate != событию");
  }
  console.log("  символы:", eSyms.join(","), "| payout:", F(ePayout), "USDT");
  console.log("  ✅ детерминизм: событие == офчейн == on-chain evaluate");

  // ── 7. Бухгалтерия ──
  const [, , , active] = await slots.activeSession(player.address);
  if (active) throw new Error("сессия не закрыта");
  const [escrow, exposure, fb] = await Promise.all([
    slots.totalEscrow(), slots.totalExposure(), slots.freeBankroll(),
  ]);
  if (!escrow.eq(0)) throw new Error("escrow != 0");
  if (!exposure.eq(0)) throw new Error("exposure != 0");
  const after = await usdt.balanceOf(player.address);
  if (!after.sub(before).eq(ePayout.sub(bet))) throw new Error("дельта баланса игрока != payout − bet");
  console.log("Бухгалтерия: escrow 0, exposure 0, fb", F(fb),
    "| игрок", F(before), "→", F(after), `(Δ ${F(after.sub(before))})`);

  console.log("\n=== SMOKE OK ===");
  console.log("Верификация:");
  console.log(`npx hardhat verify --network ${network === "mainnet" ? "bscMainnet" : "bscTestnet"} ${slotsAddr} "${usdtAddress}" "${minBet.toString()}" "${maxBetCap.toString()}" ${feeShare.toString()}`);
}

main().catch((e) => { console.error("SMOKE FAILED:", e.message); process.exitCode = 1; });
