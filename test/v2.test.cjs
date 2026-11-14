// Тесты FlexibleLotteryV2. Ключевой сценарий — реплей реальной атаки
// снайпер-бота (инцидент 2026-11-05): на V1 она приносит гарантированный
// выигрыш, на V2 — структурно невозможна. Плюс полные пути fill-or-refund.
//
// Намеренно без chai/@nomicfoundation/hardhat-chai-matchers (в package.json
// их нет) — минимальный локальный шим ассертов, ноль новых зависимостей.
// ethers v5 — прямо из package.json проекта (плагин hardhat-ethers не
// установлен), поверх in-process провайдера Hardhat Network.
const hre = require("hardhat");
const ethers = require("ethers");

function expect(actual) {
  return {
    to: {
      equal(expected) {
        const a = String(actual), e = String(expected);
        if (a !== e) throw new Error(`expected ${e}, got ${a}`);
      },
      be: {
        greaterThan(n) {
          if (!(Number(actual) > Number(n))) throw new Error(`expected > ${n}, got ${actual}`);
        },
      },
    },
  };
}
async function expectRevert(promise, reasonSubstr) {
  let err = null;
  try { await promise; } catch (e) { err = e; }
  if (!err) throw new Error(`ожидали revert с "${reasonSubstr}", транзакция прошла`);
  const msg = String(err.message) + String(err.info?.error?.message || "");
  if (!msg.includes(reasonSubstr)) {
    throw new Error(`ожидали revert с "${reasonSubstr}", получили: ${msg.slice(0, 300)}`);
  }
}

const provider = new ethers.providers.Web3Provider(hre.network.provider);

const ARTIFACT_FILE = {
  TestUSDT: "TestUSDT",
  FlexibleLottery: "FlexibleLottery",
  FlexibleLotteryV2: "FlexibleLotteryV2",
  SniperBotV1: "SniperBots", // оба бота в одном файле SniperBots.sol
  SniperBotV2: "SniperBots",
};

async function deployContract(name, signer, ...args) {
  const art = require(`../artifacts/contracts/${ARTIFACT_FILE[name]}.sol/${name}.json`);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await factory.deploy(...args);
  await c.deployed();
  return c;
}

const P = (n) => ethers.utils.parseEther(String(n));
const FMT = (n) => ethers.utils.formatEther(n);
const KECCAK_PACKED = (types, vals) => ethers.utils.solidityKeccak256(types, vals);

const HOUR = 3600;
const MAX = ethers.constants.MaxUint256;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) await hre.network.provider.send("evm_mine");
}
async function timeTravel(sec) {
  await hre.network.provider.send("evm_increaseTime", [sec]);
  await hre.network.provider.send("evm_mine");
}

describe("WinUSDT FlexibleLotteryV2 — security & lifecycle", function () {
  let usdt, v1, v2, botV1, botV2;
  let owner, victim, stranger, players;

  beforeEach(async function () {
    const accounts = await provider.listAccounts();
    // JsonRpcSigner в ethers v5 не имеет свойства .address — проставляем сами
    const signerFor = (addr) => { const s = provider.getSigner(addr); s.address = addr; return s; };
    owner = signerFor(accounts[0]);
    victim = signerFor(accounts[1]);
    stranger = signerFor(accounts[2]);
    players = accounts.slice(3, 16).map(signerFor);

    usdt = await deployContract("TestUSDT", owner);
    // V1 — уязвимый (5 аргументов)
    v1 = await deployContract("FlexibleLottery", owner, usdt.address, P("5"), 10, 1, 10);
    // V2 — fill-or-refund (7 аргументов)
    v2 = await deployContract("FlexibleLotteryV2", owner, usdt.address, P("5"), 10, 1, 10, HOUR, HOUR);

    botV1 = await deployContract("SniperBotV1", owner, v1.address, usdt.address);
    botV2 = await deployContract("SniperBotV2", owner, v2.address, usdt.address);

    // кошелёк жертвы: 1000 USDT + approve обоим лотереям
    await usdt.mint(victim.address, P("1000"));
    await usdt.connect(victim).approve(v1.address, MAX);
    await usdt.connect(victim).approve(v2.address, MAX);
    // каждому тестовому игроку — по 1000 USDT + approve
    for (const pl of players) {
      await usdt.mint(pl.address, P("1000"));
      await usdt.connect(pl).approve(v2.address, MAX);
      await usdt.connect(pl).approve(v1.address, MAX);
    }
    // ботам — по билету
    await usdt.mint(botV1.address, P("5"));
    await usdt.mint(botV2.address, P("5"));
    await botV1.arm();
    await botV2.arm();
  });

  it("V1 (РЕПЛЕЙ АТАКИ): снайпер атомарно выигрывает у одиночного игрока", async function () {
    // Жертва покупает первый билет раунда V1
    await v1.connect(victim).buyTickets(1);

    // Бот повторяет атаку до выигрыша (в реальности — в новых блоках;
    // каждая неудача = полный revert, потерь нет)
    let won = false;
    for (let attempt = 0; attempt < 30 && !won; attempt++) {
      try {
        await botV1.attack();
        won = true;
      } catch {
        await mineBlocks(1);
      }
    }
    expect(won, "бот обязан в конце концов выиграть (так и было на проде)").to.equal(true);

    const botBal = await usdt.balanceOf(botV1.address);
    expect(FMT(botBal)).to.equal("9.5"); // поставил 5, забрал 9.5 — жертва оплачена
  });
  it("V2: та же атака структурно невозможна (revert, билет жертвы цел)", async function () {
    await v2.connect(victim).buyTickets(1);

    let reverted = false;
    try {
      await botV2.attack();
    } catch {
      reverted = true; // triggerDraw в той же tx невозможен: раунд не FULL
    }
    expect(reverted).to.equal(true);

    // Бот не потерял ни копейки (revert откатил и покупку билета)
    expect(FMT(await usdt.balanceOf(botV2.address))).to.equal("5.0");
    // Билет жертвы на месте, раунд жив
    expect(await v2.getTotalTickets()).to.equal(1);
    expect(await v2.getMyTickets(victim.address)).to.equal(1);
  });

  it("V2 happy path: 10/10 → commit → draw → claim → новый раунд", async function () {
    const ten = players.slice(0, 10);
    for (const pl of ten) await v2.connect(pl).buyTickets(1);

    expect(await v2.state()).to.equal(3); // FULL
    const fillBlock = await v2.fillBlock();

    // Мгновенный розыгрыш невозможен: ни commit, ни draw ещё не доступны
    await expectRevert(v2.triggerDraw(), "Hash not committed yet");
    await expectRevert(v2.commitHash(), "Too early: commit delay");

    // Проходит COMMIT_DELAY блоков — любой захватывает хеш
    await mineBlocks(20);
    await v2.connect(stranger).commitHash();
    expect(await v2.hashCommitted()).to.equal(true);

    // Победитель детерминирован захваченным хешем — проверяем формулу из JS
    const h = await v2.committedHash();
    const seed = BigInt(KECCAK_PACKED(["bytes32", "uint256", "uint256"], [h, 1, 10]));
    const winIndex = Number(seed % 10n);
    const expectedWinner = await v2.tickets(winIndex);

    await v2.connect(stranger).triggerDraw();
    expect(await v2.lastWinner()).to.equal(expectedWinner);
    expect(await v2.state()).to.equal(2); // CLOSED

    // Победитель забирает 47.5, создатель — 2.5 комиссии, раунд новый
    const winnerSigner = ten.find((s) => s.address === expectedWinner);
    const balBefore = await usdt.balanceOf(expectedWinner);
    const ownerBefore = await usdt.balanceOf(owner.address);

    await v2.connect(winnerSigner).claimPrize();
    expect(FMT((await usdt.balanceOf(expectedWinner)).sub(balBefore))).to.equal("47.5");
    expect(FMT((await usdt.balanceOf(owner.address)).sub(ownerBefore))).to.equal("2.5");

    expect(await v2.roundId()).to.equal(2);
    expect(await v2.state()).to.equal(0); // OPEN
    expect(await v2.roundDeadline()).to.equal(0); // новый раунд не тикает

    const res = await v2.getRoundResult(1);
    expect(res.hasResult).to.equal(true);
    expect(res.refunded).to.equal(false);
    expect(res.winner).to.equal(expectedWinner);
  });

  it("V2 недонабор: 3/10, час прошёл → permissionless refundAll 100%", async function () {
    for (const pl of players.slice(0, 3)) await v2.connect(pl).buyTickets(1);
    expect(Number(await v2.roundDeadline())).to.be.greaterThan(0);

    // После истечения окна покупать нельзя
    await timeTravel(HOUR + 1);
    await expectRevert(v2.connect(players[5]).buyTickets(1), "Round window expired");

    // Любой (stranger) возвращает всем 100%
    const before = [];
    for (const pl of players.slice(0, 3)) before.push(await usdt.balanceOf(pl.address));
    await v2.connect(stranger).refundAll();
    for (let i = 0; i < 3; i++) {
      expect(FMT((await usdt.balanceOf(players[i].address)).sub(before[i]))).to.equal("5.0");
    }

    const res = await v2.getRoundResult(1);
    expect(res.refunded).to.equal(true);
    expect(res.hasResult).to.equal(true);
    expect(await v2.roundId()).to.equal(2);
    expect(await v2.state()).to.equal(0);
    expect(await v2.getTotalTickets()).to.equal(0);
  });

  it("V2 страховка: FULL, но окно commit пропущено и никто не дёрнул draw → refundAll", async function () {
    for (const pl of players.slice(0, 10)) await v2.connect(pl).buyTickets(1);
    expect(await v2.state()).to.equal(3);

    await mineBlocks(300); // окно COMMIT_WINDOW (250) истекло
    await expectRevert(v2.commitHash(), "Too late: hash window missed");

    // Розыгрыш уже никогда не состоится → через grace срабатывает возврат
    await timeTravel(HOUR + HOUR + 1);
    expect(await v2.canRefund()).to.equal(true);

    const before = [];
    for (const pl of players.slice(0, 10)) before.push(await usdt.balanceOf(pl.address));
    await v2.connect(stranger).refundAll();
    for (let i = 0; i < 10; i++) {
      expect(FMT((await usdt.balanceOf(players[i].address)).sub(before[i]))).to.equal("5.0");
    }
    expect((await v2.getRoundResult(1)).refunded).to.equal(true);
  });
  // __TESTS2__
});
