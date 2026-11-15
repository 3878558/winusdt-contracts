// scripts/slotsMarathon.cjs
//
// Марафон: поочерёдные прогоны slotsLoop с кошельков 1..5 по 200 спинов
// (v2 эксклюзив — машина принимает одного игрока, поэтому строго
// последовательно). Между прогонами slotsLoop делает пост-ран свип
// (выигрыш кошелька → LP-банкролл), так что банкролл не истощается.
// Падение одного прогона не останавливает марафон — итог в конце.
//
// Запуск: node scripts/slotsMarathon.cjs mainnet <slotsAddr> [spins=200] [bet=0.5] [from=1] [to=5]
require("dotenv").config();
const { spawnSync } = require("child_process");

(async () => {
  const network = process.argv[2] || "mainnet";
  const addr = process.argv[3] || "0xC99caA15e1C3CDdBb458acdbBED584279766bCdb";
  const spins = process.argv[4] || "200";
  const bet = process.argv[5] || "0.5";
  const from = Number(process.argv[6] || 1);
  const to = Number(process.argv[7] || 5);

  console.log(`МАРАФОН: кошельки ${from}..${to} × ${spins} спинов × ${bet} USDT (машина ${addr})`);
  const t0 = Date.now();
  const results = [];
  for (let i = from; i <= to; i++) {
    console.log(`\n██████████ ПРОГОН ${i}/${to} (кошелёк №${i}) ██████████`);
    const r = spawnSync(process.execPath, ["scripts/slotsLoop.cjs", network, addr, String(spins), bet, String(i)], {
      stdio: "inherit",
      env: process.env,
    });
    results.push({ wallet: i, code: r.status });
    console.log(`── кошелёк ${i}: exit ${r.status}`);
  }
  const min = Math.round((Date.now() - t0) / 60000);
  console.log("\n════════ МАРАФОН ЗАВЕРШЁН ════════");
  console.log(`время: ~${min} мин`);
  for (const r of results) console.log(`кошелёк ${r.wallet}: exit ${r.code} ${r.code === 0 ? "✓" : r.code === 2 ? "⚠ остановлен стопом" : "✗ ошибка"}`);
})();
