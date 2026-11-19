// Тесты SundayLottery (фаза 7 — «клуб 100 мест»: 100 × 10 USDT, 1 адрес = 1
// место, розыгрыш каждое воскресенье 18:00 UTC при любом составе ≥ 1,
// пустая неделя пропускается, RNG = blockhash(sealBlock) как в V2).
//
// Намеренно без chai/@nomicfoundation/hardhat-chai-matchers (в package.json
// их нет) — минимальный локальный шим ассертов, ноль новых зависимостей
// (тот же подход, что test/v2.test.cjs). ethers v5 поверх in-process
// провайдера Hardhat Network.
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

async function deployContract(name, signer, ...args) {
  const art = require(`../artifacts/contracts/${name}.sol/${name}.json`);
  const factory = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await factory.deploy(...args);
  await c.deployed();
  return c;
}

const P = (n) => ethers.utils.parseEther(String(n));
const KECCAK_PACKED = (types, vals) => ethers.utils.solidityKeccak256(types, vals);
const HOUR = 3600;
const WEEK = 7 * 24 * HOUR;
const MAX = ethers.constants.MaxUint256;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) await hre.network.provider.send("evm_mine");
}
async function timeTravel(sec) {
  await hre.network.provider.send("evm_increaseTime", [sec]);
  await hre.network.provider.send("evm_mine");
}

// Копия nextSunday1800UTC из scripts/deploySunday.cjs — проверяем, что
// деплой-скрипт действительно даёт воскресенье 18:00:00 UTC в будущем.
function nextSunday1800UTC(nowMs) {
  const d = new Date(nowMs);
  d.setUTCHours(18, 0, 0, 0);
  const daysUntilSunday = (7 - d.getUTCDay()) % 7;
  d.setUTCDate(d.getUTCDate() + daysUntilSunday);
  if (d.getTime() <= nowMs + 12 * 3600 * 1000) d.setUTCDate(d.getUTCDate() + 7);
  return Math.floor(d.getTime() / 1000);
}

describe("WinUSDT SundayLottery — lifecycle & RNG", function () {
  let usdt, sun;
  let owner, players;

  beforeEach(async function () {
    const accounts = await provider.listAccounts();
    const signerFor = (addr) => { const s = provider.getSigner(addr); s.address = addr; return s; };
    owner = signerFor(accounts[0]);
    players = accounts.slice(1, 16).map(signerFor); // 15 кошельков для составов

    usdt = await deployContract("TestUSDT", owner);
    // firstDeadline = время ЦЕПИ + 3ч (evm_increaseTime копится между тестами,
    // wall-clock Date.now() здесь врёт; контракт требует > +30 мин)
    const chainNow = (await provider.getBlock("latest")).timestamp;
    const firstDeadline = chainNow + 3 * HOUR;
    sun = await deployContract("SundayLottery", owner, usdt.address, P("10"), owner.address, firstDeadline);

    for (const pl of players) {
      await usdt.mint(pl.address, P("1000"));
      await usdt.connect(pl).approve(sun.address, MAX);
    }
    await usdt.mint(owner.address, P("1000"));
  });

  it("deploySunday: якорь — воскресенье 18:00 UTC в будущем", async function () {
    // Дата-математика деплой-скрипта на 300 случайных «сейчас»
    for (let i = 0; i < 300; i++) {
      const nowMs = Date.now() - Math.floor(Math.random() * 400 * 24 * HOUR);
      const ts = nextSunday1800UTC(nowMs);
      const d = new Date(ts * 1000);
      if (d.getUTCDay() !== 0) throw new Error(`не воскресенье: ${d.toUTCString()}`);
      if (d.getUTCHours() !== 18 || d.getUTCMinutes() !== 0 || d.getUTCSeconds() !== 0)
        throw new Error(`не 18:00:00 UTC: ${d.toUTCString()}`);
      if (ts <= nowMs / 1000 + 12 * HOUR) throw new Error(`слишком близко: ${d.toUTCString()}`);
    }
  });

  it("покупка места: 3 игрока, места 1..3, пул 30; дубль и чужой адрес", async function () {
    await sun.connect(players[0]).buySeat();
    await sun.connect(players[1]).buySeat();
    await sun.connect(players[2]).buySeat();
    expect(await sun.seatCount()).to.equal(3);
    expect(await sun.mySeat(players[0].address)).to.equal(1);
    expect(await sun.mySeat(players[1].address)).to.equal(2);
    expect(await sun.mySeat(players[2].address)).to.equal(3);
    expect(await sun.hasSeat(players[0].address)).to.equal(true);
    expect(ethers.utils.formatEther(await sun.getPrizePool())).to.equal("30.0");

    await expectRevert(sun.connect(players[0]).buySeat(), "One seat per address");
    expect(await sun.hasSeat(players[9].address)).to.equal(false);
  });

  it("ранний seal/skip запрещён; после дедлайна пустая неделя skip'ается", async function () {
    await expectRevert(sun.sealWeek(), "Too early: deadline");
    await expectRevert(sun.skipWeek(), "Too early: deadline");

    await sun.connect(players[0]).buySeat();
    await expectRevert(sun.skipWeek(), "Has seats: use sealWeek");

    await timeTravel(3 * HOUR + 60);
    // состав 1 → skip нельзя
    await expectRevert(sun.skipWeek(), "Has seats: use sealWeek");
  });

  it("skipWeek: состав 0 → неделя пропущена, расписание по якорю", async function () {
    const deadline1 = await sun.currentDeadline();
    await timeTravel(3 * HOUR + 60);
    await sun.skipWeek();
    expect(await sun.weekId()).to.equal(2);
    const deadline2 = await sun.currentDeadline();
    expect(Number(deadline2) - Number(deadline1)).to.equal(WEEK);
    // и вторая пустая неделя тоже skip'ается
    await timeTravel(WEEK + 60);
    await sun.skipWeek();
    expect(await sun.weekId()).to.equal(3);
    expect(Number(await sun.currentDeadline()) - Number(deadline2)).to.equal(WEEK);
  });

  it("полный жизненный цикл: 5 игроков → seal → commit → draw → 95/5 → новая неделя", async function () {
    for (let i = 0; i < 5; i++) await sun.connect(players[i]).buySeat();
    await timeTravel(3 * HOUR + 60);

    expect(await sun.canSeal()).to.equal(true);
    await sun.sealWeek();
    expect(await sun.state()).to.equal(1); // SEALED

    // до COMMIT_DELAY коммит запрещён
    await expectRevert(sun.commitHash(), "Too early: commit delay");
    await mineBlocks(21);
    expect(await sun.canCommit()).to.equal(true);
    await sun.commitHash();
    expect(await sun.canDraw()).to.equal(true);

    const committed = await sun.committedHash();
    // состав фиксируем ДО розыгрыша: triggerDraw делает delete seats
    const seatsBefore = [];
    for (let i = 0; i < 5; i++) seatsBefore.push(await sun.seats(i));

    await sun.triggerDraw();
    expect(await sun.state()).to.equal(2); // SETTLED

    // пул 50 → комиссия 2.5 казне сразу, приз 47.5 в pendingPrizes
    const winner = await sun.lastWinner();
    expect(ethers.utils.formatEther(await usdt.balanceOf(owner.address))).to.equal("1002.5");
    expect(Number(await sun.pendingPrizes(winner))).to.be.greaterThan(0);
    const prize = await sun.pendingPrizes(winner);
    expect(ethers.utils.formatEther(prize)).to.equal("47.5");
    expect(Number(await sun.totalPendingPrizes())).to.equal(Number(prize));

    // детерминизм сида: локально пересчитываем победителя из committedHash
    // (solidityKeccak256 возвращает hex-строку — заворачиваем в BigNumber)
    const seed = KECCAK_PACKED(["bytes32", "uint256", "uint256"], [committed, 1, 5]);
    const winIndex = ethers.BigNumber.from(seed).mod(5);
    expect(winner).to.equal(seatsBefore[Number(winIndex)]);

    // результат недели в стейте контракта
    const r = await sun.getWeekResult(1);
    expect(r.winner).to.equal(winner);
    expect(ethers.utils.formatEther(r.prize)).to.equal("47.5");
    expect(ethers.utils.formatEther(r.treasuryFee)).to.equal("2.5");
    expect(r.seats_).to.equal(5);
    expect(r.winnerSeat).to.equal(Number(winIndex) + 1);
    expect(r.refunded).to.equal(false);

    // состав обнулён, новая неделя открывается, его место свободно
    expect(await sun.seatCount()).to.equal(0);
    expect(await sun.canOpenNext()).to.equal(true);
    await sun.openNextWeek();
    expect(await sun.weekId()).to.equal(2);
    expect(await sun.state()).to.equal(0); // OPEN
    expect(await sun.hasSeat(players[0].address)).to.equal(false);
    // победитель прошлой недели может играть снова, его приз не тронут
    await sun.connect(players[0]).buySeat();
    expect(await sun.mySeat(players[0].address)).to.equal(1);
    expect(await sun.pendingPrizes(winner)).to.equal(prize);
  });

  it("cap: 100-е место — последнее, 101-й покупатель получает revert", async function () {
    // 100 адресов через impersonate (стандартных аккаунтов hardhat — 20)
    const buyers = [];
    for (let i = 0; i < 100; i++) {
      const addr = ethers.Wallet.createRandom().address;
      await hre.network.provider.send("hardhat_setBalance", [addr, "0x8AC7230489E80000"]); // 10 ETH
      await hre.network.provider.send("hardhat_impersonateAccount", [addr]);
      const s = provider.getSigner(addr); s.address = addr;
      await usdt.mint(addr, P("10"));
      await usdt.connect(s).approve(sun.address, MAX);
      buyers.push(s);
    }
    for (const b of buyers) await sun.connect(b).buySeat();
    expect(await sun.seatCount()).to.equal(100);

    const extra = ethers.Wallet.createRandom().address;
    await hre.network.provider.send("hardhat_setBalance", [extra, "0x8AC7230489E80000"]);
    await hre.network.provider.send("hardhat_impersonateAccount", [extra]);
    const s101 = provider.getSigner(extra); s101.address = extra;
    await usdt.mint(extra, P("10"));
    await usdt.connect(s101).approve(sun.address, MAX);
    await expectRevert(sun.connect(s101).buySeat(), "All seats taken");

    // полный состав 100/100 = пул 1000, розыгрыш по обычному сценарию
    await timeTravel(3 * HOUR + 60);
    await sun.sealWeek();
    await mineBlocks(21);
    await sun.commitHash();
    const treasuryBefore = await usdt.balanceOf(owner.address);
    await sun.triggerDraw();
    expect(ethers.utils.formatEther((await usdt.balanceOf(owner.address)).sub(treasuryBefore))).to.equal("50.0");
    const r = await sun.getWeekResult(1);
    expect(ethers.utils.formatEther(r.prize)).to.equal("950.0");
    expect(r.seats_).to.equal(100);
    // победитель забирает 950
    const claimer = provider.getSigner(r.winner); claimer.address = r.winner;
    const balBefore = await usdt.balanceOf(r.winner);
    await sun.connect(claimer).claimPrize();
    expect((await usdt.balanceOf(r.winner)).sub(balBefore)).to.equal(r.prize);
    expect(Number(await sun.totalPendingPrizes())).to.equal(0);
  });

  it("страховка A: коммит пропущен (окно истекло) → refundWeek возвращает 100%", async function () {
    const b0 = await usdt.balanceOf(players[0].address);
    const b1 = await usdt.balanceOf(players[1].address);
    await sun.connect(players[0]).buySeat();
    await sun.connect(players[1]).buySeat();
    await timeTravel(3 * HOUR + 60);
    await sun.sealWeek();
    expect(await sun.canRefund()).to.equal(false);
    await mineBlocks(251); // COMMIT_WINDOW=250 истёк без commitHash
    expect(await sun.canRefund()).to.equal(true);
    await sun.refundWeek();
    // каждый получил свои 10 USDT обратно — балансы вернулись к исходным
    expect(await usdt.balanceOf(players[0].address)).to.equal(b0);
    expect(await usdt.balanceOf(players[1].address)).to.equal(b1);
    const r = await sun.getWeekResult(1);
    expect(r.refunded).to.equal(true);
    expect(r.hasResult).to.equal(true);
    expect(await sun.weekId()).to.equal(2);
    expect(await sun.state()).to.equal(0);
  });

  it("страховка B: хеш закоммичен, draw не случился за SEAL_GRACE → 100% возврат", async function () {
    await sun.connect(players[0]).buySeat();
    await sun.connect(players[1]).buySeat();
    await timeTravel(3 * HOUR + 60);
    await sun.sealWeek();
    await mineBlocks(21);
    await sun.commitHash();
    // только что после коммита (~2 мин от дедлайна) рефанд ещё запрещён:
    // розыгрыш возможен, пока не истёк SEAL_GRACE
    expect(await sun.canRefund()).to.equal(false);
    await expectRevert(sun.refundWeek(), "Draw still possible");
    // грейс истёк (2ч после дедлайна), draw так и не случился → 100% возврат
    await timeTravel(2 * HOUR + 60);
    expect(await sun.canRefund()).to.equal(true);
    await sun.refundWeek();
    expect(await sun.state()).to.equal(0);
    expect(await sun.weekId()).to.equal(2);
  });

  it("claimPrize / forceClaimPrize: права и пустые призы", async function () {
    for (let i = 0; i < 4; i++) await sun.connect(players[i]).buySeat();
    await timeTravel(3 * HOUR + 60);
    await sun.sealWeek();
    await mineBlocks(21);
    await sun.commitHash();
    await sun.triggerDraw();
    const winner = await sun.lastWinner();

    await expectRevert(sun.connect(players[5]).claimPrize(), "No prize");
    await expectRevert(sun.connect(players[5]).forceClaimPrize(winner), "Only treasury");
    await sun.forceClaimPrize(winner); // казна (owner) форсит выплату
    expect(Number(await sun.pendingPrizes(winner))).to.equal(0);
    await expectRevert(sun.forceClaimPrize(winner), "No prize");
  });
});
