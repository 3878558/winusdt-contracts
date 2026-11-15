// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

// Тестовые моки для adversarial-тестов Slots (test/slots.test.cjs):
//   • MockFeeToken — USDT с fee-on-transfer 5% (депозит кредитуется по
//     факту, escrow спина обязан отвергнуть недостачу);
//   • ReentrantUSDT — вызывает onReceive получателя при переводе;
//   • PayoutSpy — получатель выплаты: проверяет CEI (escrow=0 и сессия
//     закрыты ЕЩЁ ДО внешнего перевода) и безуспешность повторного
//     resolveFor внутри колбэка.

interface ISlotsLike {
    function totalEscrow() external view returns (uint256);
    function activeSession(address p) external view returns (uint256, uint256, uint256, bool);
    function resolveFor(address p) external;
}

contract MockFeeToken {
    string public name = "fee";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount * 95 / 100; // 5% сгорает
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allow");
        require(balanceOf[from] >= amount, "bal");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount * 95 / 100; // 5% сгорает
        return true;
    }
}

contract ReentrantUSDT {
    string public name = "hook";
    uint8 public decimals = 18;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    address public hook; // получатель, у которого зовём onReceive

    function setHook(address h) external { hook = h; }
    function mint(address to, uint256 amount) external { balanceOf[to] += amount; }
    function approve(address s, uint256 a) external returns (bool) {
        allowance[msg.sender][s] = a; return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        require(balanceOf[msg.sender] >= amount, "bal");
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        if (to == hook) IPayoutSpy(to).onReceive(msg.sender, to, amount);
        return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        require(allowance[from][msg.sender] >= amount, "allow");
        require(balanceOf[from] >= amount, "bal");
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        if (to == hook) IPayoutSpy(to).onReceive(from, to, amount);
        return true;
    }
}

interface IPayoutSpy {
    function onReceive(address from, address to, uint256 amount) external;
}

// «Игрок-шпион»: получает выплату и ВНУТРИ колбэка перевода проверяет,
// что состояние Slots уже чистое (CEI), а повторный resolve rejected.
contract PayoutSpy is IPayoutSpy {
    ISlotsLike public slots;
    uint256 public escrowSeenDuringPayout = type(uint256).max;
    bool public sessionSeenDuringPayout = true;
    bool public doubleResolveSucceeded;
    uint256 public payoutReceived;

    function arm(ISlotsLike s) external { slots = s; }

    function onReceive(address, address, uint256 amount) external override {
        payoutReceived += amount;
        escrowSeenDuringPayout = slots.totalEscrow();
        (, , , bool active) = slots.activeSession(address(this));
        sessionSeenDuringPayout = active;
        // Атака: двойной resolve внутри перевода. CEI должен отсечь.
        try slots.resolveFor(address(this)) { doubleResolveSucceeded = true; }
        catch { doubleResolveSucceeded = false; }
    }

    // ── входы игрока (вызываются тестом отдельными tx) ──
    function spinOnly(address s, address t, uint256 bet) external {
        IERC20(t).approve(s, type(uint256).max);
        Slots(s).spin(bet);
    }

    function resolveOnly(address s) external {
        Slots(s).resolveFor(address(this));
    }
}

interface Slots {
    function spin(uint256 bet) external;
    function resolveFor(address p) external;
}
interface IERC20 {
    function approve(address s, uint256 a) external returns (bool);
}

// Снайпер V1-стиля: «поставил → сразу узнал исход → отменил если проигрыш»
// в ОДНОЙ транзакции. В Slots resolve того же блока невозможен → вся
// атомарная разведка revert-ится целиком.
contract AtomicAttack {
    function probe(address s, address t, uint256 bet) external {
        IERC20(t).approve(s, type(uint256).max);
        Slots(s).spin(bet);
        Slots(s).resolveFor(address(this)); // должен revert «wait betBlock+1»
    }
}
