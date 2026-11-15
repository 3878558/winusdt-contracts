// Тесты Slots PvC (фаза 3). Дизайн: docs/slots-design.md §3.5–3.8.
//
// Обязательные кейсы evaluate(): пара на КАЖДОЙ из трёх позиционных пар
// (0-1, 0-2, 1-2) — в HTML-макете пару (1,2) пропустили; здесь каждый
// случай закрывается отдельным ассертом. Плюс adversarial: атомарная
// снайперская атака, ранний resolve, expire-refund, reentrancy (CEI),
// maxBet/admission границы, LP-математика fuzz, тимлок параметров.
//
// Намеренно без chai — минимальный shim ассертов, как в v2.test.cjs.
// ethers v5 из package.json, поверх in-process провайдера Hardhat.
const hre = require("hardhat");
const ethers = require("ethers");

function expect(actual) {
  return {
    to: {
      equal(expected) {
        const a = String(actual), e = String(expected);
        if (a !== e) throw new Error(`expected ${e}, got ${a}`);
      },
      beTruthy() { if (!actual) throw new Error(`expected truthy, got ${actual}`); },
      beFalsy() { if (actual) throw new Error(`expected falsy, got ${actual}`); },
      be: {
        greaterThan(n) {
          if (!(Number(actual) > Number(n))) throw new Error(`expected > ${n}, got ${actual}`);
        },
        truthy() { if (!actual) throw new Error(`expected truthy, got ${actual}`); },
        falsy() { if (actual) throw new Error(`expected falsy, got ${actual}`); },
        beTruthy() { if (!actual) throw new Error(`expected truthy, got ${actual}`); },
        beFalsy() { if (actual) throw new Error(`expected falsy, got ${actual}`); },
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

const FILES = {
  Slots: "Slots",
  TestUSDT: "TestUSDT",
  MockFeeToken: "test/SlotsMocks",
  ReentrantUSDT: "test/SlotsMocks",
  PayoutSpy: "test/SlotsMocks",
  AtomicAttack: "test/SlotsMocks",
};

async function deploy(name, signer, ...args) {
  const art = require(`../artifacts/contracts/${FILES[name]}.sol/${name}.json`);
  const f = new ethers.ContractFactory(art.abi, art.bytecode, signer);
  const c = await f.deploy(...args);
  await c.deployed();
  return c;
}

const P = (n) => ethers.utils.parseEther(String(n));
const F = (n) => ethers.utils.formatEther(n);
const KECCAK = (types, vals) => ethers.utils.solidityKeccak256(types, vals);
const HOUR = 3600;
const MAX = ethers.constants.MaxUint256;

async function mineBlocks(n) {
  for (let i = 0; i < n; i++) await hre.network.provider.send("evm_mine");
}
async function timeTravel(sec) {
  await hre.network.provider.send("evm_increaseTime", [sec]);
  await hre.network.provider.send("evm_mine");
}
async function blockHashAt(n) {
  const b = await provider.send("eth_getBlockByNumber", [ethers.utils.hexlify(n), false]);
  return b ? b.hash : null;
}

// ── JS-зеркало игровой математики (§2.2/2.3) ──
const CUM = [0, 20, 36, 49, 59, 66, 70]; // первые r каждого символа
const TRIPLE_BPS = [30000, 50000, 80000, 120000, 200000, 400000, 1000000];
const PAIR_BPS = [16000, 14000, 10000, 12000, 25000, 40000, 250000];

function symbolOf(r) {
  if (r < 20) return 0;
  if (r < 36) return 1;
  if (r < 49) return 2;
  if (r < 59) return 3;
  if (r < 66) return 4;
  if (r < 70) return 5;
  return 6;
}
// Сид из трёх "сырых" r: r1 + 72·r2 + 72²·r3
const seedOf = (r1, r2, r3) => r1 + 72 * r2 + 5184 * r3;

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
// ВАЖНО: контракт считает seed = uint256(keccak256(abi.encode(h, player, bet)))
// — это PADDED-кодирование (address расширяется до 32 байт). solidityKeccak256
// использует packed-семантику (address = 20 байт) и даст ДРУГОЙ хеш.
const seedFor = (h, player, bet) =>
  ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(["bytes32", "address", "uint256"], [h, player, bet])
  );

// Стандартный сетап: USDT + Slots(0.5/10/fee), владелец заливает банкролл.
async function setup({ bankroll = 300, fee = 0 } = {}) {
  const accounts = await provider.listAccounts();
  const signerFor = (a) => { const s = provider.getSigner(a); s.address = a; return s; };
  const owner = signerFor(accounts[0]);
  const players = accounts.slice(1, 5).map(signerFor);
  const usdt = await deploy("TestUSDT", owner);
  const slots = await deploy("Slots", owner, usdt.address, P(0.5), P(10), fee);
  for (const p of players) {
    await usdt.mint(p.address, P(10000));
    await usdt.connect(p).approve(slots.address, MAX);
  }
  await usdt.mint(owner.address, P(100000));
  await usdt.approve(slots.address, MAX);
  if (bankroll > 0) await slots.deposit(P(bankroll));
  return { owner, players, usdt, slots };
}

describe("Slots — игровая математика evaluate() (§2.2/2.3)", function () {
  let slots, owner, players;
  beforeEach(async function () {
    ({ owner, players, slots } = await setup({ bankroll: 300 }));
  });

  it("все 7 троек платят по джекпот-таблице", async function () {
    const bet = P(1);
    for (let k = 0; k < 7; k++) {
      const seed = seedOf(CUM[k], CUM[k], CUM[k]);
      const [payout, syms] = await slots.evaluate(seed, bet);
      expect(syms[0]).to.equal(k);
      expect(syms[1]).to.equal(k);
      expect(syms[2]).to.equal(k);
      expect(F(payout)).to.equal(F(bet.mul(TRIPLE_BPS[k]).div(10000)));
    }
    // джекпот 7️⃣7️⃣7️⃣ = ×100 ровно
    const seed = seedOf(CUM[6], CUM[6], CUM[6]);
    const [payout] = await slots.evaluate(seed, P(1));
    expect(F(payout)).to.equal("100.0");
  });

  it("ОБЯЗАТЕЛЬНЫЙ кейс: ровно-пара на каждой из трёх позиционных пар (0-1, 0-2, 1-2), все 7 символов", async function () {
    const bet = P(1);
    const posPairs = [[0, 1], [0, 2], [1, 2]]; // (0,2) и (1,2) — кейсы, пропущенные в HTML-макете
    let checked = 0;
    for (const [pa, pb] of posPairs) {
      for (let k = 0; k < 7; k++) {
        // третий барабан — соседний символ, НЕ равный паре
        const j = (k + 1) % 7;
        const other = 3 - pa - pb; // позиция вне пары: (0,1)→2, (0,2)→1, (1,2)→0
        const r = [CUM[0], CUM[1], CUM[2]]; // базовые r по всем трём
        r[pa] = CUM[k];
        r[pb] = CUM[k];
        r[other] = CUM[j];
        const seed = seedOf(r[0], r[1], r[2]);
        const [payout, syms] = await slots.evaluate(seed, bet);
        expect(String(syms[pa])).to.equal(String(k));
        expect(String(syms[pb])).to.equal(String(k));
        expect(F(payout)).to.equal(F(bet.mul(PAIR_BPS[k]).div(10000)));
        checked++;
      }
    }
    expect(checked).to.equal(21);
  });

  it("все три разные → выплата 0", async function () {
    const seed = seedOf(CUM[0], CUM[1], CUM[2]);
    const [payout] = await slots.evaluate(seed, P(1));
    expect(F(payout)).to.equal("0.0");
  });

  it("границы кумулятивных весов (20/16/13/10/7/4/2)", async function () {
    const bounds = [19, 0, 20, 1, 35, 1, 36, 2, 48, 2, 49, 3, 58, 3, 59, 4, 65, 4, 66, 5, 69, 5, 70, 6, 71, 6];
    for (let i = 0; i < bounds.length; i += 2) {
      const r = bounds[i], want = bounds[i + 1];
      const [, syms] = await slots.evaluate(seedOf(r, r, r), P(1));
      expect(String(syms[0])).to.equal(String(want));
    }
  });

  it("seed разложения r1/r2/r3: независимые барабаны", async function () {
    // r1=0 (🍒), r2=70 (7️⃣), r3=36 (🍇): Seed = 0 + 72·70 + 5184·36
    const seed = seedOf(0, 70, 36);
    const [, syms] = await slots.evaluate(seed, P(1));
    expect(String(syms[0])).to.equal("0");
    expect(String(syms[1])).to.equal("6");
    expect(String(syms[2])).to.equal("2");
  });
});

describe("Slots — полный цикл solo-спина (две транзакции, §3.1)", function () {
  let owner, players, usdt, slots;
  beforeEach(async function () {
    ({ owner, players, usdt, slots } = await setup({ bankroll: 300 }));
  });

  it("детерминизм: событие совпадает с оффчейн-расчётом (пруф Verify)", async function () {
    const player = players[0];
    const before = await usdt.balanceOf(player.address);
    const tx = await slots.connect(player)["spin(uint256)"](P(1));
    const rc = await tx.wait();
    const betBlock = rc.blockNumber;
    await mineBlocks(2);

    const h = await blockHashAt(betBlock + 1);
    const wantSeed = seedFor(h, player.address, P(1));
    const want = evaluateJs(wantSeed, P(1));

    // resolve вызыает ПОСТОРОННИЙ (permissionless) — исход не в его власти
    await slots.connect(players[1]).resolveFor(player.address);

    const evs = await slots.queryFilter(slots.filters.SpinResolved(), betBlock, "latest");
    expect(String(evs.length)).to.equal("1");
    const e = evs[0].args;
    expect(e.player).to.equal(player.address);
    expect(String(e.betBlock)).to.equal(String(betBlock));
    expect(F(e.bet)).to.equal("1.0");
    expect(e.blockHash).to.equal(h);
    // seed в событии — uint256 (десятичный BigNumber), wantSeed — hex-строка
    expect(String(ethers.BigNumber.from(e.seed))).to.equal(String(ethers.BigNumber.from(wantSeed)));
    expect(String(e.symbols[0])).to.equal(String(want.syms[0]));
    expect(String(e.symbols[1])).to.equal(String(want.syms[1]));
    expect(String(e.symbols[2])).to.equal(String(want.syms[2]));
    expect(F(e.payout)).to.equal(F(want.payout));

    // бухгалтерия: escrow обнулён, игрок получил payout (или отдал bet)
    const [, , , active] = await slots.activeSession(player.address);
    expect(active).to.beFalsy();
    expect(F(await slots.totalEscrow())).to.equal("0.0");
    expect(F(await slots.totalExposure())).to.equal("0.0");
    const after = await usdt.balanceOf(player.address);
    expect(F(after.sub(before))).to.equal(F(want.payout.sub(P(1))));
    // покрытие инварианта: balance == escrow + fees + equity
    expect(F(await usdt.balanceOf(slots.address)))
      .to.equal(F((await slots.totalEscrow()).add(await slots.equity())));
  });

  it("spin(bet, true): continuous play — prev resolve + новый спин в одной tx", async function () {
    const player = players[0];
    await slots.connect(player)["spin(uint256)"](P(1));
    await mineBlocks(3);
    // chain-ставка = minBet: после резолва prev спина maxBet мог сжаться
    // (джекпот-выплата уменьшает fb), а minBet принимается всегда при живом
    // admission — это и есть UX непрерывной игры
    const tx = await slots.connect(player)["spin(uint256,bool)"](P(0.5), true);
    const rc = await tx.wait();
    const resolved = rc.events.filter((e) => e.event === "SpinResolved");
    const started = rc.events.filter((e) => e.event === "SpinStarted");
    expect(String(resolved.length)).to.equal("1");
    expect(String(started.length)).to.equal("1");
    expect(String(started[0].args.bet)).to.equal(String(P(0.5)));
    const [, , , active] = await slots.activeSession(player.address);
    expect(active).to.beTruthy();
    await mineBlocks(3);
    await slots.connect(player).resolve();
    const [, , , active2] = await slots.activeSession(player.address);
    expect(active2).to.beFalsy();
  });

  it("ранний resolve отклоняется: tx в блоке betBlock+1 не видит blockhash(betBlock+1)", async function () {
    const player = players[0];
    const tx = await slots.connect(player)["spin(uint256)"](P(1));
    const rc = await tx.wait();
    const betBlock = rc.blockNumber;
    // первый resolve-вызов исполняется в блоке betBlock+1 → hash ещё не
    // существует (blockhash(n) валиден только для n < block.number) → revert
    await expectRevert(slots.connect(player).resolve(), "wait betBlock+1");
    await mineBlocks(2); // estimateGas expectRevert-а блок НЕ майнит — цепочка на betBlock
    // теперь resolve исполнится в betBlock+3 → betBlock+1 в прошлом → можно
    await slots.connect(player).resolve();
    const [, , , active] = await slots.activeSession(player.address);
    expect(active).to.beFalsy();
  });

  it("expire-refund: decay окна → возврат ставки, исхода нет", async function () {
    const player = players[0];
    const before = await usdt.balanceOf(player.address);
    const tx = await slots.connect(player)["spin(uint256)"](P(1));
    const rc = await tx.wait();
    await mineBlocks(257); // > 256 блоков — EVM blockhash(betBlock+1) уже 0
    await slots.connect(players[1]).resolveFor(player.address);
    const after = await usdt.balanceOf(player.address);
    expect(F(after)).to.equal(F(before)); // ставка вернулась целиком
    const evs = await slots.queryFilter(slots.filters.SpinResolved(), rc.blockNumber, "latest");
    expect(evs[0].args.blockHash).to.equal(ethers.constants.HashZero);
    expect(F(evs[0].args.payout)).to.equal("0.0");
    expect(F(await slots.totalEscrow())).to.equal("0.0");
    expect(F(await slots.totalExposure())).to.equal("0.0");
    // v2: decay-refund освобождает и машину (никто не застрял навсегда)
    expect(await slots.activePlayer()).to.equal(ethers.constants.AddressZero);
  });

  it("repeat: один активный спин на игрока; второй spin отклонён", async function () {
    await slots.connect(players[0])["spin(uint256)"](P(1));
    await expectRevert(slots.connect(players[0])["spin(uint256)"](P(1)), "session active");
    await expectRevert(slots.connect(players[0]).spinSeries(P(1), 3), "session active");
  });
});

describe("Slots — границы ставок: слои 2+3 (admission, maxBet)", function () {
  let owner, players, usdt, slots;
  beforeEach(async function () {
    ({ owner, players, usdt, slots } = await setup({ bankroll: 300 }));
  });

  it("bet < minBet и bet > maxBet отклонены", async function () {
    await expectRevert(slots.connect(players[0])["spin(uint256)"](P(0.4)), "bet out of range");
    await expectRevert(slots.connect(players[0])["spin(uint256)"](P(2)), "bet out of range");
    // ровно maxBet проходит
    await slots.connect(players[0])["spin(uint256)"](P(1));
  });

  it("maxBet = fb/300, floor minBet, cap 10 (§3.4 слой 3)", async function () {
    expect(F(await slots.maxBetNow())).to.equal("1.0"); // 300/300
    // банкролл падает → maxBet флорится на minBet (§7.5: fb 100 → 0.33→0.5)
    const s2 = await setup({ bankroll: 100 });
    expect(F(await s2.slots.maxBetNow())).to.equal("0.5");
    await s2.slots.connect(s2.players[0])["spin(uint256)"](P(0.5)); // floor-ставка принята
    // admission 99×0.5=49.5 ≤ 100 ✓
  });

  it("admission: ниже пола 99×bet ставки не принимаются (абсорбирующий floor)", async function () {
    const s2 = await setup({ bankroll: 49 });
    // fb 49 < 49.5 → даже floor-ставка отвергнута — «машина остановлена»
    await expectRevert(s2.slots.connect(s2.players[0])["spin(uint256)"](P(0.5)), "admission");
  });

  it("v2 эксклюзив: одна сессия на машине; чужие спины — 'machine busy'", async function () {
    // динамика одной сессии: fb' = fb − 99×bet; после спина p0 (bet 1)
    // maxBet сжимается с 1 до 201/300 = 0.67
    await slots.connect(players[0])["spin(uint256)"](P(1));
    expect(F(await slots.freeBankroll())).to.equal("201.0");
    expect(F(await slots.maxBetNow())).to.equal("0.67");
    expect(await slots.activePlayer()).to.equal(players[0].address);
    // книги ОДНОЙ сессии (v2: наложений больше не существует)
    expect(F(await slots.totalEscrow())).to.equal("1.0");
    expect(F(await slots.totalExposure())).to.equal("99.0");
    // инвариант худшего джекпота (§3.4): balance ≥ escrow+exposure
    const bal = await usdt.balanceOf(slots.address);
    const worst = (await slots.totalEscrow()).add(await slots.totalExposure());
    expect(bal.gte(worst)).to.beTruthy();
    // v2: чужие спины при занятой машине — revert, у остальных «трансляция»
    await expectRevert(slots.connect(players[1])["spin(uint256)"](P(0.5)), "machine busy");
    await expectRevert(slots.connect(players[1]).spinSeries(P(0.5), 3), "machine busy");
    // разрешение (permissionless — посторонним тоже) освобождает машину
    await mineBlocks(3);
    await slots.connect(players[1]).resolveFor(players[0].address);
    expect(await slots.activePlayer()).to.equal(ethers.constants.AddressZero);
    expect(F(await slots.totalEscrow())).to.equal("0.0");
    expect(F(await slots.totalExposure())).to.equal("0.0");
    // очередь дошла до players[1]
    await slots.connect(players[1])["spin(uint256)"](P(0.5));
    expect(await slots.activePlayer()).to.equal(players[1].address);
  });
});

describe("Slots — turbo-серии (§5)", function () {
  let owner, players, usdt, slots;
  beforeEach(async function () {
    ({ owner, players, usdt, slots } = await setup({ bankroll: 300 }));
  });

  it("admission happens-at-creation: N ограничен 99×N×bet ≤ fb", async function () {
    // 99×7×0.5 = 346.5 > 300 → отказ; 99×6×0.5 = 297 ≤ 300 → ок
    await expectRevert(slots.connect(players[0]).spinSeries(P(0.5), 7), "admission");
    await expectRevert(slots.connect(players[0]).spinSeries(P(0.5), 0), "series 1..64");
    await expectRevert(slots.connect(players[0]).spinSeries(P(0.5), 65), "series 1..64");
    const tx = await slots.connect(players[0]).spinSeries(P(0.5), 6);
    const rc = await tx.wait();
    expect(String(rc.events.find((e) => e.event === "SpinStarted").args.n)).to.equal("6");
    // escrow всей серии сразу
    expect(F(await slots.totalEscrow())).to.equal("3.0");
    expect(F(await slots.totalExposure())).to.equal("297.0");
  });

  it("resolveSeries раньше добычи всех блоков отклонён", async function () {
    await slots.connect(players[0]).spinSeries(P(0.5), 6);
    await mineBlocks(3); // мало: нужно > betBlock+6
    await expectRevert(slots.connect(players[0]).resolveSeries(), "wait series blocks");
  });

  it("полная серия: каждый спин своим блоком, события совпадают с оффчейн-расчётом", async function () {
    const player = players[0];
    const before = await usdt.balanceOf(player.address);
    const tx = await slots.connect(player).spinSeries(P(0.5), 6);
    const betBlock = (await tx.wait()).blockNumber;
    await mineBlocks(8);
    await slots.connect(player).resolveSeries();

    const evs = await slots.queryFilter(slots.filters.SpinResolved(), betBlock, "latest");
    expect(String(evs.length)).to.equal("6");
    let sumPayout = ethers.BigNumber.from(0);
    for (let i = 0; i < 6; i++) {
      const h = await blockHashAt(betBlock + 1 + i);
      const seed = seedFor(h, player.address, P(0.5));
      const want = evaluateJs(seed, P(0.5));
      const e = evs[i].args;
      expect(String(e.betBlock)).to.equal(String(betBlock));
      expect(e.blockHash).to.equal(h);
      expect(String(ethers.BigNumber.from(e.seed))).to.equal(String(ethers.BigNumber.from(seed)));
      expect(String(e.symbols[0]) + String(e.symbols[1]) + String(e.symbols[2]))
        .to.equal(want.syms.join(""));
      expect(F(e.payout)).to.equal(F(want.payout));
      sumPayout = sumPayout.add(want.payout);
    }
    // SeriesSettled итог == Σ per-spin
    const settled = (await slots.queryFilter(slots.filters.SeriesSettled(), betBlock, "latest"))[0];
    expect(F(settled.args.totalPayout)).to.equal(F(sumPayout));
    // бухгалтерия: игрок заплатил 6×0.5, получил Σpayout (+escrow-часть внутри)
    const after = await usdt.balanceOf(player.address);
    expect(F(after.sub(before))).to.equal(F(sumPayout.sub(P(3))));
    expect(F(await slots.totalEscrow())).to.equal("0.0");
    expect(String(await slots.totalSpins())).to.equal("6");
  });

  it("частично/полностью decayed серия: живые спины резолвятся, протухшие refund", async function () {
    const player = players[0];
    const before = await usdt.balanceOf(player.address);
    await slots.connect(player).spinSeries(P(0.5), 3);
    await mineBlocks(300); // все 3 хеша (betBlock+1..+3) вышли из 256-окна EVM
    await slots.connect(player).resolveSeries();
    const after = await usdt.balanceOf(player.address);
    expect(F(after)).to.equal(F(before)); // полный возврат escrow 3×0.5
    const settled = (await slots.queryFilter(slots.filters.SeriesSettled(), "latest", "latest"))[0];
    expect(F(settled.args.totalRefunded)).to.equal("1.5");
    expect(F(settled.args.totalPayout)).to.equal("0.0");
  });
});

describe("Slots — LP-пул (§3.3)", function () {
  let owner, players, usdt, slots;
  beforeEach(async function () {
    ({ owner, players, usdt, slots } = await setup({ bankroll: 0 }));
  });

  it("первый LP 1:1; последующие по цене доли (edge капает в цену)", async function () {
    await slots.deposit(P(300)); // owner: 300 долей 1:1
    expect(F(await slots.totalShares())).to.equal("300.0");
    // игрок проиграл спин (выплата 0 возможна не всегда — крутим до house-win)
    let lost = false;
    let eqBeforeLoss = ethers.BigNumber.from(0);
    for (let i = 0; i < 30 && !lost; i++) {
      const p = players[i % 4];
      if ((await slots.activeSession(p.address))[3]) {
        await mineBlocks(2);
        await slots.resolveFor(p.address);
      }
      // maxBet сжимается при house-win (fb падает) — ставка под актуальный лимит
      const mb = await slots.maxBetNow();
      const bet = mb.lt(P(1)) ? P(0.5) : P(1);
      await slots.connect(p)["spin(uint256)"](bet);
      await mineBlocks(2);
      // equity до резолва (escrow активен ⇒ equity == значению до спина)
      eqBeforeLoss = await slots.equity();
      await slots.resolveFor(p.address);
      // событие ищем ПОСЛЕ резолва — оно эмитится в resolve-транзакции
      const evs = await slots.queryFilter(slots.filters.SpinResolved(), "latest", "latest");
      if (F(evs[0].args.payout) === "0.0") lost = true;
    }
    expect(lost).to.beTruthy(); // за 30 спинов house-win почти наверняка случился
    // Детерминизм: house-win зачисляет bet−fee в банкролл ⇒ equity СТРОГО
    // растёт относительно момента до этого резолва. Абсолют vs 300 не годится:
    // джекпот игрока выше по циклу легитимно уводил equity ниже стартового.
    const eq = await slots.equity();
    expect(eq.gt(eqBeforeLoss)).to.beTruthy(); // edge в цене доли
    // депозит по текущей цене: shares = 100×totalShares/equity
    const expected = P(100).mul(await slots.totalShares()).div(eq);
    await slots.connect(players[0]).deposit(P(100));
    const got = await slots.lpShares(players[0].address);
    expect(String(got)).to.equal(String(expected));
  });

  it("withdraw: доля по цене; guard блокирует вывод, ломающий покрытие", async function () {
    await slots.deposit(P(300));
    await slots.connect(players[0])["spin(uint256)"](P(1)); // escrow 1 + exposure 99 активны
    const eq = await slots.equity();
    const shares = await slots.lpShares(owner.address);
    // вывод почти всего ломает покрытие (300+eq… escrow+exposure=100) → guard
    const tooMuch = shares.mul(99).div(100);
    await expectRevert(slots.withdraw(tooMuch), "coverage guard");
    // меньший вывод проходит
    const ok = shares.mul(20).div(100);
    const before = await usdt.balanceOf(owner.address);
    await slots.withdraw(ok);
    expect(F((await usdt.balanceOf(owner.address)).sub(before))).to.equal(F(ok.mul(eq).div(P(300))));
    expect(F(await slots.lpShares(owner.address))).to.equal(F(shares.sub(ok)));
  });

  it("fuzz 80 операций: инвариант баланса, покрытие, сумма долей, цена доли", async function () {
    let s = 12345;
    const rnd = () => { s = (s * 1103515245 + 12345) % 2147483648; return s / 2147483648; };
    const lps = [owner, players[0], players[1]];
    const bettors = [players[2], players[3]];
    await slots.deposit(P(300));
    await slots.connect(players[0]).deposit(P(100));
    const active = new Map(); // addr -> {betBlock, n}
    for (let op = 0; op < 80; op++) {
      const roll = rnd();
      try {
        if (roll < 0.2) {
          const lp = lps[Math.floor(rnd() * 3)];
          await slots.connect(lp).deposit(P(Math.round(5 + rnd() * 100)));
        } else if (roll < 0.4) {
          const lp = lps[Math.floor(rnd() * 3)];
          const sh = await slots.lpShares(lp.address);
          if (sh.gt(0)) await slots.connect(lp).withdraw(sh.div(4));
        } else if (roll < 0.65) {
          const p = bettors[Math.floor(rnd() * 2)];
          if (!active.has(p.address)) {
            // v2: машина держит одну сессию — спин только при свободном автомате
            const machineFree = (await slots.activePlayer()) === ethers.constants.AddressZero;
            if (machineFree) {
              await slots.connect(p)["spin(uint256)"](P(rnd() < 0.5 ? 0.5 : 1));
              active.set(p.address, { n: 1 });
            }
          }
        } else if (roll < 0.8) {
          const p = bettors[Math.floor(rnd() * 2)];
          if (!active.has(p.address)) {
            const machineFree = (await slots.activePlayer()) === ethers.constants.AddressZero;
            if (machineFree) {
              const n = 2 + Math.floor(rnd() * 3);
              await slots.connect(p).spinSeries(P(0.5), n);
              active.set(p.address, { n });
            }
          }
        } else {
          await mineBlocks(6 + Math.floor(rnd() * 4)); // покрывает серии n≤4
          for (const [addr, info] of active) {
            if (info.n === 1) await slots.resolveFor(addr);
            else await slots.resolveSeriesFor(addr);
          }
          active.clear();
        }
      } catch (e) {
        const msg = String(e.message) + String(e.info?.error?.message || "");
        const ok = ["admission", "bet out of range", "coverage guard", "session active", "series 1..64", "dust", "wait series", "wait betBlock", "machine busy"].some((k) => msg.includes(k));
        if (!ok) throw new Error(`op ${op}: неожиданный revert: ${msg.slice(0, 250)}`);
      }
      // ── инварианты после каждой операции ──
      const bal = await usdt.balanceOf(slots.address);
      const esc = await slots.totalEscrow();
      const exp = await slots.totalExposure();
      const fees = await slots.creatorFeesTotal();
      const eq = await slots.equity();
      expect(F(bal.sub(esc).sub(fees))).to.equal(F(eq));
      expect(bal.gte(esc.add(exp).add(fees))).to.beTruthy();
      let sum = ethers.BigNumber.from(0);
      let valSum = ethers.BigNumber.from(0);
      for (const lp of lps) {
        const sh = await slots.lpShares(lp.address);
        sum = sum.add(sh);
        valSum = valSum.add(await slots.lpValue(lp.address));
      }
      expect(String(sum)).to.equal(String(await slots.totalShares()));
      expect(valSum.lte(eq)).to.beTruthy();
    }
  });
});

describe("Slots — owner-параметры: тимлок 24ч, feeShare (§7 anti-scam)", function () {
  let owner, players, usdt, slots;
  beforeEach(async function () {
    ({ owner, players, usdt, slots } = await setup({ bankroll: 300 }));
  });

  it("не-владелец не может ни паузить, ни менять параметры", async function () {
    await expectRevert(slots.connect(players[0]).setPaused(true), "creator only");
    await expectRevert(slots.connect(players[0]).scheduleParamChange(1, P(1)), "creator only");
  });

  it("minBet меняется только через 24ч тимлок", async function () {
    await slots.scheduleParamChange(1, P(1));
    await expectRevert(slots.applyParamChange(1), "timelock 24h");
    await slots.connect(players[0])["spin(uint256)"](P(0.5)); // старый minBet ещё жив
    await mineBlocks(2);
    await slots.resolveFor(players[0].address);
    await timeTravel(25 * HOUR);
    await slots.applyParamChange(1);
    expect(F(await slots.minBet())).to.equal("1.0");
    await expectRevert(slots.connect(players[0])["spin(uint256)"](P(0.5)), "bet out of range");
    await slots.connect(players[0])["spin(uint256)"](P(1));
  });

  it("feeShare: fee = feeShare×(bet−payout) на house-win; клейм батчем", async function () {
    await slots.scheduleParamChange(3, 2000);
    await timeTravel(25 * HOUR);
    await slots.applyParamChange(3);
    await expectRevert(slots.scheduleParamChange(3, 5001), "feeShare<=5000");

    let seenHouseWin = false;
    let seenPlayerWin = false;
    for (let i = 0; i < 40 && !(seenHouseWin && seenPlayerWin); i++) {
      const p = players[i % 4];
      if ((await slots.activeSession(p.address))[3]) {
        await mineBlocks(2);
        await slots.resolveFor(p.address);
      }
      // maxBet сжимается при house-win (fb падает) — ставка под актуальный лимит
      const mb = await slots.maxBetNow();
      const bet = mb.lt(P(1)) ? P(0.5) : P(1);
      await slots.connect(p)["spin(uint256)"](bet);
      await mineBlocks(2);
      const feeBefore = await slots.creatorFeesTotal();
      await slots.resolveFor(p.address);
      // payout читаем из события резолва (появляется только при resolve)
      const evs = await slots.queryFilter(slots.filters.SpinResolved(), "latest", "latest");
      const payout = evs[0].args.payout;
      const feeAfter = await slots.creatorFeesTotal();
      if (F(payout) === "0.0") {
        // feeShare=2000 bps → fee = 20%×bet при полном house-win
        expect(F(feeAfter.sub(feeBefore))).to.equal(F(bet.div(5)));
        seenHouseWin = true;
      } else if (payout.gte(bet)) {
        expect(String(feeAfter)).to.equal(String(feeBefore)); // player-win: fee нет
        seenPlayerWin = true;
      }
    }
    expect(seenHouseWin).to.beTruthy();
    expect(seenPlayerWin).to.beTruthy();

    // fees исключены из equity, но сидят в балансе
    const feesTotal = await slots.creatorFeesTotal();
    const bal = await usdt.balanceOf(slots.address);
    expect(F(bal.sub(feesTotal))).to.equal(F(await slots.equity()));
    // батчевый клейм (permissionless): средства идут ТОЛЬКО получателю
    const creator = await slots.creator();
    const before = await usdt.balanceOf(creator);
    await slots.connect(players[0]).claimCreatorFees([creator]);
    expect(F((await usdt.balanceOf(creator)).sub(before))).to.equal(F(feesTotal));
    expect(F(await slots.creatorFeesTotal())).to.equal("0.0");
    expect(F(await slots.creatorFees(creator))).to.equal("0.0");
  });
});

describe("Slots — pause, BNB, fee-on-transfer, reentrancy, атомарная атака", function () {
  it("pause блокирует ТОЛЬКО новые ставки; резолвы/депозиты живут", async function () {
    const { players, slots } = await setup({ bankroll: 300 });
    await slots.connect(players[0])["spin(uint256)"](P(1));
    await slots.setPaused(true);
    await expectRevert(slots.connect(players[1])["spin(uint256)"](P(1)), "paused");
    await expectRevert(slots.connect(players[1]).spinSeries(P(0.5), 3), "paused");
    await mineBlocks(2);
    await slots.connect(players[0]).resolve(); // активный разрешается
    await slots.connect(players[1]).deposit(P(50)); // LP-поток не паузится
    await slots.setPaused(false);
    await slots.connect(players[1])["spin(uint256)"](P(0.5));
  });

  it("BNB отклоняется", async function () {
    const { owner, slots } = await setup({ bankroll: 300 });
    await expectRevert(
      owner.sendTransaction({ to: slots.address, value: 1 }),
      "no BNB"
    );
  });

  it("fee-on-transfer: депозит кредитуется по факту; escrow спина отвергает недостачу", async function () {
    const accounts = await provider.listAccounts();
    const signerFor = (a) => { const s = provider.getSigner(a); s.address = a; return s; };
    const owner = signerFor(accounts[0]);
    const player = signerFor(accounts[1]);
    const ft = await deploy("MockFeeToken", owner);
    const s2 = await deploy("Slots", owner, ft.address, P(0.5), P(10), 0);
    await ft.mint(owner.address, P(1000));
    await ft.mint(player.address, P(1000));
    await ft.approve(s2.address, MAX);
    await ft.connect(player).approve(s2.address, MAX);
    await s2.deposit(P(100)); // пришло 95
    expect(F(await s2.totalShares())).to.equal("95.0");
    expect(F(await s2.equity())).to.equal("95.0");
    // спин: escrow просит 0.5, приходит 0.475 → reject
    await expectRevert(s2.connect(player)["spin(uint256)"](P(0.5)), "fee-on-transfer unsupported");
    const [, , , active] = await s2.activeSession(player.address);
    expect(active).to.beFalsy();
    expect(F(await s2.totalEscrow())).to.equal("0.0");
  });

  it("reentrancy: escrow/сессия чисты ДО перевода выплаты; двойной resolve отсечён", async function () {
    const accounts = await provider.listAccounts();
    const signerFor = (a) => { const s = provider.getSigner(a); s.address = a; return s; };
    const owner = signerFor(accounts[0]);
    const hookUsdt = await deploy("ReentrantUSDT", owner);
    const spy = await deploy("PayoutSpy", owner);
    const s2 = await deploy("Slots", owner, hookUsdt.address, P(0.5), P(10), 0);
    await hookUsdt.setHook(spy.address);
    await hookUsdt.mint(spy.address, P(1000));
    await hookUsdt.mint(owner.address, P(1000));
    await hookUsdt.approve(s2.address, MAX);
    await s2.deposit(P(300)); // банкролл
    await spy.arm(s2.address);

    // крутим до выплаты (нужен transfer к шпиону — колбэк при payout>0)
    let payout = ethers.BigNumber.from(0);
    for (let i = 0; i < 40 && payout.eq(0); i++) {
      await spy.spinOnly(s2.address, hookUsdt.address, P(1));
      await mineBlocks(2);
      await spy.resolveOnly(s2.address);
      const evs = await s2.queryFilter(s2.filters.SpinResolved(), "latest", "latest");
      payout = evs[0].args.payout;
    }
    expect(payout.gt(0)).to.beTruthy(); // за 40 спинов выплата случилась (hit ≈ 49%/спин)
    // внутри колбэка перевода выплаты:
    expect(String(await spy.escrowSeenDuringPayout())).to.equal("0"); // CEI: учёт уже чист
    expect(await spy.sessionSeenDuringPayout()).to.beFalsy();         // сессия уже закрыта
    expect(await spy.doubleResolveSucceeded()).to.beFalsy();         // повторный resolve отклонён
    expect(F(await spy.payoutReceived())).to.equal(F(payout));       // выплата доставлена
  });

  it("атомарная снайперская атака V1 (spin+resolve+отмена в одной tx) revert целиком", async function () {
    const { players, usdt, slots } = await setup({ bankroll: 300 });
    const attack = await deploy("AtomicAttack", players[0]);
    await usdt.mint(attack.address, P(100));
    await expectRevert(
      attack.probe(slots.address, usdt.address, P(1)),
      "wait betBlock+1"
    );
    const [, , , active] = await slots.activeSession(attack.address);
    expect(active).to.beFalsy(); // escrow не застрял
  });
});

describe("Slots v2 — эксклюзивный автомат (один игрок = одна машина)", function () {
  let owner, players, usdt, slots;
  beforeEach(async function () {
    ({ owner, players, usdt, slots } = await setup({ bankroll: 300 }));
  });

  it("chain-play держит машину за собой: activePlayer не меняется между chained-спинами", async function () {
    const p = players[0];
    await slots.connect(p)["spin(uint256)"](P(1));
    expect(await slots.activePlayer()).to.equal(p.address);
    await mineBlocks(3);
    await slots.connect(p)["spin(uint256,bool)"](P(0.5), true); // settle прошлой + новая
    // машина НЕ освобождалась между спинами: activePlayer тот же, сессия жива
    expect(await slots.activePlayer()).to.equal(p.address);
    const [, , , active] = await slots.activeSession(p.address);
    expect(active).to.beTruthy();
    await mineBlocks(3);
    await slots.connect(p).resolve();
    expect(await slots.activePlayer()).to.equal(ethers.constants.AddressZero);
    // машина свободна → следующий игрок крутит без ожидания
    await slots.connect(players[1])["spin(uint256)"](P(0.5));
  });

  it("анти-grief: посторонний resolveFor освобождает машину, исход доставляется владельцу", async function () {
    const p0 = players[0], p1 = players[1];
    const before = await usdt.balanceOf(p0.address); // ДО спина: delta = payout − bet
    await slots.connect(p0)["spin(uint256)"](P(1));
    await mineBlocks(3);
    await slots.connect(p1).resolveFor(p0.address); // дожим посторонним (кернер/наблюдатель)
    // исход честно доставлен ИМЕННО p0: украсть выплату нельзя, платишь только газ
    const evs = await slots.queryFilter(slots.filters.SpinResolved(), "latest", "latest");
    expect(evs[0].args.player).to.equal(p0.address);
    const delta = (await usdt.balanceOf(p0.address)).sub(before);
    expect(F(delta)).to.equal(F(evs[0].args.payout.sub(P(1))));
    expect(await slots.activePlayer()).to.equal(ethers.constants.AddressZero);
    await slots.connect(p1)["spin(uint256)"](P(0.5));
  });

  it("порядок проверок: paused приоритетнее machine busy", async function () {
    await slots.connect(players[0])["spin(uint256)"](P(1));
    await slots.setPaused(true);
    // пауза важнее занятости: сообщение именно про паузу
    await expectRevert(slots.connect(players[1])["spin(uint256)"](P(0.5)), "paused");
    await slots.setPaused(false);
    await expectRevert(slots.connect(players[1])["spin(uint256)"](P(0.5)), "machine busy");
  });

  it("series занимает машину на всю серию, resolveSeriesFor освобождает", async function () {
    await slots.connect(players[0]).spinSeries(P(0.5), 6);
    expect(await slots.activePlayer()).to.equal(players[0].address);
    await expectRevert(slots.connect(players[1])["spin(uint256)"](P(0.5)), "machine busy");
    await mineBlocks(8);
    await slots.connect(players[1]).resolveSeriesFor(players[0].address);
    expect(await slots.activePlayer()).to.equal(ethers.constants.AddressZero);
    expect(F(await slots.totalEscrow())).to.equal("0.0");
  });
});
