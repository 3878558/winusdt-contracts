// Keeper: дожидается canRefund на тире 5 (V2) и выполняет refundAll.
// Фон: Start-Process node scripts\keeperRefund5.cjs (лог в tools\keeper5.log)
require("dotenv").config();
const { ethers } = require("ethers");
const p = new ethers.providers.JsonRpcProvider(process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org");
const c = new ethers.Contract("0xab3DB18131b21a1758EF5fb16fc157e7604E2a71",
  ["function canRefund() view returns (bool)", "function refundAll()", "function getRoundResult(uint256) view returns (address,uint256,uint256,bool,bool)"], p);
const w = new ethers.Wallet(process.env.DEPLOYER_PRIVATE_KEY, p);
const lc = c.connect(w);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const DEADLINE = Date.now() + 5 * 60 * 60 * 1000;

(async () => {
  console.log("Keeper tier5 запущен", new Date().toISOString());
  while (Date.now() < DEADLINE) {
    try {
      const st = Number(String(await c.state()));
      if (st === 3 || st === 0) {
        if (await lc.canRefund()) {
          console.log("canRefund=true — выполняю refundAll…");
          const rec = await (await lc.refundAll()).wait();
          console.log("Refund tx:", rec.transactionHash);
          const res = await c.getRoundResult(Number(String(await c.roundId())) - 1);
          console.log("Раунд помечен refunded:", res[3]);
          console.log("=== KEEPER DONE ===");
          return;
        }
      } else if (st === 2) {
        console.log("Раунд уже CLOSED — refund не нужен");
        return;
      }
    } catch (e) { console.warn("poll error:", String(e.message).slice(0, 100)); }
    await sleep(60000);
  }
  console.log("Keeper: таймаут 5ч без canRefund — проверьте вручную");
})();
