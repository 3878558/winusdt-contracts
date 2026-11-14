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
// WinUSDT — FlexibleLottery V2. Модель «10 или возврат» (fill-or-refund):
//   • Таймер раунда стартует с покупки ПЕРВОГО билета (roundDuration = 1 ч);
//   • Собрался полный состав (10/10) → FULL → розыгрыш может запустить
//     ЛЮБОЙ (permissionless) после COMMIT_DELAY блоков от блока заполнения;
//   • Не собрался за окно → ЛЮБОЙ вызывает refundAll(), каждому 100%;
//   • Собрался, но розыгрыш никто не дёрнул за fullGrace → тоже refundAll()
//     (ончейн-страховка от мёртвого keeper'а).
//
// Честный RNG (фикс эксплойта V1, съевшего ~176 USDT снайпер-ботам):
// в V1 сид считался из данных ТЕКУЩЕГО блока внутри tx розыгрыша, поэтому
// бот мог атомарно «купить → дёрнуть startDraw → проверить → revert при
// проигрыше» и повторять до выигрыша без риска. В V2 сид =
// keccak256(blockhash(блока заполнения), roundId, totalTickets): хеш блока
// заполнения не существует в момент подписания последней покупки (по
// построению), а после фиксации блока исход закреплён навсегда —
// revert-майнинг и отказ от розыгрыша ничего не меняют. EVM отдаёт хеши
// только 256 последних блоков, поэтому хеш фиксируется в стейте отдельным
// permissionless вызовом commitHash() в окне [fill+COMMIT_DELAY,
// fill+COMMIT_WINDOW]. COMMIT_DELAY покрывает реорги (BSC finality ≈ 2).
//
// Удалено из V1: startDraw/creatorStartDraw (ранний публичный розыгрыш —
// весь смысл атаки), waitlist (не нужен в fill-or-refund), refundMyTickets
// (возврат и так максимум через час), emergencyRefundAll (заменён
// permissionless refundAll). ABI-совместимость с фронтендом сохранена:
// те же view-функции, порядок enum, основные события.
// ─────────────────────────────────────────────────────────────────────────
contract FlexibleLotteryV2 {
    using SafeERC20 for IERC20;

    // Порядок значений как в V1 — фронтенд мапит 0..3 без изменений
    // (0=OPEN, 1=CALCULATING, 2=CLOSED, 3=FULL).
    enum Lotterystate { OPEN, CALCULATING, CLOSED, FULL }
    Lotterystate public state = Lotterystate.OPEN;

    IERC20 public immutable usdt;
    uint256 public ticketPrice;
    uint256 public immutable tokenDecimals;

    address payable[] public tickets;
    mapping(address => uint256) public ticketsPerPlayer;
    uint256 public maxTicketsTotal;
    uint256 public maxTicketsPerPlayer;
    uint256 public maxPlayers;

    uint256 public roundId = 1;
    uint256 public totalRoundsCompleted;

    uint256 public constant WINNER_COUNT = 1;
    uint256 public constant CREATOR_FEE = 5;
    uint256 public constant WINNER_SHARE = 95;
    uint256 public constant PRECISION = 100;

    address public immutable creator;
    uint256 public totalPendingPrizes;
    uint256 public accumulatedFees;
    mapping(address => uint256) public pendingPrizes;
    address public lastWinner;

    // ── Таймлайн раунда (V2) ──
    uint256 public roundDuration;   // окно сбора, сек (дефолт 3600)
    uint256 public fullGrace;       // окно розыгрыша FULL-раунда, сек (3600)
    uint256 public firstTicketAt;   // 0 = билетов ещё не было (раунд не тикает)
    uint256 public roundDeadline;   // firstTicketAt + roundDuration
    uint256 public fillBlock;       // блок, в котором набрался полный состав
    bytes32 public committedHash;   // захваченный blockhash(fillBlock)
    bool     public hashCommitted;

    // Хеш блока заполнения можно захватить не раньше COMMIT_DELAY блоков
    // (реорг-запас поверх BSC finality ≈ 2 блока) и не позже COMMIT_WINDOW
    // (EVM отдаёт хеши только 256 последних блоков).
    uint256 public constant COMMIT_DELAY  = 20;
    uint256 public constant COMMIT_WINDOW = 250;

    struct RoundResult {
        address winner;
        uint256 prize;
        uint256 creatorFee;
        bool refunded;   // true, если раунд закрыт refundAll() без победителя
        bool hasResult;
    }
    mapping(uint256 => RoundResult) private roundResults;

    event TicketsPurchased(uint256 indexed roundId, address indexed player, uint256 quantity, uint256 totalCost, uint256 playerTotalTickets);
    event RoundFull(uint256 indexed roundId, uint256 totalTickets, uint256 prizePool);
    event HashCommitted(uint256 indexed roundId, uint256 fillBlock, bytes32 hash);
    event DrawStarted(uint256 indexed roundId, uint256 totalTickets, uint256 prizePool, string reason);
    event WinnerDeclared(uint256 indexed roundId, address winner, uint256 prize, uint256 creatorFee);
    event RoundRefunded(uint256 indexed roundId, uint256 playersRefunded, uint256 totalRefunded);
    // nextDrawTime в V1 значил «когда можно розыгрыш»; в V2 сюда кладётся
    // дедлайн СБОРА раунда — имя поля сохранено для совместимости парсеров.
    event RoundOpened(uint256 indexed roundId, uint256 nextDrawTime);
    event CreatorFeeWithdrawn(uint256 amount);
    event PrizeClaimed(address indexed winner, uint256 amount);
    event PrizeForceClaimed(address indexed winner, uint256 amount, address indexed by);
    event BatchPrizeForceClaimed(address[] winners, uint256[] amounts, address indexed by);
    event ParamsUpdated(uint256 ticketPrice, uint256 maxTicketsTotal, uint256 maxTicketsPerPlayer, uint256 maxPlayers, uint256 roundDuration, uint256 fullGrace);

    constructor(
        address _usdtAddress,
        uint256 _ticketPrice,
        uint256 _maxTicketsTotal,
        uint256 _maxTicketsPerPlayer,
        uint256 _maxPlayers,
        uint256 _roundDuration,
        uint256 _fullGrace
    ) {
        require(_ticketPrice > 0, "Ticket price > 0");
        require(_maxTicketsTotal >= 2, "Max tickets >= 2");
        require(_maxTicketsPerPlayer > 0, "Max per player > 0");
        require(_maxPlayers >= 2, "Max players >= 2");
        require(_roundDuration >= 5 minutes, "Round duration too short");
        require(_fullGrace >= 10 minutes, "Full grace too short");
        require(WINNER_COUNT * WINNER_SHARE + CREATOR_FEE == PRECISION, "Invalid percentages");

        usdt = IERC20(_usdtAddress);
        ticketPrice = _ticketPrice;
        maxTicketsTotal = _maxTicketsTotal;
        maxTicketsPerPlayer = _maxTicketsPerPlayer;
        maxPlayers = _maxPlayers;
        roundDuration = _roundDuration;
        fullGrace = _fullGrace;
        creator = msg.sender;
        tokenDecimals = _getTokenDecimals(_usdtAddress);
        emit RoundOpened(roundId, 0);
    }
    // ── Покупка билетов ──────────────────────────────────────────────
    uint256 public uniquePlayersCount;

    function buyTickets(uint256 quantity) external {
        require(state == Lotterystate.OPEN, "Round not open");
        require(totalPendingPrizes == 0, "Previous round prizes not claimed");
        require(quantity > 0, "Quantity > 0");
        require(quantity <= maxTicketsPerPlayer, "Exceeds max per tx");
        require(ticketsPerPlayer[msg.sender] + quantity <= maxTicketsPerPlayer, "Per-player limit");
        require(tickets.length + quantity <= maxTicketsTotal, "Total ticket limit exceeded");

        if (ticketsPerPlayer[msg.sender] == 0) {
            require(uniquePlayersCount + 1 <= maxPlayers, "Max players reached");
        }

        // После истечения окна сбора покупки запрещены: раунд ждёт refundAll
        require(roundDeadline == 0 || block.timestamp <= roundDeadline, "Round window expired");

        // Первый билет раунда запускает таймер («таймер от первого билета» —
        // пустой раунд не тикает и не создаёт тревожных дедлайнов в UI).
        if (tickets.length == 0) {
            firstTicketAt = block.timestamp;
            roundDeadline = block.timestamp + roundDuration;
        }

        if (ticketsPerPlayer[msg.sender] == 0) {
            uniquePlayersCount++;
        }

        uint256 totalCost = ticketPrice * quantity;
        usdt.safeTransferFrom(msg.sender, address(this), totalCost);

        for (uint256 i = 0; i < quantity; i++) {
            tickets.push(payable(msg.sender));
        }
        ticketsPerPlayer[msg.sender] += quantity;
        emit TicketsPurchased(roundId, msg.sender, quantity, totalCost, ticketsPerPlayer[msg.sender]);

        // Раунд собрал полный состав → FULL. Розыгрыш теперь возможен только
        // через захват хеша (commitHash) + triggerDraw — мгновенного пути
        // «купил последним и сразу дёрнул розыгрыш» больше не существует:
        // blockhash(fillBlock) не существует до COMMIT_DELAY блоков.
        if (uniquePlayersCount >= maxPlayers) {
            state = Lotterystate.FULL;
            fillBlock = block.number;
            hashCommitted = false;
            committedHash = bytes32(0);
            emit RoundFull(roundId, tickets.length, usdt.balanceOf(address(this)));
        }
    }

    // ── Захват сида (permissionless) ─────────────────────────────────
    // Фиксирует blockhash(fillBlock) в стейте. Кто угодно может вызвать;
    // обычно это делает keeper или сам победитель (обоим выгодно). Окно
    // ограничено: раньше COMMIT_DELAY — рискуем захватить хеш реоргнувшего
    // блока, позже COMMIT_WINDOW — blockhash() вернёт ноль (EVM хранит
    // хеши только 256 последних блоков).
    function commitHash() external {
        require(state == Lotterystate.FULL, "Round not full");
        require(!hashCommitted, "Already committed");
        require(block.number >= fillBlock + COMMIT_DELAY, "Too early: commit delay");
        require(block.number <= fillBlock + COMMIT_WINDOW, "Too late: hash window missed");
        bytes32 h = blockhash(fillBlock);
        require(h != bytes32(0), "Hash unavailable");
        committedHash = h;
        hashCommitted = true;
        emit HashCommitted(roundId, fillBlock, h);
    }

    // ── Розыгрыш (permissionless, только для полного раунда) ─────────
    function triggerDraw() external {
        require(state == Lotterystate.FULL, "Round not full yet");
        require(hashCommitted, "Hash not committed yet");
        _executeDraw();
    }

    function _executeDraw() internal {
        state = Lotterystate.CALCULATING;
        emit DrawStarted(roundId, tickets.length, usdt.balanceOf(address(this)), "full");
        _selectWinner();
    }

    function _selectWinner() internal {
        uint256 totalTickets = tickets.length;
        uint256 roundBalance = totalTickets * ticketPrice;
        uint256 creatorFee = (roundBalance * CREATOR_FEE) / PRECISION;
        uint256 prize = roundBalance - creatorFee;

        accumulatedFees += creatorFee;

        // Сид V2: захваченный хеш блока заполнения. Все билеты оплачены
        // ДО существования этого хеша, а после его фиксации исход
        // детерминирован — повторные попытки дают тот же результат.
        uint256 seed = uint256(keccak256(abi.encodePacked(committedHash, roundId, totalTickets)));
        uint256 winIndex = seed % totalTickets;
        address winner = tickets[winIndex];

        pendingPrizes[winner] += prize;
        totalPendingPrizes += prize;
        lastWinner = winner;

        for (uint256 i = 0; i < totalTickets; i++) {
            if (ticketsPerPlayer[tickets[i]] > 0) {
                ticketsPerPlayer[tickets[i]] = 0;
            }
        }
        uniquePlayersCount = 0;

        uint256 completedRound = roundId;
        delete tickets;
        emit WinnerDeclared(completedRound, winner, prize, creatorFee);

        roundResults[completedRound] = RoundResult({
            winner: winner,
            prize: prize,
            creatorFee: creatorFee,
            refunded: false,
            hasResult: true
        });

        state = Lotterystate.CLOSED;
    }
    // ── Выплата приза ────────────────────────────────────────────────
    function claimPrize() external {
        require(pendingPrizes[msg.sender] > 0, "No prize");
        _payAllPrizesAndFees();
    }

    function _payAllPrizesAndFees() internal {
        require(state == Lotterystate.CLOSED, "Round not closed");

        address winner = lastWinner;
        uint256 prize = pendingPrizes[winner];
        if (prize > 0) {
            pendingPrizes[winner] = 0;
            totalPendingPrizes -= prize;
            usdt.safeTransfer(winner, prize);
            emit PrizeClaimed(winner, prize);
        }

        _autoWithdrawFeesIfPossible();
    }

    // Принудительная выплата создателем (например, победитель — контракт
    // без функции получения, или просто не приходит за призом).
    function forceClaimPrize(address winner) external {
        require(msg.sender == creator, "Only creator");
        uint256 amount = pendingPrizes[winner];
        require(amount > 0, "No prize");
        pendingPrizes[winner] = 0;
        totalPendingPrizes -= amount;
        usdt.safeTransfer(winner, amount);
        emit PrizeForceClaimed(winner, amount, msg.sender);
        _autoWithdrawFeesIfPossible();
    }

    function batchForceClaim(address[] calldata winners) external {
        require(msg.sender == creator, "Only creator");
        uint256 totalAmount = 0;
        uint256[] memory amounts = new uint256[](winners.length);

        for (uint256 i = 0; i < winners.length; i++) {
            uint256 amount = pendingPrizes[winners[i]];
            require(amount > 0, "No prize for a winner");
            pendingPrizes[winners[i]] = 0;
            amounts[i] = amount;
            totalAmount += amount;
        }

        totalPendingPrizes -= totalAmount;

        for (uint256 i = 0; i < winners.length; i++) {
            usdt.safeTransfer(winners[i], amounts[i]);
        }

        emit BatchPrizeForceClaimed(winners, amounts, msg.sender);
        _autoWithdrawFeesIfPossible();
    }

    // Последний claim призов → вывод комиссий создателю → новый раунд.
    function _autoWithdrawFeesIfPossible() internal {
        if (totalPendingPrizes == 0 && state == Lotterystate.CLOSED && accumulatedFees > 0) {
            uint256 fees = accumulatedFees;
            accumulatedFees = 0;
            usdt.safeTransfer(creator, fees);
            emit CreatorFeeWithdrawn(fees);

            _openNewRound();
        }
    }

    function withdrawFees() external {
        require(msg.sender == creator, "Only creator");
        uint256 amount = accumulatedFees;
        require(amount > 0, "No fees to withdraw");
        require(usdt.balanceOf(address(this)) >= amount, "Insufficient balance for fees");

        accumulatedFees = 0;
        usdt.safeTransfer(creator, amount);
        emit CreatorFeeWithdrawn(amount);

        if (totalPendingPrizes == 0 && state == Lotterystate.CLOSED) {
            _openNewRound();
        }
    }

    // Сброс таймлайна и открытие следующего раунда (после выплаты или
    // рефанда): пустой раунд снова «не тикает» до первого билета.
    function _openNewRound() internal {
        roundId++;
        totalRoundsCompleted++;
        firstTicketAt = 0;
        roundDeadline = 0;
        fillBlock = 0;
        hashCommitted = false;
        committedHash = bytes32(0);
        state = Lotterystate.OPEN;
        emit RoundOpened(roundId, 0);
    }
    // ── Возврат (permissionless) ─────────────────────────────────────
    // Два сценария:
    //   A) OPEN: окно сбора истекло, полный состав не собрался → каждому
    //      100% билетов, раунд закрывается как refunded;
    //   B) FULL: состав собрался, но розыгрыш не состоялся за fullGrace
    //      (мёртвый keeper и никто не дёрнул) → всем возврат.
    function refundAll() external {
        if (state == Lotterystate.OPEN) {
            require(roundDeadline > 0 && block.timestamp > roundDeadline, "Round still collecting");
            require(tickets.length > 0, "Nothing to refund");
        } else if (state == Lotterystate.FULL) {
            require(block.timestamp > roundDeadline + fullGrace, "Draw still possible");
        } else {
            revert("Round in progress");
        }

        uint256 refundedPlayers = 0;
        uint256 totalRefunded = 0;
        for (uint256 i = 0; i < tickets.length; i++) {
            address payable player = tickets[i];
            uint256 playerTickets = ticketsPerPlayer[player];
            if (playerTickets > 0) {
                uint256 refund = playerTickets * ticketPrice;
                ticketsPerPlayer[player] = 0;
                usdt.safeTransfer(player, refund);
                refundedPlayers++;
                totalRefunded += refund;
            }
        }

        roundResults[roundId].refunded = true;
        roundResults[roundId].hasResult = true;

        uniquePlayersCount = 0;
        delete tickets;
        emit RoundRefunded(roundId, refundedPlayers, totalRefunded);
        _openNewRound();
    }

    // ── Параметры (создатель; только когда контракт полностью «спокоен») ──
    function updateParams(
        uint256 _ticketPrice,
        uint256 _maxTicketsTotal,
        uint256 _maxTicketsPerPlayer,
        uint256 _maxPlayers,
        uint256 _roundDuration,
        uint256 _fullGrace
    ) external {
        require(msg.sender == creator, "Only creator");
        require(state == Lotterystate.OPEN, "Round in progress");
        require(tickets.length == 0, "Tickets exist");
        require(totalPendingPrizes == 0, "Previous round prizes not claimed");
        require(usdt.balanceOf(address(this)) == 0, "Withdraw fees first");
        require(_ticketPrice > 0, "Ticket price > 0");
        require(_maxTicketsTotal >= 2, "Max tickets >= 2");
        require(_maxTicketsPerPlayer > 0, "Max per player > 0");
        require(_maxPlayers >= 2, "Max players >= 2");
        require(_roundDuration >= 5 minutes, "Round duration too short");
        require(_fullGrace >= 10 minutes, "Full grace too short");

        ticketPrice = _ticketPrice;
        maxTicketsTotal = _maxTicketsTotal;
        maxTicketsPerPlayer = _maxTicketsPerPlayer;
        maxPlayers = _maxPlayers;
        roundDuration = _roundDuration;
        fullGrace = _fullGrace;
        emit ParamsUpdated(_ticketPrice, _maxTicketsTotal, _maxTicketsPerPlayer, _maxPlayers, _roundDuration, _fullGrace);
    }

    // ── View-функции (совместимы с V1 + новые для keeper/UI) ─────────
    function getTotalTickets() external view returns (uint256) { return tickets.length; }
    function getMyTickets(address player) external view returns (uint256) { return ticketsPerPlayer[player]; }
    function getPrizePool() external view returns (uint256) { return usdt.balanceOf(address(this)); }

    // Для keeper'а и фронтенда: что можно делать прямо сейчас.
    function canCommit() public view returns (bool) {
        return state == Lotterystate.FULL && !hashCommitted
            && block.number >= fillBlock + COMMIT_DELAY
            && block.number <= fillBlock + COMMIT_WINDOW;
    }
    function canDraw() public view returns (bool) {
        return state == Lotterystate.FULL && hashCommitted;
    }
    function canRefund() public view returns (bool) {
        if (state == Lotterystate.OPEN) {
            return roundDeadline > 0 && block.timestamp > roundDeadline && tickets.length > 0;
        }
        if (state == Lotterystate.FULL) {
            return block.timestamp > roundDeadline + fullGrace;
        }
        return false;
    }

    function getRoundStatus() external view returns (
        uint8 st,
        uint256 uniquePlayers,
        uint256 totalTickets,
        uint256 deadline,
        uint256 fBlock,
        bool hashOk,
        bytes32 hash
    ) {
        return (uint8(state), uniquePlayersCount, tickets.length, roundDeadline, fillBlock, hashCommitted, committedHash);
    }

    // Результат раунда — хранится в контракте, доступен с любого устройства
    // (та же структура, что в V1: победитель/приз/комиссия/refunded/hasResult).
    function getRoundResult(uint256 _roundId) external view returns (
        address winner,
        uint256 prize,
        uint256 creatorFee,
        bool refunded,
        bool hasResult
    ) {
        RoundResult storage r = roundResults[_roundId];
        return (r.winner, r.prize, r.creatorFee, r.refunded, r.hasResult);
    }

    function _getTokenDecimals(address token) internal view returns (uint256) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (success && data.length >= 32) return abi.decode(data, (uint256));
        return 18;
    }

    receive() external payable { revert("ETH not accepted"); }
    fallback() external payable { revert("ETH not accepted"); }
}
