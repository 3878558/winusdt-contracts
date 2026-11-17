// SPDX-License-Identifier: MIT
pragma solidity ^0.8.19;

interface IERC20 {
    function balanceOf(address account) external view returns (uint256);
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
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
// WinUSDT — Slots PvC (Player vs Casino). Дизайн: docs/slots-design.md.
//
// МОДЕЛЬ: игрок крутит против LP-банкролла контракта. RTP = 94.98%
// (paytable §2.3, коэффициенты заморожены Monte-Carlo фазой 2 —
// docs/slots-math.md). Комиссия 5% ВИРТУАЛЬНА: она встроена в paytable
// и переносится в LP-пул только статистикой, отдельной транзакцией — нет.
//
// ЧЕСТНЫЙ RNG (урок пост-мортема V1, применён в лотерее V2):
//   seed = keccak256(abi.encode(blockhash(betBlock+1), player, bet))
// В момент tx ставки blockhash(betBlock+1) НЕ СУЩЕСТВУЕТ — исход нельзя
// предсказать ни боту, ни валидатору. Средства в escrow до resolve:
// атомарный «проверил и отменил» (оружие снайперов V1) невозможен.
// resolve() permissionless и детерминирован. Спин, чей blockhash decayed
// (>256 блоков), автоматически REFUND-ится — застревание исключено,
// revert-майнинг ничего не даёт.
//
// ── ВЛАДЕЛЕЦ (creator) МОЖЕТ: ──────────────────────────────────────────
//   • pause()/unpause() — останавливает ТОЛЬКО новые ставки; активные
//     спины/серии всегда разрешаются или refund-ятся кем угодно;
//   • scheduleParamChange/applyParamChange (тимлок 24ч): minBet,
//     maxBetCap, creatorFeeShare (≤5000 bps жёстко в коде);
//   • deposit()/withdraw() в LP-пул на общих правилах (доли, guard
//     покрытия активных спинов — исключений для владельца нет);
//   • claimCreatorFees() — только начисленные ему feeShare.
// ── ВЛАДЕЛЕЦ НЕ МОЖЕТ (provably fair): ─────────────────────────────────
//   • трогать escrow/призовые/выплаты игроков;
//   • выводить principal LP иначе как через свои доли по общим правилам;
//   • изменить paytable, веса, формулу сида (immutable константы);
//   • отменить/переиграть любой спин, повлиять на исход;
//   • банить адреса, менять владельца (creator immutable);
//   • вывести баланс контракта (функции не существует).
// ─────────────────────────────────────────────────────────────────────────
contract Slots {
    using SafeERC20 for IERC20;

    // ═══ Immutable игровая математика (владелец не меняет — provably fair) ═══

    uint256 public constant W = 72; // суммарный вес барабана (§2.2)
    // Кумулятивные пороги символов: r<20 → 🍒, <36 → 🍋, <49 → 🍇,
    // <59 → 🔔, <66 → ⭐, <70 → 💎, ≤71 → 7️⃣ (веса 20/16/13/10/7/4/2).
    // Выплаты в бипах ставки. §2.3: тройки 7️⃣×100, 💎×40, ⭐×20, 🔔×12,
    // 🍇×8, 🍋×5, 🍒×3; «ровно 2» по символу: 🍒×1.6, 🍋×1.4, 🔔×1.2,
    // 🍇×1.0, ⭐×2.5, 💎×4, 7️⃣×25. Immutable (provably fair).

    function _tripleBps(uint8 s) internal pure returns (uint32) {
        // s ∈ 0..6
        if (s == 6) return 1000000; // 7️⃣ ×100
        if (s == 5) return 400000;  // 💎 ×40
        if (s == 4) return 200000;  // ⭐ ×20
        if (s == 3) return 120000;  // 🔔 ×12
        if (s == 2) return 80000;   // 🍇 ×8
        if (s == 1) return 50000;   // 🍋 ×5
        return 30000;               // 🍒 ×3
    }

    function _pairBps(uint8 s) internal pure returns (uint32) {
        if (s == 6) return 250000; // 7️⃣ ×25
        if (s == 5) return 40000;  // 💎 ×4
        if (s == 4) return 25000;  // ⭐ ×2.5
        if (s == 3) return 12000;  // 🔔 ×1.2
        if (s == 2) return 10000;  // 🍇 ×1.0
        if (s == 1) return 14000;  // 🍋 ×1.4
        return 16000;              // 🍒 ×1.6
    }

    // ═══ Эксклюзивный автомат + резервация (v3) ═══
    // Оффлайн-опыт v2 («один игрок = одна машина») расширен резервацией:
    // settle НЕ обнуляет activePlayer, а переводит машину в пост-settle
    // резервацию того же игрока на RESERVE_TTL секунд — сосед не перехватит
    // автомат между спинами (главная жалоба v2).
    //   • activePlayer == 0 — машина свободна;
    //   • sessions[activePlayer].active — in-flight сессия (escrow в игре):
    //     освобождается ТОЛЬКО settle'ом (resolve/resolveFor — permissionless,
    //     §3.2) либо decay-refund через ~256 блоков;
    //   • reservedUntil > now — живая резервация: чужие спины revert
    //     "machine busy", свои разрешены (re-spin без ограничений);
    //   • reservedUntil ≤ now — протухла: снимает permissionless
    //     releaseExpired() (кипер, ~1 poll) либо лениво первым желающим
    //     крутить (газ копеечный) — DoS-блокировки нет, занятость ≤ TTL.
    // Chained-play spin(bet, resolvePrev) атомарен: settle прошлой → сразу
    // новая сессия в одном tx; при новом спине резервация гасится (TTL=0).
    address public activePlayer;
    uint64 public reservedUntil; // v3: дедлайн резервации (0 у in-flight/свободной)

    /// TTL пост-settle резервации, сек (~200 блоков BSC). Immutable — владелец
    /// не подстраивает (provably fair).
    uint256 public constant RESERVE_TTL = 90;

    // ═══ Экономика/лимиты (§3.4 четыре слоя) ═══
    uint256 public constant EXPOSURE_FACTOR = 99;  // admission: худший джекпот ×100 минус escrow игрока
    uint256 public constant MAXBET_DIVISOR = 300;  // maxBet = freeBankroll/300 (маржа на 3 джекпота)
    uint256 public constant MAX_SERIES = 64;       // газ-стена §5 (blockhash-стена 255 шире)
    uint256 public constant FEE_SHARE_MAX = 5000;  // жёсткий потолок 50/50
    uint256 public constant TIMELOCK = 24 hours;   // §7 anti-scam

    // ═══ Константы контракта ═══
    IERC20 public immutable usdt;
    address public immutable creator;

    // ═══ Owner-параметры (меняются только через 24ч тимлок) ═══
    uint256 public minBet;          // bootstrap 0.5 USDT
    uint256 public maxBetCap;       // bootstrap 10 USDT (maxBet = fb/300, floor minBet)
    uint16  public creatorFeeShare; // bps реализованного edge, bootstrap 0

    bool public paused; // паузит только НОВЫЕ ставки (§3.5)

    // ═══ Активная сессия игрока: ровно одна — solo (n=1) или серия (n=N) ═══
    struct Session {
        uint128 bet;      // ставка одного спина
        uint32  betBlock; // блок ставки (tx 1)
        uint16  n;        // 1 = solo, 2..64 = серия
        bool    active;
    }
    mapping(address => Session) public sessions;

    // ═══ Банкролл/бухгалтерия ═══
    uint256 public totalEscrow;   // Σ ставок активных сессий (в контракте)
    uint256 public totalExposure; // Σ 99×bet активных сессий (worst-case резерв)
    uint256 public totalShares;   // LP-доли
    mapping(address => uint256) public lpShares;
    mapping(address => uint256) public creatorFees; // начислено, не забрано
    uint256 public creatorFeesTotal;                // Σ незабранных (исключается из fb/equity)
    uint256 public totalSpins;

    // Тимлок: kind 1=minBet, 2=maxBetCap, 3=creatorFeeShare
    mapping(uint8 => uint256) public pendingValue;
    mapping(uint8 => uint64) public pendingEffectiveAt;

    // ═══ События (§3.8: полное разложение исхода — пруф не «сгниёт») ═══
    event SpinStarted(address indexed player, uint256 indexed betBlock, uint256 bet, uint256 n);
    event SpinResolved(
        address indexed player,
        uint256 indexed betBlock,
        uint256 bet,
        bytes32 blockHash,   // источник сида (0 = decayed → refund)
        uint256 seed,        // полный сид (0 при refund)
        uint8[3] symbols,    // индексы символов 0..6 по барабанам
        uint256 payout       // выплата игроку (0 при refund — escrow вернулся)
    );
    event SeriesSettled(address indexed player, uint256 indexed betBlock, uint256 n, uint256 totalPayout, uint256 totalRefunded);
    // v3: settle оставляет машину за игроком (резервация с TTL); release снимает протухшую
    event MachineReserved(address indexed player, uint64 until);
    event MachineReleased(address indexed prevHolder);
    event LpDeposited(address indexed lp, uint256 amount, uint256 shares);
    event LpWithdrawn(address indexed lp, uint256 shares, uint256 value);
    event ParamScheduled(uint8 indexed kind, uint256 oldValue, uint256 newValue, uint64 effectiveAt);
    event ParamApplied(uint8 indexed kind, uint256 oldValue, uint256 newValue);
    event CreatorFeesClaimed(address indexed who, uint256 amount, address indexed by);
    event Paused(bool paused);

    constructor(address _usdt, uint256 _minBet, uint256 _maxBetCap, uint16 _feeShareBps) {
        require(_usdt != address(0), "usdt");
        require(_minBet > 0, "minBet>0");
        require(_maxBetCap >= _minBet, "cap>=minBet");
        require(_feeShareBps <= FEE_SHARE_MAX, "feeShare<=5000");
        usdt = IERC20(_usdt);
        creator = msg.sender;
        minBet = _minBet;
        maxBetCap = _maxBetCap;
        creatorFeeShare = _feeShareBps;
    }

    // ═══ Views ═══

    // Свободный банкролл (§3.4 слой 2): покрывает ХУДШИЕ исходы активных
    // сессий; исключает escrow, exposure-резерв и начисленные fee.
    function freeBankroll() public view returns (uint256) {
        return usdt.balanceOf(address(this)) - totalEscrow - totalExposure - creatorFeesTotal;
    }

    // Слой 3: динамический maxBet, floor на minBet (§7.5: при fb<150
    // принимается только минимальная ставка).
    function maxBetNow() public view returns (uint256) {
        uint256 dyn = freeBankroll() / MAXBET_DIVISOR;
        if (dyn < minBet) return minBet;
        if (dyn > maxBetCap) return maxBetCap;
        return dyn;
    }

    // Стоимость LP-пула (§3.3): balance − escrow − fees. Exposure НЕ
    // вычитается — это виртуальный резерв оборота, а не изъятие стоимости:
    // иначе активный спин ронял бы цену доли на ~33% (вектор экстракции).
    function equity() public view returns (uint256) {
        return usdt.balanceOf(address(this)) - totalEscrow - creatorFeesTotal;
    }

    function lpValue(address lp) public view returns (uint256) {
        if (totalShares == 0) return 0;
        return lpShares[lp] * equity() / totalShares;
    }

    function activeSession(address player)
        public view returns (uint256 bet, uint256 betBlock, uint256 n, bool active)
    {
        Session storage s = sessions[player];
        return (s.bet, s.betBlock, s.n, s.active);
    }

    // ═══ Чистая функция исхода (public — для Verify-кнопки и тестов) ═══

    function _symbolOf(uint256 r) internal pure returns (uint8) {
        if (r < 20) return 0; // 🍒
        if (r < 36) return 1; // 🍋
        if (r < 49) return 2; // 🍇
        if (r < 59) return 3; // 🔔
        if (r < 66) return 4; // ⭐
        if (r < 70) return 5; // 💎
        return 6;             // 7️⃣
    }

    /// seed → (выплата в wei ставки, символы барабанов). RTP = Σ p×m = 94.98%.
    function evaluate(uint256 seed, uint256 bet)
        public pure returns (uint256 payout, uint8[3] memory syms)
    {
        uint256 r1 = seed % W;
        uint256 r2 = (seed / W) % W;
        uint256 r3 = (seed / (W * W)) % W;
        syms[0] = _symbolOf(r1);
        syms[1] = _symbolOf(r2);
        syms[2] = _symbolOf(r3);

        // Тройка — джекпот-таблица
        if (syms[0] == syms[1] && syms[1] == syms[2]) {
            payout = bet * _tripleBps(syms[0]) / 10000;
            return (payout, syms);
        }
        // Ровно пара — парная таблица (позиция не важна, важен символ)
        uint8 pairSym;
        if (syms[0] == syms[1]) pairSym = syms[0];
        else if (syms[0] == syms[2]) pairSym = syms[0];
        else if (syms[1] == syms[2]) pairSym = syms[1];
        else return (0, syms); // все три разные
        payout = bet * _pairBps(pairSym) / 10000;
    }

    function _seed(bytes32 h, address player, uint256 bet) internal pure returns (uint256) {
        return uint256(keccak256(abi.encode(h, player, bet)));
    }

    // ═══ LP-пул ═══

    /// Депозит в банкролл. fee-on-transfer токены: кредитуется ФАКТИЧЕСКИЙ
    /// прирост баланса (явная поддержка). Первый LP — 1:1.
    function deposit(uint256 amount) external {
        require(amount > 0, "amount>0");
        uint256 before = usdt.balanceOf(address(this));
        uint256 eqBefore = equity();
        SafeERC20.safeTransferFrom(usdt, msg.sender, address(this), amount);
        uint256 received = usdt.balanceOf(address(this)) - before;

        uint256 shares;
        if (totalShares == 0) {
            shares = received; // 1:1 bootstrap
        } else {
            require(eqBefore > 0, "pool depleted"); // доли не выдаём в пустоту
            shares = received * totalShares / eqBefore;
        }
        require(shares > 0, "dust");
        totalShares += shares;
        lpShares[msg.sender] += shares;
        emit LpDeposited(msg.sender, received, shares);
    }

    /// Вывод доли. Guard слоя LP (§3.4): после вывода контракт обязан
    /// покрывать escrow + worst-case активных спинов + начисленные fee.
    function withdraw(uint256 shares) external {
        uint256 bal = lpShares[msg.sender];
        require(shares > 0 && shares <= bal, "shares");
        uint256 value = shares * equity() / totalShares;
        require(value > 0, "dust");
        totalShares -= shares;
        lpShares[msg.sender] = bal - shares;
        // checks-effects-interactions: guard по балансу ПОСЛЕ вывода
        require(
            usdt.balanceOf(address(this)) - value >= totalEscrow + totalExposure + creatorFeesTotal,
            "coverage guard"
        );
        SafeERC20.safeTransfer(usdt, msg.sender, value);
        emit LpWithdrawn(msg.sender, shares, value);
    }

    // ═══ Ставки ═══

    function _startSession(uint256 bet, uint256 n) internal {
        require(!paused, "paused");
        require(!sessions[msg.sender].active, "session active");
        // v3: занято = in-flight сессия ИЛИ живая резервация ДРУГОГО игрока.
        // Своя машина (сессия или резервация) — всегда можно. Протухшую чужую
        // резервацию снимаем лениво здесь (газ платит входящий игрок); ветка
        // reservedUntil == 0 при неактивной сессии недостижима, но оставлена
        // как аварийный клапан — машина не может застрять навсегда.
        if (activePlayer != address(0) && activePlayer != msg.sender) {
            if (!sessions[activePlayer].active && (reservedUntil == 0 || block.timestamp >= reservedUntil)) {
                emit MachineReleased(activePlayer);
                activePlayer = address(0);
                reservedUntil = 0;
            } else {
                revert("machine busy");
            }
        }
        require(n >= 1 && n <= MAX_SERIES, "series 1..64");
        require(bet >= minBet && bet <= maxBetNow(), "bet out of range");
        // Admission (слой 2): ХУДШИЙ исход всех активных + нового обязан
        // быть покрыт; fb уже исключает escrow/exposure существующих.
        require(freeBankroll() >= EXPOSURE_FACTOR * bet * n, "admission");

        uint256 escrow = bet * n;
        uint256 before = usdt.balanceOf(address(this));
        SafeERC20.safeTransferFrom(usdt, msg.sender, address(this), escrow);
        require(usdt.balanceOf(address(this)) - before == escrow, "fee-on-transfer unsupported");

        totalEscrow += escrow;
        totalExposure += EXPOSURE_FACTOR * escrow;
        sessions[msg.sender] = Session({
            bet: uint128(bet),
            betBlock: uint32(block.number),
            n: uint16(n),
            active: true
        });
        activePlayer = msg.sender; // v3: in-flight сессия — TTL не тикает
        reservedUntil = 0;
        emit SpinStarted(msg.sender, block.number, bet, n);
    }

    /// Solo-спин (tx 1 из 2).
    function spin(uint256 bet) external {
        _startSession(bet, 1);
    }

    /// Continuous play (§3.1 п.5): тот же tx закрывает предыдущий спин —
    /// 1 подпись на спин вместо двух.
    function spin(uint256 bet, bool resolvePrev) external {
        if (resolvePrev && sessions[msg.sender].active) _settleSingle(msg.sender);
        _startSession(bet, 1);
    }

    /// Turbo-серия (§5): N спинов, escrow N×bet сразу, admission
    /// happens-at-creation — серия гарантированно оплачена до конца
    /// при любом движении TVL. Сид каждого спина — свой блок
    /// betBlock+1 .. betBlock+n; ни один не существовал при подписи.
    function spinSeries(uint256 bet, uint256 n) external {
        _startSession(bet, n);
    }

    // ═══ Резолвы (permissionless; выплата всегда игроку) ═══

    function resolve() external {
        _settleSingle(msg.sender);
    }

    function resolveFor(address player) external {
        _settleSingle(player);
    }

    function _settleSingle(address player) internal {
        Session storage s = sessions[player];
        require(s.active && s.n == 1, "no solo session");
        // blockhash(betBlock+1) валиден только для блока СТРОГО позади
        // текущего: в блоке betBlock+1 он ещё 0 → резолвить рано нельзя.
        require(block.number > s.betBlock + 1, "wait betBlock+1");

        // CEI: освобождаем учёт ДО внешних вызовов. betBlock копируем —
        // после delete чтение из storage-указателя даст 0 (пруф-событие).
        uint256 bet = s.bet;
        uint32 bb = s.betBlock;
        totalEscrow -= bet;
        totalExposure -= EXPOSURE_FACTOR * bet;
        delete sessions[player];
        if (activePlayer == player) {
            // v3: машина остаётся за игроком — пост-settle резервация с TTL.
            // Сосед не перехватит автомат между спинами; после TTL машину
            // освобождают releaseExpired() (кипер) или lazy-захват.
            reservedUntil = uint64(block.timestamp) + uint64(RESERVE_TTL);
            emit MachineReserved(player, reservedUntil);
        }
        totalSpins += 1;

        bytes32 h = blockhash(bb + 1);
        if (h == bytes32(0)) {
            // Decay window (>256 блоков) → авто-refund ставки. Застревание
            // средств исключено; revert-майнинг исхода не меняет.
            SafeERC20.safeTransfer(usdt, player, bet);
            emit SpinResolved(player, bb, bet, bytes32(0), 0, [uint8(0), 0, 0], 0);
            return;
        }

        uint256 seed = _seed(h, player, bet);
        (uint256 payout, uint8[3] memory syms) = evaluate(seed, bet);
        if (payout > 0) SafeERC20.safeTransfer(usdt, player, payout);
        _accrueFee(bet, payout);
        emit SpinResolved(player, bb, bet, h, seed, syms, payout);
    }

    /// Серия: одиночный settle всех n спинов (v1 без чанков, §3.3). Хеш
    /// каждого спина либо жив (исход), либо decayed (refund этого спина) —
    /// частичное окно отдаёт исходы по добытым блокам.
    function resolveSeries() external {
        _settleSeries(msg.sender);
    }

    function resolveSeriesFor(address player) external {
        _settleSeries(player);
    }

    function _settleSeries(address player) internal {
        Session storage s = sessions[player];
        require(s.active && s.n > 1, "no series");
        require(block.number > s.betBlock + s.n, "wait series blocks");

        // CEI: учёт освобождаем до цикла внешних вызовов; betBlock копируем
        // (после delete чтение из указателя даст 0 в пруф-событиях).
        uint256 n = s.n;
        uint256 bet = s.bet;
        uint32 bb = s.betBlock;
        totalEscrow -= bet * n;
        totalExposure -= EXPOSURE_FACTOR * bet * n;
        delete sessions[player];
        if (activePlayer == player) {
            // v3: как в _settleSingle — резервация с TTL после серии
            reservedUntil = uint64(block.timestamp) + uint64(RESERVE_TTL);
            emit MachineReserved(player, reservedUntil);
        }
        totalSpins += n;

        uint256 totalPayout;
        uint256 totalRefunded;
        for (uint256 i = 1; i <= n; i++) {
            bytes32 h = blockhash(bb + i);
            if (h == bytes32(0)) {
                totalRefunded += bet;
                emit SpinResolved(player, bb, bet, bytes32(0), 0, [uint8(0), 0, 0], 0);
                continue;
            }
            uint256 seed = _seed(h, player, bet);
            (uint256 payout, uint8[3] memory syms) = evaluate(seed, bet);
            totalPayout += payout;
            _accrueFee(bet, payout);
            emit SpinResolved(player, bb, bet, h, seed, syms, payout);
        }
        // ОДИН внешний перевод на всю серию (газ-амортизация)
        if (totalPayout > 0) SafeERC20.safeTransfer(usdt, player, totalPayout);
        if (totalRefunded > 0) SafeERC20.safeTransfer(usdt, player, totalRefunded);
        emit SeriesSettled(player, bb, n, totalPayout, totalRefunded);
    }

    // ═══ Резервирование машины (v3, §3.9) ═══

    /// Permissionless-снятие ПРОТУХШЕЙ резервации (TTL вышел, сессий нет).
    /// In-flight сессию снять нельзя — её дожимают resolveFor/resolveSeriesFor
    /// (выплата всегда игроку). Кипер вызывает раз в poll после истечения TTL.
    function releaseExpired() external {
        require(activePlayer != address(0), "machine free");
        require(!sessions[activePlayer].active, "session active");
        // reservedUntil == 0 при неактивной сессии недостижим; ветка —
        // аварийный клапан против вечного зависания машины.
        require(reservedUntil == 0 || block.timestamp >= reservedUntil, "not expired");
        address prev = activePlayer;
        activePlayer = address(0);
        reservedUntil = 0;
        emit MachineReleased(prev);
    }

    /// Состояние машины одним вызовом (UI/кипер): holder — кто держит
    /// (0 = свободна), busy — крутить нельзя, until — дедлайн резервации
    /// (0 у in-flight/свободной). У протухшей busy=false — входящий спин
    /// снимет её лениво (газ платит входящий, releaseExpired не обязателен).
    function machineStatus()
        external view returns (address holder, bool busy, uint64 until)
    {
        holder = activePlayer;
        if (holder == address(0)) return (address(0), false, 0);
        if (sessions[holder].active) return (holder, true, 0);
        uint64 ru = reservedUntil;
        if (ru == 0 || block.timestamp >= ru) return (holder, false, 0);
        return (holder, true, ru);
    }

    /// feeShare делит ТОЛЬКО реализованный edge (нетто раунда, §4):
    /// положительный net = bet − payout; при выигрыше игрока (payout>bet)
    /// fee нет — убыток целиком в банкролл. Principal LP не трогается.
    function _accrueFee(uint256 bet, uint256 payout) internal {
        if (creatorFeeShare == 0 || payout >= bet) return;
        uint256 fee = (bet - payout) * creatorFeeShare / 10000;
        creatorFees[creator] += fee;
        creatorFeesTotal += fee;
    }

    /// Батчевый забор начислений (газ-амортизация, §4). Permissionless —
    /// средства уходят ТОЛЬКО законным получателям.
    function claimCreatorFees(address[] calldata who) external {
        for (uint256 i = 0; i < who.length; i++) {
            uint256 amt = creatorFees[who[i]];
            if (amt == 0) continue;
            creatorFees[who[i]] = 0;
            creatorFeesTotal -= amt;
            SafeERC20.safeTransfer(usdt, who[i], amt);
            emit CreatorFeesClaimed(who[i], amt, msg.sender);
        }
    }

    // ═══ Owner: пауза и тимлок параметров (§7 anti-scam) ═══

    modifier onlyCreator() {
        require(msg.sender == creator, "creator only");
        _;
    }

    function setPaused(bool p) external onlyCreator {
        paused = p;
        emit Paused(p);
    }

    function scheduleParamChange(uint8 kind, uint256 newValue) external onlyCreator {
        require(kind >= 1 && kind <= 3, "kind");
        if (kind == 1) require(newValue > 0, "minBet>0");
        if (kind == 2) require(newValue >= minBet, "cap>=minBet");
        if (kind == 3) require(newValue <= FEE_SHARE_MAX, "feeShare<=5000");
        uint64 eff = uint64(block.timestamp) + uint64(TIMELOCK);
        pendingValue[kind] = newValue;
        pendingEffectiveAt[kind] = eff;
        uint256 old = kind == 1 ? minBet : kind == 2 ? maxBetCap : creatorFeeShare;
        emit ParamScheduled(kind, old, newValue, eff);
    }

    function applyParamChange(uint8 kind) external onlyCreator {
        require(kind >= 1 && kind <= 3, "kind");
        require(pendingEffectiveAt[kind] != 0, "nothing scheduled");
        require(block.timestamp >= pendingEffectiveAt[kind], "timelock 24h");
        uint256 nv = pendingValue[kind];
        uint256 old;
        if (kind == 1) { old = minBet; minBet = nv; }
        else if (kind == 2) { old = maxBetCap; maxBetCap = nv; }
        else { old = creatorFeeShare; creatorFeeShare = uint16(nv); }
        delete pendingValue[kind];
        delete pendingEffectiveAt[kind];
        emit ParamApplied(kind, old, nv);
    }

    // ═══ Прочее ═══

    receive() external payable { revert("no BNB"); }
    fallback() external payable { revert("no BNB"); }
}

