require("dotenv").config();
require("@nomicfoundation/hardhat-verify");

const PRIVATE_KEY = process.env.DEPLOYER_PRIVATE_KEY || "";
const BSCSCAN_API_KEY = process.env.BSCSCAN_API_KEY || "";

/** @type import('hardhat/config').HardhatUserConfig */
module.exports = {
  solidity: {
    version: "0.8.19",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
    },
  },
  paths: {
    sources: "./contracts",
    artifacts: "./artifacts",
    cache: "./cache",
  },
  networks: {
    bscTestnet: {
      url: process.env.BSC_TESTNET_RPC || "https://data-seed-prebsc-1-s1.binance.org:8545",
      chainId: 97,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
    bscMainnet: {
      url: process.env.BSC_MAINNET_RPC || "https://bsc-dataseed.binance.org",
      chainId: 56,
      accounts: PRIVATE_KEY ? [PRIVATE_KEY] : [],
    },
  },
  // Верификация исходного кода контрактов на BscScan — снижает вероятность
  // того, что кошельки (MetaMask/Blockaid и т.п.) помечают только что
  // задеплоенные Mainnet-контракты как "untrusted"/подозрительные при
  // запросе approve, т.к. становится виден открытый исходный код.
  //
  // BscScan мигрировал на единый Etherscan API V2 — один и тот же ключ
  // (полученный на bscscan.com/myapikey) теперь работает для ЛЮБОЙ
  // поддерживаемой сети (BSC Mainnet/Testnet и т.д.) через один общий
  // endpoint api.etherscan.io/v2/api с параметром chainId. Задавать apiKey
  // одной строкой (а не объектом по сетям) — именно это заставляет
  // @nomicfoundation/hardhat-verify использовать новый V2 API.
  etherscan: {
    apiKey: BSCSCAN_API_KEY,
  },
};
