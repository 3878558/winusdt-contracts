// scripts/rebalanceBnb.cjs
//
// Выравнивание BNB по тест-кошелькам до целевого остатка: излишки (кошелёк 2)
// через казну уходят дефицитным (1/3/4/5). Одноразовая утилита под марафон.
//
// Запуск: node scripts/rebalanceBnb.cjs [targetBNB=0.03] [wallets=5]
require("dotenv").config();
const { ethers } = require("ethers");

// Публичные RPC ротируются на ретраях: bsc-dataseed периодически капризничает
const RPCS = [
  process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org",
  "https://bsc-dataseed2.binance.org",
  "https://bsc.publicnode.com",
];

(async () => {
  const target = ethers.utils.parseEther(process.argv[2] || "0.03");
  const count = Number(process.argv[3] || 5);
  const provider = new ethers.providers.JsonRpcProvider(
    process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org"
  );
  const treasury = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, provider);
  const keys = (process.env.TEST_PRIVATE_KEYS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const W = keys.slice(0, count).map((k) => new ethers.Wallet(k, provider));
  const F = ethers.utils.formatEther;
  const reserve = ethers.utils.parseEther("0.002");

  // 1) излишки → казна
  let collected = ethers.BigNumber.from(0);
  for (let i = 0; i < W.length; i++) {
    const b = await provider.getBalance(W[i].address);
    if (b.gt(target)) {
      const sur = b.sub(target);
      console.log(`кошелёк ${i + 1} → казна: ${F(sur)} BNB (излишек)`);
      await (await W[i].sendTransaction({ to: treasury.address, value: sur })).wait();
      collected = collected.add(sur);
    }
  }
  // 2) казна → дефицитным (по максимуму доступного, казна не в минус)
  for (let i = 0; i < W.length; i++) {
    const b = await provider.getBalance(W[i].address);
    const def = target.sub(b);
    if (def.lte(ethers.utils.parseEther("0.001"))) continue; // пыльный недовнос — не тратим газ
    const tb = await provider.getBalance(treasury.address);
    if (tb.lte(reserve)) {
      console.log(`казна без резерва (${F(tb)}) — кошелёк ${i + 1} остался с ${F(b)}`);
      continue;
    }
    const v = def.gt(tb.sub(reserve)) ? tb.sub(reserve) : def;
    console.log(`казна → кошелёк ${i + 1}: ${F(v)} BNB`);
    let sent = false;
    for (let a = 0; a < 3 && !sent; a++) {
      try {
        const p2 = new ethers.providers.JsonRpcProvider(RPCS[a % RPCS.length]);
        const t2 = treasury.connect(p2); // ротация ноды на каждом ретрае
        await new Promise((r) => setTimeout(r, 1500 * a));
        await (await t2.sendTransaction({ to: W[i].address, value: v, gasLimit: 21000 })).wait();
        sent = true;
      } catch (e) {
        console.log(`  попытка ${a + 1} (rpc ${RPCS[a % RPCS.length]}) не прошла: ${String((e && e.message) || e).slice(0, 80)}`);
        if (a === 2) console.log(`  кошелёк ${i + 1} остался с ${F(b)} — добей ребаланс повторным запуском`);
      }
    }
  }
  // 3) отчёт
  for (let i = 0; i < W.length; i++) console.log(`кошелёк ${i + 1}: BNB ${F(await provider.getBalance(W[i].address))}`);
  console.log(`казна BNB: ${F(await provider.getBalance(treasury.address))} | собрано излишков: ${F(collected)}`);
})().catch((e) => {
  console.error("FATAL:", (e && (e.reason || e.message)) || e);
  process.exitCode = 1;
});
