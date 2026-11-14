require("dotenv").config();
const { ethers } = require("ethers");

const CONTRACT_ADDRESS = "0x822b3e24c92689DF53aF6E0f0a64299219dD0c6f";
const RPC = process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545";

const ABI = [
  "function state() view returns (uint8)",
  "function roundId() view returns (uint256)",
  "function uniquePlayersCount() view returns (uint256)",
  "function maxPlayers() view returns (uint256)",
  "function getTotalTickets() view returns (uint256)",
  "function totalPendingPrizes() view returns (uint256)",
  "function accumulatedFees() view returns (uint256)",
  "function getWaitlistLength() view returns (uint256)",
];

async function main() {
  const provider = new ethers.providers.JsonRpcProvider(RPC);
  const c = new ethers.Contract(CONTRACT_ADDRESS, ABI, provider);
  const [state, roundId, unique, maxP, total, pending, fees, wl] = await Promise.all([
    c.state(), c.roundId(), c.uniquePlayersCount(), c.maxPlayers(),
    c.getTotalTickets(), c.totalPendingPrizes(), c.accumulatedFees(), c.getWaitlistLength(),
  ]);
  console.log("state:", ["OPEN", "CALCULATING", "CLOSED"][state]);
  console.log("roundId:", roundId.toString());
  console.log("uniquePlayers:", unique.toString(), "/", maxP.toString());
  console.log("totalTickets:", total.toString());
  console.log("totalPendingPrizes:", pending.toString());
  console.log("accumulatedFees:", fees.toString());
  console.log("waitlistLength:", wl.toString());
}
main().catch((e) => { console.error(e); process.exit(1); });
