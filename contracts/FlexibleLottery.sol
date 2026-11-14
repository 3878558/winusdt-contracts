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
// Игра №1: 10 участников, 1 билет на игрока, 1 победитель.
// Победитель получает 95% пула, создатель — 5% комиссии.
// Покупка билета и сам розыгрыш — ДВЕ РАЗНЫЕ транзакции. Как только куплен
// последний билет, раунд переходит в состояние FULL (все билеты видны на
// доске зрителям минимум один блок), и любой адрес может permissionless
// вызвать triggerDraw(), который запускает розыгрыш.
// ─────────────────────────────────────────────────────────────────────────
contract FlexibleLottery {
    using SafeERC20 for IERC20;

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
    uint256 public nextDrawTimestamp;

    uint256 public constant MIN_PLAYERS = 2;
    uint256 public uniquePlayersCount;
    uint256 public constant WINNER_COUNT = 1;
    uint256 public constant CREATOR_FEE = 5;
    uint256 public constant WINNER_SHARE = 95;
    uint256 public constant PRECISION = 100;

    address public immutable creator;
    uint256 public totalPendingPrizes;
    uint256 public accumulatedFees;

    mapping(address => uint256) public pendingPrizes;
    address public lastWinner;

    // ── История результатов раундов ──────────────────
    // Хранится прямо в контракте, поэтому доступна одинаково с ЛЮБОГО
    // устройства через простой view-вызов getRoundResult(roundId) —
    // не зависит от eth_getLogs (который может быть недоступен на
    // некоторых публичных RPC-нодах) и не зависит от localStorage браузера.
    struct RoundResult {
        address winner;
        uint256 prize;
        uint256 creatorFee;
        bool refunded;   // true, если раунд закрылся через emergencyRefundAll (без победителя)
        bool hasResult;  // true, если для этого roundId уже есть запись
    }
    mapping(uint256 => RoundResult) private roundResults;

    // ── Waitlist ──────────────────────────────────────
    struct WaitlistEntry {
        address player;
        uint256 quantity;
        uint256 deposit;
    }
    WaitlistEntry[] public waitlist;
    mapping(address => bool) public inWaitlist;
    mapping(address => uint256) public waitlistIndex;

    event TicketsPurchased(uint256 indexed roundId, address indexed player, uint256 quantity, uint256 totalCost, uint256 playerTotalTickets);
    event RoundFull(uint256 indexed roundId, uint256 totalTickets, uint256 prizePool);
    event DrawStarted(uint256 indexed roundId, uint256 totalTickets, uint256 prizePool, string reason);
    event WinnerDeclared(uint256 indexed roundId, address winner, uint256 prize, uint256 creatorFee);
    event RoundOpened(uint256 indexed roundId, uint256 nextDrawTime);
    event CreatorFeeWithdrawn(uint256 amount);
    event PrizeClaimed(address indexed winner, uint256 amount);
    event PrizeForceClaimed(address indexed winner, uint256 amount, address indexed by);
    event BatchPrizeForceClaimed(address[] winners, uint256[] amounts, address indexed by);
    event ParamsUpdated(uint256 ticketPrice, uint256 maxTicketsTotal, uint256 maxTicketsPerPlayer, uint256 maxPlayers);
    event WaitlistJoined(address indexed player, uint256 quantity, uint256 position);
    event WaitlistLeft(address indexed player, uint256 refund);
    event WaitlistProcessed(address indexed player, uint256 quantity, uint256 roundId);

    constructor(
        address _usdtAddress,
        uint256 _ticketPrice,
        uint256 _maxTicketsTotal,
        uint256 _maxTicketsPerPlayer,
        uint256 _maxPlayers
    ) {
        require(_ticketPrice > 0, "Ticket price > 0");
        require(_maxTicketsTotal >= MIN_PLAYERS, "Max tickets >= 2");
        require(_maxTicketsPerPlayer > 0, "Max per player > 0");
        require(_maxPlayers >= MIN_PLAYERS, "Max players >= 2");
        require(WINNER_COUNT * WINNER_SHARE + CREATOR_FEE == PRECISION, "Invalid percentages");

        usdt = IERC20(_usdtAddress);
        ticketPrice = _ticketPrice;
        maxTicketsTotal = _maxTicketsTotal;
        maxTicketsPerPlayer = _maxTicketsPerPlayer;
        maxPlayers = _maxPlayers;
        creator = msg.sender;
        tokenDecimals = _getTokenDecimals(_usdtAddress);
        nextDrawTimestamp = block.timestamp;
        emit RoundOpened(roundId, nextDrawTimestamp);
    }

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

        require(!inWaitlist[msg.sender], "Already in waitlist");

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

        // ── Раунд заполнен ──
        // Как только набрано нужное количество уникальных игроков (все места
        // заняты), раунд переходит в состояние FULL — все билеты остаются
        // видимыми на доске минимум один блок. Сам розыгрыш запускается
        // отдельной транзакцией triggerDraw() (permissionless), чтобы у
        // зрителей была гарантированная возможность увидеть полностью
        // заполненную доску до объявления победителя.
        if (uniquePlayersCount >= maxPlayers) {
            state = Lotterystate.FULL;
            emit RoundFull(roundId, tickets.length, usdt.balanceOf(address(this)));
        }
    }

    // Permissionless: запускает розыгрыш, когда раунд уже заполнен.
    // Может быть вызвана кем угодно — как правило, покупателем последнего
    // билета сразу второй транзакцией, либо любым другим адресом как fallback.
    function triggerDraw() external {
        require(state == Lotterystate.FULL, "Round not full yet");
        _executeDraw("auto");
    }

    // ── Waitlist ──────────────────────────────────────
    function joinWaitlist(uint256 quantity) external {
        require(state == Lotterystate.FULL || state == Lotterystate.CLOSED, "Waitlist only when round full or closed");

        require(!inWaitlist[msg.sender], "Already in waitlist");
        require(ticketsPerPlayer[msg.sender] == 0, "Already in current round");
        require(quantity > 0 && quantity <= maxTicketsPerPlayer, "Invalid quantity");

        uint256 deposit = ticketPrice * quantity;
        usdt.safeTransferFrom(msg.sender, address(this), deposit);

        waitlistIndex[msg.sender] = waitlist.length;
        waitlist.push(WaitlistEntry({
            player: msg.sender,
            quantity: quantity,
            deposit: deposit
        }));
        inWaitlist[msg.sender] = true;

        emit WaitlistJoined(msg.sender, quantity, waitlist.length);
    }

    function leaveWaitlist() external {
        require(inWaitlist[msg.sender], "Not in waitlist");

        uint256 idx = waitlistIndex[msg.sender];
        uint256 refund = waitlist[idx].deposit;

        uint256 lastIdx = waitlist.length - 1;
        if (idx != lastIdx) {
            waitlist[idx] = waitlist[lastIdx];
            waitlistIndex[waitlist[idx].player] = idx;
        }
        waitlist.pop();
        delete waitlistIndex[msg.sender];
        inWaitlist[msg.sender] = false;

        usdt.safeTransfer(msg.sender, refund);
        emit WaitlistLeft(msg.sender, refund);
    }

    function getWaitlistLength() external view returns (uint256) {
        return waitlist.length;
    }

    function getWaitlistEntry(uint256 index) external view returns (address player, uint256 quantity, uint256 position) {
        require(index < waitlist.length, "Index out of bounds");
        WaitlistEntry memory entry = waitlist[index];
        return (entry.player, entry.quantity, index + 1);
    }

    function getMyWaitlistPosition() external view returns (uint256) {
        if (!inWaitlist[msg.sender]) return 0;
        return waitlistIndex[msg.sender] + 1;
    }

    function _processWaitlist() internal {
        if (waitlist.length == 0) return;

        uint256 processed = 0;
        uint256 i = 0;

        while (i < waitlist.length && uniquePlayersCount < maxPlayers) {
            WaitlistEntry memory entry = waitlist[i];
            // Проверяем, что игрок ещё не имеет билетов в текущем раунде
            if (ticketsPerPlayer[entry.player] == 0 && uniquePlayersCount < maxPlayers) {
                uint256 ticketSpots = maxTicketsTotal - tickets.length;
                uint256 qty = entry.quantity <= ticketSpots ? entry.quantity : ticketSpots;
                if (qty == 0) break;

                if (qty < entry.quantity) {
                    uint256 refund = (entry.quantity - qty) * ticketPrice;
                    usdt.safeTransfer(entry.player, refund);
                }

                for (uint256 j = 0; j < qty; j++) {
                    tickets.push(payable(entry.player));
                }
                ticketsPerPlayer[entry.player] += qty;
                uniquePlayersCount++;

                inWaitlist[entry.player] = false;
                delete waitlistIndex[entry.player];

                emit WaitlistProcessed(entry.player, qty, roundId);
                emit TicketsPurchased(roundId, entry.player, qty, qty * ticketPrice, ticketsPerPlayer[entry.player]);

                processed++;
                i++;
            } else {
                // Игрок уже имеет билеты или достигнут лимит – возвращаем депозит и удаляем
                usdt.safeTransfer(entry.player, entry.deposit);
                inWaitlist[entry.player] = false;
                delete waitlistIndex[entry.player];
                processed++;
                i++;
            }
        }

        if (processed > 0) {
            for (uint256 k = 0; k < waitlist.length - processed; k++) {
                waitlist[k] = waitlist[k + processed];
                waitlistIndex[waitlist[k].player] = k;
            }
            for (uint256 k = 0; k < processed; k++) {
                waitlist.pop();
            }
        }

        // Если после обработки очереди набралось достаточно игроков —
        // раунд переходит в FULL, и розыгрыш запускается отдельной
        // транзакцией triggerDraw(), как и при обычной покупке билетов.
        if (state == Lotterystate.OPEN && uniquePlayersCount >= maxPlayers) {
            state = Lotterystate.FULL;
            emit RoundFull(roundId, tickets.length, usdt.balanceOf(address(this)));
        }
    }

    function canDraw() public view returns (bool) {
        if (state != Lotterystate.OPEN) return false;
        if (uniquePlayersCount < MIN_PLAYERS) return false;
        return true;
    }

    function startDraw() external {
        require(canDraw(), "Cannot draw yet");
        _executeDraw("public");
    }

    function creatorStartDraw() external {
        require(msg.sender == creator, "Only creator");
        require(state == Lotterystate.OPEN, "Round not open");
        require(uniquePlayersCount >= MIN_PLAYERS, "Need 2+ unique players");
        require(usdt.balanceOf(address(this)) > 0, "No funds to draw");
        _executeDraw("creator");
    }

    function _executeDraw(string memory reason) internal {
        state = Lotterystate.CALCULATING;
        emit DrawStarted(roundId, tickets.length, usdt.balanceOf(address(this)), reason);
        _selectWinner();
    }

    function _selectWinner() internal {
        uint256 totalTickets = tickets.length;
        uint256 roundBalance = totalTickets * ticketPrice;
        uint256 creatorFee = (roundBalance * CREATOR_FEE) / PRECISION;
        uint256 prize = roundBalance - creatorFee;

        accumulatedFees += creatorFee;

        uint256 seed = uint256(keccak256(abi.encodePacked(block.timestamp, block.prevrandao, tickets.length, roundId, msg.sender)));
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

        // Сохраняем результат раунда в постоянное хранилище контракта —
        // доступно одинаково с любого устройства через getRoundResult().
        roundResults[completedRound] = RoundResult({
            winner: winner,
            prize: prize,
            creatorFee: creatorFee,
            refunded: false,
            hasResult: true
        });

        state = Lotterystate.CLOSED;
    }

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

    function _autoWithdrawFeesIfPossible() internal {
        if (totalPendingPrizes == 0 && state == Lotterystate.CLOSED && accumulatedFees > 0) {
            uint256 fees = accumulatedFees;
            accumulatedFees = 0;
            usdt.safeTransfer(creator, fees);
            emit CreatorFeeWithdrawn(fees);

            roundId++;
            totalRoundsCompleted++;
            nextDrawTimestamp = block.timestamp;
            state = Lotterystate.OPEN;
            emit RoundOpened(roundId, nextDrawTimestamp);

            _processWaitlist();
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
            roundId++;
            totalRoundsCompleted++;
            nextDrawTimestamp = block.timestamp;
            state = Lotterystate.OPEN;
            emit RoundOpened(roundId, nextDrawTimestamp);
            _processWaitlist();
        }
    }

    function refundMyTickets() external {
        require(state == Lotterystate.OPEN, "Round in progress");
        require(totalPendingPrizes == 0, "Previous round prizes not claimed");
        uint256 count = ticketsPerPlayer[msg.sender];
        require(count > 0, "No tickets");
        if (count == ticketsPerPlayer[msg.sender]) {
            uniquePlayersCount--;
        }
        uint256 refund = count * ticketPrice;
        ticketsPerPlayer[msg.sender] = 0;

        for (int256 i = int256(tickets.length) - 1; i >= 0; i--) {
            if (tickets[uint256(i)] == msg.sender) {
                tickets[uint256(i)] = tickets[tickets.length - 1];
                tickets.pop();
                count--;
                if (count == 0) break;
            }
        }
        usdt.safeTransfer(msg.sender, refund);
    }

    function emergencyRefundAll() external {
        require(msg.sender == creator, "Only creator");
        require(state == Lotterystate.OPEN, "Round in progress");
        require(uniquePlayersCount < MIN_PLAYERS, "Can draw normally");
        require(totalPendingPrizes == 0, "Unclaimed prizes exist");

        uint256 total = tickets.length;
        for (uint256 i = 0; i < total; i++) {
            address payable player = tickets[i];
            uint256 playerTickets = ticketsPerPlayer[player];
            if (playerTickets > 0) {
                uint256 refund = playerTickets * ticketPrice;
                ticketsPerPlayer[player] = 0;
                usdt.safeTransfer(player, refund);
            }
        }

        for (uint256 i = 0; i < waitlist.length; i++) {
            usdt.safeTransfer(waitlist[i].player, waitlist[i].deposit);
            inWaitlist[waitlist[i].player] = false;
            delete waitlistIndex[waitlist[i].player];
        }
        delete waitlist;

        // Помечаем закрывающийся раунд как "без победителя" (refund),
        // чтобы фронтенд мог корректно определить исход по getRoundResult().
        roundResults[roundId].refunded = true;
        roundResults[roundId].hasResult = true;

        uniquePlayersCount = 0;
        delete tickets;
        totalRoundsCompleted++;
        roundId++;
        nextDrawTimestamp = block.timestamp;
        state = Lotterystate.OPEN;
        emit RoundOpened(roundId, nextDrawTimestamp);
    }

    function updateParams(
        uint256 _ticketPrice,
        uint256 _maxTicketsTotal,
        uint256 _maxTicketsPerPlayer,
        uint256 _maxPlayers
    ) external {
        require(msg.sender == creator, "Only creator");
        require(state == Lotterystate.OPEN, "Round in progress");
        require(totalPendingPrizes == 0, "Previous round prizes not claimed");
        require(usdt.balanceOf(address(this)) == 0, "Withdraw fees first");
        require(_ticketPrice > 0, "Ticket price > 0");
        require(_maxTicketsTotal >= MIN_PLAYERS, "Max tickets >= 2");
        require(_maxTicketsPerPlayer > 0, "Max per player > 0");
        require(_maxPlayers >= MIN_PLAYERS, "Max players >= 2");
        ticketPrice = _ticketPrice;
        maxTicketsTotal = _maxTicketsTotal;
        maxTicketsPerPlayer = _maxTicketsPerPlayer;
        maxPlayers = _maxPlayers;
        emit ParamsUpdated(_ticketPrice, _maxTicketsTotal, _maxTicketsPerPlayer, _maxPlayers);
    }

    function _getTokenDecimals(address token) internal view returns (uint256) {
        (bool success, bytes memory data) = token.staticcall(abi.encodeWithSignature("decimals()"));
        if (success && data.length >= 32) return abi.decode(data, (uint256));
        return 18;
    }

    function getTotalTickets() external view returns (uint256) { return tickets.length; }
    function getMyTickets(address player) external view returns (uint256) { return ticketsPerPlayer[player]; }
    function getPrizePool() external view returns (uint256) { return usdt.balanceOf(address(this)); }
    function getNextDrawTime() external view returns (uint256) { return nextDrawTimestamp; }

    // Возвращает сохранённый результат раунда (победитель, приз, комиссия,
    // был ли этот раунд возвращён через emergencyRefundAll, существует ли
    // вообще запись для этого roundId). Простой view-вызов — работает
    // одинаково на ЛЮБОМ устройстве без зависимости от логов блокчейна.
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

    receive() external payable { revert("ETH not accepted"); }
    fallback() external payable { revert("ETH not accepted"); }
}
