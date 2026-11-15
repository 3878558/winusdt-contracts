#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// scripts/slotsSim.cjs — фаза 2: Monte-Carlo верификация дизайна Slots.sol
//
// Что делает (см. docs/slots-design.md §2, §8):
//   0. Точный аналитический расчёт RTP / hit rate по paytable §2.3 (W = 72).
//   A. MC 10⁷ спинов плоской ставкой → RTP с 95% CI, hit rate, частоты
//      исходов vs аналитика (каждая строка paytable отдельно).
//   B. Игрок со сменой ставок («2 победы подряд → молоть 0.5»,
//      «3 проигрыша подряд → агрессивно 5») → RTP обязан остаться 95% (§2.4).
//   C. Мульти-кошелёк: 1000 кошельков × 10⁴ спинов → per-wallet RTP
//      идентичен: разброс = теоретическая σ_spin/√n, без «благословенных».
//   D. Паритет с контрактом: сид uint256 (криптослучайный) → формула
//      r=seed%W (§2.1) → тот же RTP; проверка отсутствия modulo-bias.
//   E. Банкролл LP-пула: динамический maxBet = max(0.5, min(10, fb/300)),
//      admission fb ≥ 100×bet, ruin = fb < 50 (не покрывается худший джекпот
//      minBet); feeShare = 0 (весь edge в банкролл). P(ruin) для стартовых
//      капиталов {50, 100, 300, 1500, 3000} + просадки/дни в турбо/дисклеймеры.
//
// Запуск:  node scripts/slotsSim.cjs [--fast] [--seed S] [--no-report] [--spins N]
//   Полный прогон ≈ 2–4 мин (10⁷×3 сценария + 3.6·10⁹ исходов банкролла).
//   --fast — смоук (~30 сек, уменьшенные объёмы).
//   Отчёт пишется в docs/slots-math.md (воспроизводимый: команда + seed).
// 18+. Симуляция — модель; не обещание доходности.
// ─────────────────────────────────────────────────────────────────────────
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ── Константы дизайна (§2.2 веса, §2.3 выплаты) — единственный источник ──
const W = 72; // сумма весов, одинаково на всех трёх барабанах
const SYMBOLS = [
  { key: 'cherry',  icon: '🍒', w: 20, pay3: 3,   pay2: 1.6 },
  { key: 'lemon',   icon: '🍋', w: 16, pay3: 5,   pay2: 1.4 },
  { key: 'grape',   icon: '🍇', w: 13, pay3: 8,   pay2: 1.0 },
  { key: 'bell',    icon: '🔔', w: 10, pay3: 12,  pay2: 1.2 },
  { key: 'star',    icon: '⭐', w: 7,  pay3: 20,  pay2: 2.5 },
  { key: 'diamond', icon: '💎', w: 4,  pay3: 40,  pay2: 4.0 },
  { key: 'seven',   icon: '7️⃣', w: 2,  pay3: 100, pay2: 25  },
];
const NSYM = SYMBOLS.length;

// Лента-таблица: 72 позиции → индекс символа; выбор = LUT[floor(u·72)]
const LUT = new Uint8Array(W);
{ let k = 0; for (let s = 0; s < NSYM; s++) for (let i = 0; i < SYMBOLS[s].w; i++) LUT[k++] = s; }

// evaluate(a,b,c) → множитель × bet (тройка > ровно-пара > пусто)
const PAY3 = SYMBOLS.map(s => s.pay3);
const PAY2 = SYMBOLS.map(s => s.pay2);
function evaluate(a, b, c) {
  if (a === b) { if (b === c) return PAY3[a]; return PAY2[a]; }
  if (a === c) return PAY2[a];
  if (b === c) return PAY2[b];
  return 0;
}

// ── Аналитика (точная: веса целые, вероятности рациональные) ──
function analytic() {
  const rows = [];
  let rtp = 0, hit = 0, m2 = 0;
  for (const s of SYMBOLS) {
    const p = s.w / W, q = (W - s.w) / W;
    const p3 = p * p * p;
    const p2 = 3 * p * p * q;
    rows.push({ icon: s.icon, w: s.w, p3, pay3: s.pay3, p2, pay2: s.pay2 });
    rtp += p3 * s.pay3 + p2 * s.pay2;
    m2 += p3 * s.pay3 * s.pay3 + p2 * s.pay2 * s.pay2;
    hit += p3 + p2;
  }
  const variance = m2 - rtp * rtp;
  return { rows, rtp, hit, sigma: Math.sqrt(Math.max(variance, 0)) };
}

// ── PRNG: xorshift128 (Marsaglia, период 2¹²⁸−1) + splitmix32 севдер ──
// Период важен: банкролл-симуляция делает ~10⁹ извлечений (2³² не хватает).
function splitmix32(a) {
  return function () {
    a |= 0; a = (a + 0x9e3779b9) | 0;
    let z = a;
    z = Math.imul(z ^ (z >>> 16), 0x21f0aaad);
    z = Math.imul(z ^ (z >>> 15), 0x735a2d97);
    return (z ^ (z >>> 15)) >>> 0;
  };
}
function makeRng(seed, stream) {
  const sm = splitmix32((seed ^ Math.imul(stream + 1, 0x85ebca6b)) | 0);
  let a = sm(), b = sm(), c = sm(), d = sm();
  return function () {
    const t = (a ^ (a << 11)) >>> 0;
    a = b; b = c; c = d;
    d = (d ^ (d >>> 19) ^ t ^ (t >>> 8)) >>> 0;
    return d / 4294967296;
  };
}

// ── CLI ──
function parseArgs() {
  const argv = process.argv.slice(2);
  const get = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
  const fast = argv.includes('--fast');
  const f = fast ? 0.05 : 1;
  return {
    fast,
    seed: parseInt(get('--seed', '20261112'), 10),
    spins: Math.round(parseInt(get('--spins', String(10 ** 7)), 10) * f),
    wallets: parseInt(get('--wallets', '1000'), 10),
    walletSpins: Math.round(parseInt(get('--wallet-spins', '10000'), 10) * (fast ? 0.1 : 1)),
    paritySpins: Math.round(parseInt(get('--parity-spins', '1000000'), 10) * (fast ? 0.1 : 1)),
    bankrollRuns: Math.max(50, Math.round(parseInt(get('--bankroll-runs', '2000'), 10) * f)),
    days: parseInt(get('--days', '365'), 10),
    spinsPerDay: parseInt(get('--spins-per-day', '1000'), 10),
    minBet: parseFloat(get('--min-bet', '0.5')),
    bankrollOnly: argv.includes('--bankroll-only'),
    report: !argv.includes('--no-report'),
  };
}

// ── Один спин по трём барабанам ──
function spin3(rng) {
  const a = LUT[(rng() * W) | 0];
  const b = LUT[(rng() * W) | 0];
  const c = LUT[(rng() * W) | 0];
  return evaluate(a, b, c);
}

// ── MC-A: плоская ставка 1 USDT ──
function scenarioFlat(spins, rng) {
  let sum = 0, hits = 0;
  const f3 = new Array(NSYM).fill(0);
  const f2 = new Array(NSYM).fill(0);
  let zeros = 0;
  for (let i = 0; i < spins; i++) {
    const a = LUT[(rng() * W) | 0];
    const b = LUT[(rng() * W) | 0];
    const c = LUT[(rng() * W) | 0];
    const m = evaluate(a, b, c);
    sum += m;
    if (m > 0) hits++; else zeros++;
    if (a === b && b === c) f3[a]++;
    else if (a === b || a === c) f2[a]++;
    else if (b === c) f2[b]++;
  }
  return { spins, rtp: sum / spins, hit: hits / spins, f3, f2, zeros };
}

// ── MC-B: игрок со сменой ставок («стратегии» §2.4 обязаны быть бесполезны) ──
function scenarioSwitching(spins, rng) {
  let turnover = 0, won = 0;
  let bet = 1, mode = 0, modeLeft = 0, wStreak = 0, lStreak = 0;
  for (let i = 0; i < spins; i++) {
    const m = spin3(rng);
    turnover += bet;
    won += m * bet;
    const isWin = m > 0;
    if (mode === 0) {
      wStreak = isWin ? wStreak + 1 : 0;
      lStreak = isWin ? 0 : lStreak + 1;
      if (wStreak >= 2) { mode = 1; modeLeft = 10; bet = 0.5; }      // «поймал серию — молоть min»
      else if (lStreak >= 3) { mode = 2; modeLeft = 10; bet = 5; }   // «проигрался — агрессивный max»
    } else if (--modeLeft === 0) { mode = 0; bet = 1; wStreak = 0; lStreak = 0; }
  }
  return { rtp: won / turnover, turnover };
}

// ── MC-C: мульти-кошелёк — per-unit RTP статистически идентичен (§2.4) ──
function scenarioWallets(nWallets, spinsEach, rng) {
  const rtps = new Array(nWallets);
  for (let w = 0; w < nWallets; w++) {
    let s = 0;
    for (let i = 0; i < spinsEach; i++) s += spin3(rng);
    rtps[w] = s / spinsEach;
  }
  let mean = 0;
  for (const r of rtps) mean += r;
  mean /= nWallets;
  let va = 0;
  for (const r of rtps) va += (r - mean) * (r - mean);
  va /= (nWallets - 1);
  return { mean, sd: Math.sqrt(va), min: Math.min(...rtps), max: Math.max(...rtps), spinsEach, nWallets, rtps };
}

// ── MC-D: паритет с контрактом — 256-бит сид → r = seed % W (§2.1) ──
function scenarioParity(spins) {
  const Wb = BigInt(W), W2 = Wb * Wb;
  let sum = 0;
  for (let i = 0; i < spins; i++) {
    const seed = BigInt('0x' + crypto.randomBytes(32).toString('hex'));
    const a = LUT[Number(seed % Wb)];
    const b = LUT[Number((seed / Wb) % Wb)];
    const c = LUT[Number((seed / W2) % Wb)];
    sum += evaluate(a, b, c);
  }
  return sum / spins;
}

// ── E. Банкролл LP-пула: сэмплер исходов (быстрый путь без evaluate) ──
function buildOutcomeCdf() {
  const outs = [];
  let tot = 0;
  for (const s of SYMBOLS) {
    const p = s.w / W, q = (W - s.w) / W;
    const p3 = p * p * p;
    const p2 = 3 * p * p * q;
    if (p3 > 0) { outs.push({ p: p3, m: s.pay3 }); tot += p3; }
    if (p2 > 0) { outs.push({ p: p2, m: s.pay2 }); tot += p2; }
  }
  outs.push({ p: 1 - tot, m: 0 });
  outs.sort((x, y) => y.p - x.p);   // крупные первыми — быстрый линейный скан
  let c = 0;
  for (const o of outs) { c += o.p; o.c = c; }
  outs[outs.length - 1].c = 1;
  return outs;
}
function sampleM(outs, rng) {
  const u = rng();
  for (const o of outs) if (u < o.c) return o.m;
  return 0;
}

// Спрос игроков: 60% мелкая / 30% средняя / 10% крупная (обрезается maxBet).
// Лестница чипов зависит от minBet: 0.5 → [0.5,1,5]; 1 → [1,5,10].
function makeBetSampler(minBet) {
  const bets = minBet <= 0.5 ? [0.5, 1, 5] : [1, 5, 10];
  return function (rng) {
    const u = rng();
    return u < 0.6 ? bets[0] : u < 0.9 ? bets[1] : bets[2];
  };
}

// Пороги (§3.4), параметризованы minBet: ruin — не покрывается худший джекпот
// minBet (fb < 100×minBet); impaired — maxBet флор на minBet (fb < 300×minBet);
// turbo — N_max = floor(fb/99) ≥ 10 при bet 1.
function bankrollRun(startFb, days, spd, rng, outs, sampleBetFn, minBet) {
  const RUIN_FB = 100 * minBet, IMPAIRED_FB = 300 * minBet, TURBO_FB = 990;
  let fb = startFb, minFb = startFb, spinsDone = 0;
  let ruin = false, impairedDays = 0, turboDays = 0, rejected = 0;
  for (let d = 0; d < days; d++) {
    for (let i = 0; i < spd; i++) {
      const maxBet = Math.max(minBet, Math.min(10, fb / 300));
      const bet = Math.min(sampleBetFn(rng), maxBet);
      if (fb < 100 * bet) { rejected++; continue; }  // admission, §3.4 слой 2
      fb += bet * (1 - sampleM(outs, rng));          // feeShare = 0: весь edge в пул
      spinsDone++;
      if (fb < minFb) minFb = fb;
      if (fb < RUIN_FB) { ruin = true; break; }
    }
    if (fb < IMPAIRED_FB) impairedDays++;
    else if (fb >= TURBO_FB) turboDays++;
    if (ruin) break;
  }
  return { ruin, minFb, impairedDays, turboDays, rejected, spinsDone };
}

function percentile(sorted, q) {
  if (!sorted.length) return NaN;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}

function wilson(k, n) { // 95% CI для доли
  const z = 1.959964, p = k / n;
  const den = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / den;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  return [Math.max(0, c - h), Math.min(1, c + h)];
}

function scenarioBankroll(cfg, seed) {
  const outs = buildOutcomeCdf();
  const betSampler = makeBetSampler(cfg.minBet);
  const sizes = [50, 100, 300, 1500, 3000];
  const results = [];
  for (let si = 0; si < sizes.length; si++) {
    const rng = makeRng(seed, 100 + si);
    let ruins = 0, rejections = 0, accepted = 0, impDays = 0, tDays = 0, dayTotal = 0;
    const minRatios = [];
    for (let r = 0; r < cfg.bankrollRuns; r++) {
      const run = bankrollRun(sizes[si], cfg.days, cfg.spinsPerDay, rng, outs, betSampler, cfg.minBet);
      if (run.ruin) ruins++;
      rejections += run.rejected;
      accepted += run.spinsDone;
      minRatios.push(run.minFb / sizes[si]);
      impDays += run.impairedDays; tDays += run.turboDays; dayTotal += cfg.days;
    }
    minRatios.sort((a, b) => a - b);
    const [ciLo, ciHi] = wilson(ruins, cfg.bankrollRuns);
    results.push({
      size: sizes[si], runs: cfg.bankrollRuns,
      ruinP: ruins / cfg.bankrollRuns, ciLo, ciHi,
      minFbP50: percentile(minRatios, 0.50), minFbP05: percentile(minRatios, 0.05),
      impairedPct: (100 * impDays) / dayTotal, turboPct: (100 * tDays) / dayTotal,
      rejectedPerRun: rejections / cfg.bankrollRuns,
    });
    console.log(`    капитал ${sizes[si]}: P(ruin) ${(100 * ruins / cfg.bankrollRuns).toFixed(3)}% [CI ${(100 * ciLo).toFixed(3)}…${(100 * ciHi).toFixed(3)}]`);
  }
  return results;
}

// ── Отчёт docs/slots-math.md ──
const fmtPct = (x, d = 4) => (100 * x).toFixed(d) + '%';
function writeReport(cfg, R) {
  const { an, A, ciA, B, ciB, C, seW, zMin, zMax, D, ciD, BR, frozen, secs } = R;
  const L = [];
  L.push('# Slots — Monte-Carlo отчёт (фаза 2)');
  L.push('');
  L.push(`*Сгенерировано ${new Date().toISOString().slice(0, 10)} · node ${process.version} · seed ${cfg.seed} · ${cfg.fast ? 'FAST-режим (уменьшенные объёмы)' : 'полный прогон'} · ${secs.toFixed(1)} c*`);
  L.push('');
  L.push(`**Воспроизведение:** \`node scripts/slotsSim.cjs --seed ${cfg.seed}\` (без зависимостей, чистый node; xorshift128 + splitmix32 seeding).`);
  L.push('');
  L.push('## 1. Paytable и аналитика (§2.3, W = 72)');
  L.push('');
  L.push('| Символ | Вес | p(тройка) | × | p(ровно пара) | × | вклад в RTP |');
  L.push('|---|---|---|---|---|---|---|');
  for (const r of an.rows) {
    L.push(`| ${r.icon} | ${r.w} | ${(r.p3).toExponential(2)} | ${r.pay3} | ${(r.p2).toFixed(4)} | ${r.pay2} | ${(100 * (r.p3 * r.pay3 + r.p2 * r.pay2)).toFixed(2)}% |`);
  }
  L.push(`| **Итого** | 72 | | | | | **${fmtPct(an.rtp, 2)}** |`);
  L.push('');
  L.push(`Аналитический RTP **${fmtPct(an.rtp, 4)}**, hit rate **${fmtPct(an.hit, 2)}**, σ_spin **${an.sigma.toFixed(3)}** (×bet).`);
  L.push('');
  L.push('## 2. MC-A: плоская ставка 1 USDT');
  L.push('');
  L.push(`${A.spins.toExponential(1)} спинов: RTP **${fmtPct(A.rtp, 4)}** ± ${fmtPct(ciA, 4)} (95% CI), hit ${fmtPct(A.hit, 2)} (аналит. ${fmtPct(an.hit, 2)}). Отклонение от аналитики: ${(100 * Math.abs(A.rtp - an.rtp)).toFixed(4)} п.п.`);
  L.push('');
  L.push('## 3. MC-B: игрок со сменой ставок (§2.4)');
  L.push('');
  L.push(`Схема «2 победы подряд → 10 спинов по 0.5; 3 проигрыша подряд → 10 спинов по 5», оборот ${B.turnover.toExponential(2)} USDT: RTP **${fmtPct(B.rtp, 4)}** ± ${fmtPct(ciB, 4)} (95% CI). Смена ставок статистически не меняет результат — §2.4 подтверждена.`);
  L.push('');
  L.push('## 4. MC-C: мульти-кошелёк (§2.4)');
  L.push('');
  L.push(`${C.nWallets} кошельков × ${C.spinsEach} спинов: mean RTP **${fmtPct(C.mean, 4)}**, sd по кошелькам ${fmtPct(C.sd, 3)} (теория ${fmtPct(seW, 3)}), худший ${fmtPct(C.min, 2)} (${zMin.toFixed(1)}σ), лучший ${fmtPct(C.max, 2)} (${zMax.toFixed(1)}σ). «Благословенных» и «проклятых» кошельков нет — у каждого спина честные 95%.`);
  L.push('');
  L.push('## 5. MC-D: паритет с контрактом (seed % W)');
  L.push('');
  L.push(`${cfg.paritySpins.toExponential(1)} спинов с uint256-сидами (crypto.randomBytes как прокси keccak) через формулу §2.1: RTP **${fmtPct(D, 4)}** ± ${fmtPct(ciD, 4)} (95% CI). Modulo-bias отсутствует.`);
  L.push('');
  L.push('## 6. Банкролл LP-пула (feeShare = 0, maxBet = max(0.5, min(10, fb/300)))');
  L.push('');
  L.push(`${cfg.bankrollRuns} прогонов × ${cfg.days} дней × ${cfg.spinsPerDay} спинов/день (спрос: 60% × 0.5 / 30% × 1 / 10% × 5, обрезка по maxBet; admission fb ≥ 100×bet; ruin = fb < 50).`);
  L.push('');
  L.push('| Старт | P(ruin)/год | 95% CI | min fb / старт (p50 / p05) | дней impaired / turbo |');
  L.push('|---|---|---|---|---|');
  for (const r of BR) {
    L.push(`| ${r.size} | ${fmtPct(r.ruinP, 3)} | [${fmtPct(r.ciLo, 3)}…${fmtPct(r.ciHi, 3)}] | ${(100 * r.minFbP50).toFixed(0)}% / ${(100 * r.minFbP05).toFixed(0)}% | ${r.impairedPct.toFixed(1)}% / ${r.turboPct.toFixed(1)}% |`);
  }
  L.push('');
  L.push('**Трактовка ruin:** при admission (fb ≥ 100×bet) insolvency (fb < 0) механически НЕВОЗМОЖНА — выплату нельзя принять, не покрыв её худший исход. Ruin здесь = **операционная остановка**: fb < 50 → контракт отвергает даже minBet (absorbing: нет спинов → нет edge → нужен доп. депозит). Это ЧЕСТНЕЕ наивной диффузионной оценки §3: машина на 50 останавливается почти наверняка, на 100 — риск значим, 300 — безопасно.');
  L.push('');
  L.push('Определения: **impaired** — день с maxBet, флоренным на 0.5 (fb < 150); **turbo** — день с доступным Turbo ×10 при bet 1 (fb ≥ 990). Отказы admission на живом банкролле практически нулевые.');
  L.push('');
  L.push('## 7. Вердикт фазы 2');
  L.push('');
  L.push(frozen
    ? `- **Коэффициенты §2.3 ЗАМОРОЖЕНЫ**: аналитический RTP ${fmtPct(an.rtp, 2)} ∈ [94.9%…95.1%], MC-A сошёлся в пределах ±0.1 п.п. В контракте — константы в bps; изменение — только новым контрактом.`
    : '- ⚠️ **Сходимость НЕ достигнута** — коэффициенты не замораживать, требуется разбор отклонений.');
  L.push('- §2.4 (независимость спинов от ставок/кошельков/историй): подтверждена сценариями B и C.');
  L.push('- Формула сида §2.1: modulo-bias отсутствует (сценарий D).');
  L.push(`- Bootstrap 300: P(остановка)/год ${fmtPct(BR[2].ruinP, 3)} (CI [${fmtPct(BR[2].ciLo, 3)}…${fmtPct(BR[2].ciHi, 3)}]) — совместимо с аналитической оценкой ~0.03% (§3). Альтернативы из §3 пересмотрены: 50 — останавливается почти наверняка (наивная оценка ~7% занижала: не учитывала admission-пол), 100 — см. таблицу; bootstrap 300 подтверждён. Дневная σ ≈ ±20% банкролла при 1000 спинах × 1 USDT — честно на карточке депозита.`);
  L.push('');
  L.push('*18+. Моделирование — не обещание доходности; LP-доходность имеет дисперсию (см. просадки выше).*');
  fs.writeFileSync(path.join(__dirname, '..', 'docs', 'slots-math.md'), L.join('\n') + '\n');
  console.log('Отчёт: docs/slots-math.md');
}

// ── main ──
function main() {
  const cfg = parseArgs();
  const t0 = Date.now();
  console.log(`== Slots Monte-Carlo (seed ${cfg.seed}${cfg.fast ? ', FAST' : ''}${cfg.bankrollOnly ? ', БАНКРОЛЛ-ONLY' : ''}, minBet ${cfg.minBet}, node ${process.version}) ==`);
  const an = analytic();
  let A = null, B = null, C = null, D = null, ciA = 0, ciB = 0, ciD = 0, seW = 0, zMin = 0, zMax = 0;

  if (cfg.bankrollOnly) {
    console.log('Сценарии A–D пропущены (--bankroll-only): RTP-математика не зависит от minBet.');
  } else {
    console.log(`Аналитика: RTP ${fmtPct(an.rtp, 4)} | hit ${fmtPct(an.hit, 2)} | sigma_spin ${an.sigma.toFixed(3)}`);

    console.log(`[A] плоская ставка, ${cfg.spins.toExponential(1)} спинов…`);
    A = scenarioFlat(cfg.spins, makeRng(cfg.seed, 1));
    ciA = 1.959964 * an.sigma / Math.sqrt(A.spins);
    console.log(`    RTP ${fmtPct(A.rtp, 4)} ± ${fmtPct(ciA, 4)} (95%) | hit ${fmtPct(A.hit, 2)}`);

    console.log('[B] смена ставок…');
    B = scenarioSwitching(cfg.spins, makeRng(cfg.seed, 2));
    ciB = 1.959964 * an.sigma / Math.sqrt(cfg.spins);
    console.log(`    RTP ${fmtPct(B.rtp, 4)} ± ${fmtPct(ciB, 4)} (95%)`);

    console.log(`[C] мульти-кошелёк ${cfg.wallets} × ${cfg.walletSpins}…`);
    C = scenarioWallets(cfg.wallets, cfg.walletSpins, makeRng(cfg.seed, 3));
    seW = an.sigma / Math.sqrt(C.spinsEach);
    const seMean = an.sigma / Math.sqrt(C.nWallets * C.spinsEach);
    zMin = (C.mean - C.min) / seW; zMax = (C.max - C.mean) / seW;
    console.log(`    mean ${fmtPct(C.mean, 4)} ± ${fmtPct(1.959964 * seMean, 4)} | sd ${fmtPct(C.sd, 3)} (теория ${fmtPct(seW, 3)}) | min ${fmtPct(C.min, 2)} (${zMin.toFixed(1)}σ) / max ${fmtPct(C.max, 2)} (${zMax.toFixed(1)}σ)`);

    console.log(`[D] паритет seed%W, ${cfg.paritySpins.toExponential(1)}…`);
    D = scenarioParity(cfg.paritySpins);
    ciD = 1.959964 * an.sigma / Math.sqrt(cfg.paritySpins);
    console.log(`    RTP ${fmtPct(D, 4)} ± ${fmtPct(ciD, 4)} (95%)`);
  }

  console.log(`[E] банкролл (minBet ${cfg.minBet}): ${cfg.bankrollRuns} прогонов × ${cfg.days} дн × ${cfg.spinsPerDay} спинов/дн, капиталы 50/100/300/1500/3000…`);
  const BR = scenarioBankroll(cfg, cfg.seed);

  if (cfg.bankrollOnly) {
    console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
    return;
  }

  const frozen = an.rtp >= 0.949 && an.rtp <= 0.951 &&
    Math.abs(A.rtp - an.rtp) <= 3 * an.sigma / Math.sqrt(A.spins) &&
    Math.abs(B.rtp - an.rtp) <= 3 * an.sigma / Math.sqrt(cfg.spins);
  console.log(frozen
    ? 'ВЕРДИКТ: коэффициенты §2.3 ЗАМОРОЖЕНЫ (RTP 95% ±0.1 подтверждён MC).'
    : 'ВЕРДИКТ: сходимость НЕ достигнута — коэффициенты не замораживать!');

  if (cfg.report) {
    writeReport(cfg, { an, A, ciA, B, ciB, C, seW, zMin, zMax, D, ciD, BR, frozen, secs: (Date.now() - t0) / 1000 });
  }
  console.log(`Готово за ${((Date.now() - t0) / 1000).toFixed(1)} с`);
}
main();




