// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function decimals() external view returns (uint8);
}

library SafeERC20 {
    function safeTransferFrom(IERC20 token, address from, address to, uint256 amount) internal {
        bool success = token.transferFrom(from, to, amount);
        require(success, "TransferFrom failed");
    }
    function safeTransfer(IERC20 token, address to, uint256 amount) internal {
        bool success = token.transfer(to, amount);
        require(success, "Transfer failed");
    }
}

// ─────────────────────────────────────────────────────────────────────────
// WinUSDT — SundayLottery. Еженедельная лотерея «клуб 100 мест»:
//   • 100 мест × 10 USDT, ОДИН адрес = ОДИН билет в неделю (1 адрес = 1 место);
//   • продажи всю неделю, дедлайн — воскресенье 18:00 UTC (якорь из деплоя,
//     дальше строго +7 дней на неделю: дрейфа расписания нет);
//   • состав ЛЮБОЙ ≥ 1 → розыгрыш в срок (не надо «добирать 10» как в V2);
//   • состав 0 → skipWeek(): неделя пропускается без розыгрыша (permissionless);
//   • пул ≤ 1000 USDT, победитель 95% (до 950), казна 5% (до 50);
//   • приз победителю копится в pendingPrizes — можно забрать в любой момент
//     следующих недель (открытие новой недели НЕ блокируется чужим призом),
//     казна получает свои 5% сразу в транзакции розыгрыша.
//
// Честный RNG — та же схема, что в FlexibleLotteryV2 (зафиксирована после
// инцидента V1 со снайпер-ботами): сид = keccak256(blockhash(sealBlock),
// weekId, seatCount), где sealBlock — блок запечатывания продаж. Хеша блока
// не существует в момент последней покупки (по построению), после COMMIT_DELAY
// блоков он захватывается permissionless commitHash() в окно до COMMIT_WINDOW
// (EVM хранит хеши только 256 последних блоков), после фиксации исход
// детерминирован навсегда — «отказ от розыгрыша» и revert-майнинг ничего
// не меняют. COMMIT_DELAY покрывает реорги (BSC finality ≈ 2 блока).
//
// Ончейн-страховка от мёртвого keeper'а (урок V2): если неделя запечатана,
// но розыгрыш не дошёл — окно коммита истекло без хеша, или хеш закоммичен,
// а draw не случился за SEAL_GRACE после дедлайна — refundWeek() возвращает
// ВСЕМ 100% и открывает следующую неделю. Никогда не зависшие деньги.
// ─────────────────────────────────────────────────────────────────────────
contract SundayLottery {
    using SafeERC20 for IERC20;

    // 0=OPEN (продажи), 1=SEALED (продажи закрыты, ждём commit+draw), 2=SETTLED (розыгрыш недели состоялся).
    enum Weekstate { OPEN, SEALED, SETTLED }
    Weekstate public state = Weekstate.OPEN;

    IERC20 public immutable usdt;
    uint256 public immutable ticketPrice;
    address public immutable treasury;     // получает 5% пула в tx розыгрыша

    uint256 public constant SEAT_CAP = 100;
    uint256 public constant WINNER_SHARE = 95;
    uint256 public constant TREASURY_SHARE = 5;
    uint256 public constant PRECISION = 100;

    // ── Таймлайн недели ──
    // weekDeadline(w) = weekAnchor + (w-1)*7d. weekAnchor — дедлайн недели 1
    // (воскресенье 18:00 UTC), фиксируется деплоем. Даже после простоя
    // keeper'а расписание не плывёт: пропущенные недели докатываются
    // skipWeek() до ближайшего будущего дедлайна.
    uint256 public immutable weekAnchor;
    uint256 public constant WEEK_PERIOD = 7 days;

    // Окно захвата сида — те же константы, что в FlexibleLotteryV2.
    uint256 public constant COMMIT_DELAY  = 20;
    uint256 public constant COMMIT_WINDOW = 250;

    // Страховка: если хеш закоммичен, но draw не случился через 2 часа после
    // дедлайна — refundWeek() открывается (обычный розыгрыш занимает минуты).
    uint256 public constant SEAL_GRACE = 2 hours;

    uint256 public weekId = 1;
    uint256 public totalWeeksCompleted;
    address public lastWinner;

    address[] public seats;  // участники ТЕКУЩЕЙ недели по местам (1..100)
    // Метка «взял место» отдельно от массива: O(1) защита «1 адрес = 1 место».
    // Ключ — weekId, поэтому очистка после розыгрыша не нужна: следующая
    // неделя читает свежие ключи.
    mapping(uint256 => mapping(address => bool)) public joined;

    mapping(address => uint256) public pendingPrizes;
    uint256 public totalPendingPrizes;

    uint256 public sealBlock;        // блок запечатывания продаж (источник сида)
    bytes32 public committedHash;    // захваченный blockhash(sealBlock)
    bool     public hashCommitted;

    struct WeekResult {
        address winner;
        uint256 prize;
        uint256 treasuryFee;
        uint256 seats;
        uint256 winnerSeat;
        bool refunded;
        bool hasResult;
    }
    mapping(uint256 => WeekResult) private weekResults;

    event WeekOpened(uint256 indexed weekId, uint256 deadline);
    event SeatPurchased(uint256 indexed weekId, address indexed player, uint256 seat, uint256 seatCount, uint256 pool);
    event WeekSealed(uint256 indexed weekId, uint256 sealBlock);
    event HashCommitted(uint256 indexed weekId, uint256 sealBlock, bytes32 hash);
    event WinnerDeclared(uint256 indexed weekId, address winner, uint256 winnerSeat, uint256 prize, uint256 treasuryFee);
    event WeekSkipped(uint256 indexed weekId, uint256 nextWeekId);
    event WeekRefunded(uint256 indexed weekId, uint256 playersRefunded, uint256 totalRefunded);
    event PrizeClaimed(address indexed winner, uint256 amount);
    event PrizeForceClaimed(address indexed winner, uint256 amount, address indexed by);

    constructor(
        address _usdtAddress,
        uint256 _ticketPrice,
        address _treasury,
        uint256 _firstDeadline
    ) {
        require(_ticketPrice > 0, "Ticket price > 0");
        require(_treasury != address(0), "Treasury = 0");
        require(_firstDeadline > block.timestamp + 30 minutes, "First deadline too soon");
        require(WINNER_SHARE + TREASURY_SHARE == PRECISION, "Invalid percentages");

        usdt = IERC20(_usdtAddress);
        ticketPrice = _ticketPrice;
        treasury = _treasury;
        weekAnchor = _firstDeadline;
        emit WeekOpened(weekId, weekDeadline(weekId));
    }

    function weekDeadline(uint256 _weekId) public view returns (uint256) {
        return weekAnchor + (_weekId - 1) * WEEK_PERIOD;
    }

    function currentDeadline() external view returns (uint256) {
        return weekDeadline(weekId);
    }

    // ── Покупка места (1 адрес = 1 место = 1 билет) ──────────────────────
    function buySeat() external {
        require(state == Weekstate.OPEN, "Sales closed");
        require(block.timestamp < weekDeadline(weekId), "Week deadline passed");
        require(!joined[weekId][msg.sender], "One seat per address");
        require(seats.length < SEAT_CAP, "All seats taken");
        // Приз прошлой недели НЕ мешает новой продаже: недели катятся по
        // расписанию независимо от того, забрал ли победитель приз.

        joined[weekId][msg.sender] = true;
        seats.push(msg.sender);
        usdt.safeTransferFrom(msg.sender, address(this), ticketPrice);
        emit SeatPurchased(weekId, msg.sender, seats.length, seats.length, usdt.balanceOf(address(this)));
    }

    // ── Запечатывание продаж (permissionless, после воскресного дедлайна) ──
    // Фиксирует блок-источник сида. С этого мгновения состав недели заморожен.
    function sealWeek() external {
        require(state == Weekstate.OPEN, "Not open");
        require(block.timestamp >= weekDeadline(weekId), "Too early: deadline");
        require(seats.length > 0, "No seats: use skipWeek");
        state = Weekstate.SEALED;
        sealBlock = block.number;
        hashCommitted = false;
        committedHash = bytes32(0);
        emit WeekSealed(weekId, sealBlock);
    }

    // ── Захват сида (permissionless) ─────────────────────────────────────
    // Фиксирует blockhash(sealBlock) в стейте — та же механика, что
    // commitHash() в FlexibleLotteryV2 (комментарии с обоснованием там).
    function commitHash() external {
        require(state == Weekstate.SEALED, "Not sealed");
        require(!hashCommitted, "Already committed");
        require(block.number >= sealBlock + COMMIT_DELAY, "Too early: commit delay");
        require(block.number <= sealBlock + COMMIT_WINDOW, "Too late: hash window missed");
        bytes32 h = blockhash(sealBlock);
        require(h != bytes32(0), "Hash unavailable");
        committedHash = h;
        hashCommitted = true;
        emit HashCommitted(weekId, sealBlock, h);
    }

    // ── Розыгрыш (permissionless, после захвата сида) ────────────────────
    function triggerDraw() external {
        require(state == Weekstate.SEALED, "Not sealed");
        require(hashCommitted, "Hash not committed yet");
        uint256 count = seats.length;
        uint256 pool = count * ticketPrice;
        uint256 fee = (pool * TREASURY_SHARE) / PRECISION;
        uint256 prize = pool - fee;

        // Сид = хеш блока запечатывания. Все места оплачены ДО того, как
        // этот хеш стал существовать; после фиксации исход навсегда один и тот же.
        uint256 seed = uint256(keccak256(abi.encodePacked(committedHash, weekId, count)));
        uint256 winIndex = seed % count;
        address winner = seats[winIndex];
        uint256 winSeat = winIndex + 1;

        pendingPrizes[winner] += prize;
        totalPendingPrizes += prize;
        lastWinner = winner;

        weekResults[weekId] = WeekResult({
            winner: winner,
            prize: prize,
            treasuryFee: fee,
            seats: count,
            winnerSeat: winSeat,
            refunded: false,
            hasResult: true
        });
        delete seats;
        emit WinnerDeclared(weekId, winner, winSeat, prize, fee);

        // Комиссия казны уходит сразу в tx розыгрыша (BSC-peg USDT без хуков,
        // reentrancy невозможна; effects-before-interactions соблюдены).
        usdt.safeTransfer(treasury, fee);
        state = Weekstate.SETTLED;
    }

    // ── Пропуск пустой недели (permissionless) ───────────────────────────
    // Состав 0 → розыгрыша нет, недели просто докатываются по якорному
    // расписанию до ближайшего будущего воскресенья.
    function skipWeek() external {
        require(state == Weekstate.OPEN, "Not open");
        require(block.timestamp >= weekDeadline(weekId), "Too early: deadline");
        require(seats.length == 0, "Has seats: use sealWeek");
        uint256 skipped = weekId;
        _openNextWeek();
        emit WeekSkipped(skipped, weekId);
    }

    // ── Открытие следующей недели (permissionless, после розыгрыша) ──────
    // Не требует claim'а приза: приз висит в pendingPrizes, сколько нужно.
    function openNextWeek() external {
        require(state == Weekstate.SETTLED, "Draw not done");
        _openNextWeek();
    }

    function _openNextWeek() internal {
        weekId++;
        totalWeeksCompleted++;
        sealBlock = 0;
        hashCommitted = false;
        committedHash = bytes32(0);
        state = Weekstate.OPEN;
        emit WeekOpened(weekId, weekDeadline(weekId));
    }

    // ── Страховка (permissionless): неделя зависла без розыгрыша → 100% ──
    // Два допустимых сценария:
    //   A) окно коммита истекло, хеш так и не захвачен (keeper умер после
    //      sealWeek) — дальше розыгрыш невозможен в принципе;
    //   B) хеш закоммичен, но draw не случился за SEAL_GRACE после дедлайна
    //      — технически розыгрыш ещё возможен, но возврат 100% честнее
    //      многодневного зависания (как refundAll после fullGrace в V2).
    function refundWeek() external {
        require(state == Weekstate.SEALED, "Not sealed");
        require(
            (block.number > sealBlock + COMMIT_WINDOW && !hashCommitted) ||
            (hashCommitted && block.timestamp > weekDeadline(weekId) + SEAL_GRACE),
            "Draw still possible"
        );
        uint256 count = seats.length;
        uint256 refund = ticketPrice;
        uint256 total = 0;
        for (uint256 i = 0; i < count; i++) {
            usdt.safeTransfer(seats[i], refund);
            total += refund;
        }
        weekResults[weekId] = WeekResult({
            winner: address(0),
            prize: 0,
            treasuryFee: 0,
            seats: count,
            winnerSeat: 0,
            refunded: true,
            hasResult: true
        });
        delete seats;
        emit WeekRefunded(weekId, count, total);
        _openNextWeek();
    }

    // ── Выплата призов ───────────────────────────────────────────────────
    function claimPrize() external {
        uint256 prize = pendingPrizes[msg.sender];
        require(prize > 0, "No prize");
        pendingPrizes[msg.sender] = 0;
        totalPendingPrizes -= prize;
        usdt.safeTransfer(msg.sender, prize);
        emit PrizeClaimed(msg.sender, prize);
    }

    // Принудительная выплата казной (победитель — контракт без функции
    // получения, или просто не приходит за призом).
    function forceClaimPrize(address winner) external {
        require(msg.sender == treasury, "Only treasury");
        uint256 amount = pendingPrizes[winner];
        require(amount > 0, "No prize");
        pendingPrizes[winner] = 0;
        totalPendingPrizes -= amount;
        usdt.safeTransfer(winner, amount);
        emit PrizeForceClaimed(winner, amount, msg.sender);
    }

    // ── View-функции (keeper/UI) ─────────────────────────────────────────
    function seatCount() external view returns (uint256) { return seats.length; }
    function hasSeat(address player) external view returns (bool) { return joined[weekId][player]; }

    // Номер места игрока в текущей неделе (0 = места нет). O(100) — view.
    function mySeat(address player) external view returns (uint256) {
        if (!joined[weekId][player]) return 0;
        for (uint256 i = 0; i < seats.length; i++) {
            if (seats[i] == player) return i + 1;
        }
        return 0;
    }

    function getPrizePool() external view returns (uint256) { return usdt.balanceOf(address(this)); }

    function canSeal() public view returns (bool) {
        return state == Weekstate.OPEN
            && block.timestamp >= weekDeadline(weekId)
            && seats.length > 0;
    }
    function canSkip() public view returns (bool) {
        return state == Weekstate.OPEN
            && block.timestamp >= weekDeadline(weekId)
            && seats.length == 0;
    }
    function canCommit() public view returns (bool) {
        return state == Weekstate.SEALED && !hashCommitted
            && block.number >= sealBlock + COMMIT_DELAY
            && block.number <= sealBlock + COMMIT_WINDOW;
    }
    function canDraw() public view returns (bool) {
        return state == Weekstate.SEALED && hashCommitted;
    }
    function canRefund() public view returns (bool) {
        if (state != Weekstate.SEALED) return false;
        return (block.number > sealBlock + COMMIT_WINDOW && !hashCommitted)
            || (hashCommitted && block.timestamp > weekDeadline(weekId) + SEAL_GRACE);
    }
    function canOpenNext() public view returns (bool) {
        return state == Weekstate.SETTLED;
    }

    function getWeekStatus() external view returns (
        uint8 st,
        uint256 seatCount_,
        uint256 deadline,
        uint256 sealBlk,
        bool hashOk,
        bytes32 hash,
        uint256 pool
    ) {
        return (
            uint8(state),
            seats.length,
            weekDeadline(weekId),
            sealBlock,
            hashCommitted,
            committedHash,
            usdt.balanceOf(address(this))
        );
    }

    // Результат недели — хранится в контракте, доступен с любого устройства.
    function getWeekResult(uint256 _weekId) external view returns (
        address winner,
        uint256 prize,
        uint256 treasuryFee,
        uint256 seats_,
        uint256 winnerSeat,
        bool refunded,
        bool hasResult
    ) {
        WeekResult storage r = weekResults[_weekId];
        return (r.winner, r.prize, r.treasuryFee, r.seats, r.winnerSeat, r.refunded, r.hasResult);
    }

    receive() external payable { revert("BNB not accepted"); }
    fallback() external payable { revert("BNB not accepted"); }
}