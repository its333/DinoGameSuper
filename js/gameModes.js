(function () {
    const royaleNames = ['Quicksilver', 'Nebula', 'CometRush', 'ByteKnight', 'NovaBlade', 'ShadowDash', 'CircuitFox', 'Zenith', 'NightPulse', 'EchoSprite', 'Sunset', 'Vapor', 'Lumen', 'Solaris'];
    const matchmakerUrl = 'ws://localhost:8080';
    let activeMode = 'single';
    let singleRunner = null;
    let localRunners = [];
    let localActive = true;
    let localReadyFlags = { p1: false, p2: false };
    let localReadyHandler = null;
    let localGameState = 'IDLE'; // IDLE, PLAYING, CRASHED, CONFIRMING
    let localCrashTimer = null;

    // VS AI State
    let vsAiState = {
        player: null,
        bots: [],
        alive: 0
    };

    // Battle Royale State
    let royaleState = {
        player: null,
        rivals: [],
        minis: [],
        roomName: 'Neon Lobby',
        playerName: 'You',
        alive: 0,
        roster: [],
        matchmaker: null,
        seed: null,
        runnerMap: {}, // Map server ID to runner instance
        countingDown: false
    };
    let countdownInterval = null;

    // Monkey-patch Runner to support holding keys for auto-jump
    const originalOnKeyDown = Runner.prototype.onKeyDown;
    const originalOnKeyUp = Runner.prototype.onKeyUp;
    const originalUpdate = Runner.prototype.update;

    Runner.prototype.onKeyDown = function (e) {
        if (!this.keysPressed) this.keysPressed = {};
        this.keysPressed[String(e.keyCode)] = true;
        originalOnKeyDown.call(this, e);
    };

    Runner.prototype.onKeyUp = function (e) {
        // Block Runner's built-in restart during Local 2P crash/confirm states
        if (localRunners.includes(this) && (localGameState === 'CRASHED' || localGameState === 'CONFIRMING')) {
            if (!this.keysPressed) this.keysPressed = {};
            this.keysPressed[String(e.keyCode)] = false;
            return; // Don't call original which might trigger restart()
        }

        if (!this.keysPressed) this.keysPressed = {};
        this.keysPressed[String(e.keyCode)] = false;
        originalOnKeyUp.call(this, e);
    };

    Runner.prototype.update = function () {
        if (this.activated && !this.crashed && !this.paused && this.keysPressed) {
            if (!this.tRex.jumping && !this.tRex.ducking) {
                const jumpKeys = Object.keys(this.controlMap.JUMP);
                const isJumpHeld = jumpKeys.some(k => this.keysPressed[k]);
                if (isJumpHeld) {
                    this.playSound(this.soundFx.BUTTON_PRESS);
                    this.tRex.startJump(this.currentSpeed);
                }
            }
        }
        originalUpdate.call(this);
    };
    const setText = (id, value) => {
        const el = document.getElementById(id);
        if (el) el.textContent = value;
    };

    const buildControls = (jumpKeys, duckKeys) => {
        const map = { JUMP: {}, DUCK: {}, RESTART: { '13': 1 } };
        jumpKeys.forEach(k => (map.JUMP[k] = 1));
        duckKeys.forEach(k => (map.DUCK[k] = 1));
        return map;
    };

    const destroyRunner = (runner) => {
        if (!runner) return;
        if (runner.botLoopId) {
            clearInterval(runner.botLoopId);
            runner.botLoopId = null;
        }
        if (typeof runner.destroy === 'function' && !runner.destroyed) {
            runner.destroy();
        }
    };

    const setRunnerActive = (runner, isActive) => {
        if (!runner) return;
        if (isActive) {
            runner.startListening && runner.startListening();
        } else {
            runner.stopListening && runner.stopListening();
        }
    };

    const showStartText = (runner, keys) => {
        if (!runner || !runner.containerEl) return;
        const msg = document.createElement('div');
        msg.className = 'start-overlay';
        msg.textContent = 'Press Jump to Start';
        msg.style.position = 'absolute';
        msg.style.top = '50%';
        msg.style.left = '50%';
        msg.style.transform = 'translate(-50%, -50%)';
        msg.style.fontSize = '24px';
        msg.style.color = '#535353';
        msg.style.fontWeight = 'bold';
        msg.style.zIndex = '100';
        msg.style.fontFamily = 'inherit';
        runner.containerEl.appendChild(msg);

        runner.removeStartText = () => {
            if (msg && msg.parentNode) {
                msg.remove();
            }
            document.removeEventListener('keydown', handler);
        };

        const handler = (e) => {
            if (keys.includes(String(e.keyCode))) {
                runner.removeStartText();
            }
        };
        document.addEventListener('keydown', handler);
    };

    const createRunner = (hostId, options) => {
        const host = document.getElementById(hostId);
        if (!host) return null;
        host.innerHTML = '';
        return new Runner('#' + hostId, options || {});
    };


    const triggerBotStart = (runner) => {
        if (!runner) return;
        runner.activated = true;
        runner.play();
        runner.tRex.startJump(runner.currentSpeed);
    };

    const attachBotBrain = (runner, skill = 0.9) => {
        if (!runner) return;
        triggerBotStart(runner);

        // Each bot gets unique randomized behavior
        const baseReactionWindow = 90 + Math.random() * 40; // 90-130
        const reactionVariance = 10 + Math.random() * 30; // 10-40
        const updateInterval = 15 + Math.floor(Math.random() * 10); // 15-24ms
        const skillVariance = 0.05 + Math.random() * 0.1; // 0.05-0.15

        runner.botLoopId = setInterval(() => {
            if (runner.crashed || runner.destroyed) return;
            const obstacle = runner.horizon && runner.horizon.obstacles && runner.horizon.obstacles[0];
            if (!obstacle) return;
            const distanceToPlayer = obstacle.xPos - runner.tRex.xPos;
            // Randomize reaction window each time
            const reactionWindow = baseReactionWindow + (Math.random() * reactionVariance * 2 - reactionVariance);
            if (distanceToPlayer < reactionWindow && !runner.tRex.jumping && !runner.tRex.ducking) {
                // Randomize skill each jump
                const effectiveSkill = Math.max(0, Math.min(1, skill + (Math.random() * skillVariance * 2 - skillVariance)));
                if (Math.random() < effectiveSkill) {
                    runner.tRex.startJump(runner.currentSpeed);
                }
            }
        }, updateInterval);
    };

    // Single
    const resetSingle = () => {
        destroyRunner(singleRunner);
        setText('single-score', '0');
        singleRunner = createRunner('single-runner', {
            name: 'Solo',
            onScore: (score) => setText('single-score', score),
            onCrash: () => setText('single-status', 'Game over — press Space or Up to restart.')
        });
    };

    // Local 2P
    const handleLocalCrash = (index) => {
        // Only handle crash if we are currently playing
        if (localGameState !== 'PLAYING') return;

        // Transition to CRASHED state immediately
        localGameState = 'CRASHED';

        // Pause ALL runners immediately to freeze the state
        localRunners.forEach(r => {
            if (r) r.stop();
        });

        const stateId = index === 0 ? 'local-p1-state' : 'local-p2-state';

        // Mark the crashed player visually
        setText(stateId, 'Crashed');
        const stateEl = document.getElementById(stateId);
        if (stateEl) {
            stateEl.classList.remove('status-alive');
            stateEl.classList.add('status-dead');
        }

        const p1Crashed = localRunners[0].crashed;
        const p2Crashed = localRunners[1].crashed;

        if (p1Crashed && p2Crashed) {
            setText('local-status', 'Draw! Pausing...');
        } else {
            // One survivor
            const survivor = p1Crashed ? localRunners[1] : localRunners[0];
            const winnerId = p1Crashed ? 'local-p2-state' : 'local-p1-state';

            setText(winnerId, 'Winner');
            const el = document.getElementById(winnerId);
            if (el) el.classList.add('status-alive');

            setText('local-status', `${survivor.name} wins! Pausing...`);
        }

        // Start timer for confirmation phase
        if (localCrashTimer) clearTimeout(localCrashTimer);
        localCrashTimer = setTimeout(() => {
            localGameState = 'CONFIRMING';
            setText('local-status', 'Both players press Jump to restart');

            const confirmFlags = { p1: false, p2: false };
            const confirmHandler = (e) => {
                if (localGameState !== 'CONFIRMING') {
                    document.removeEventListener('keydown', confirmHandler);
                    return;
                }

                const code = String(e.keyCode);
                if (code === '87') confirmFlags.p1 = true; // W
                if (['38', '32', '13'].includes(code)) confirmFlags.p2 = true; // Up/Space/Enter

                if (confirmFlags.p1 && confirmFlags.p2) {
                    document.removeEventListener('keydown', confirmHandler);
                    resetLocal();
                }
            };
            document.addEventListener('keydown', confirmHandler);
        }, 2000);
    };

    const waitForLocalConfirm = () => {
        if (localReadyHandler) {
            document.removeEventListener('keydown', localReadyHandler);
            localReadyHandler = null;
        }
        localReadyFlags = { p1: false, p2: false };
        localRunners.forEach(r => setRunnerActive(r, false));
        const updateStatus = () => {
            const needs = [];
            if (!localReadyFlags.p1) needs.push('P1 (press W)');
            if (!localReadyFlags.p2) needs.push('P2 (press Up/Space)');
            if (needs.length) {
                setText('local-status', `Waiting for ${needs.join(', ')}`);
            } else {
                setText('local-status', 'Both confirmed — starting!');
            }
        };
        updateStatus();
        localReadyHandler = (e) => {
            const code = String(e.keyCode);
            if (code === '87') localReadyFlags.p1 = true;
            if (code === '38' || code === '32') localReadyFlags.p2 = true;
            updateStatus();
            if (localReadyFlags.p1 && localReadyFlags.p2) {
                document.removeEventListener('keydown', localReadyHandler);
                localReadyHandler = null;
                const seed = Date.now();
                localRunners.forEach(r => {
                    if (r && r.removeStartText) {
                        r.removeStartText();
                    }
                });

                // Recreate runners with shared seed for sync
                localRunners.forEach(destroyRunner);
                localRunners = [];
                localRunners.push(createRunner('local-p1', {
                    name: 'Player 1',
                    rngSeed: seed,
                    controls: buildControls(['87'], ['83']),
                    onScore: (score) => setText('local-p1-score', score),
                    onCrash: () => handleLocalCrash(0)
                }));
                localRunners.push(createRunner('local-p2', {
                    name: 'Player 2',
                    rngSeed: seed,
                    controls: buildControls(['38', '32'], ['40']),
                    onScore: (score) => setText('local-p2-score', score),
                    onCrash: () => handleLocalCrash(1)
                }));

                localRunners.forEach(r => {
                    r.activated = true;
                    r.play();
                    r.tRex.startJump(r.currentSpeed);
                    setRunnerActive(r, true);
                });
                localGameState = 'PLAYING';
            }
        };
        document.addEventListener('keydown', localReadyHandler);
    };

    const clearLocalConfirm = () => {
        if (localReadyHandler) {
            document.removeEventListener('keydown', localReadyHandler);
            localReadyHandler = null;
        }
    };

    const resetLocal = () => {
        localActive = true;
        if (localCrashTimer) clearTimeout(localCrashTimer);
        localGameState = 'IDLE';
        clearLocalConfirm();
        localRunners.forEach(destroyRunner);
        localRunners = [];
        ['local-p1-score', 'local-p2-score'].forEach(id => setText(id, '0'));
        ['local-p1-state', 'local-p2-state'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = 'Alive';
                el.classList.remove('status-dead');
                el.classList.add('status-alive');
            }
        });
        setText('local-status', 'Waiting for confirmations...');

        const seed = Date.now();

        // Create initial runners just for display
        localRunners.push(createRunner('local-p1', {
            name: 'Player 1',
            rngSeed: seed,
            controls: buildControls(['87'], ['83']),
            onScore: (score) => setText('local-p1-score', score),
            onCrash: () => handleLocalCrash(0)
        }));
        showStartText(localRunners[0], ['87']);

        localRunners.push(createRunner('local-p2', {
            name: 'Player 2',
            rngSeed: seed,
            controls: buildControls(['38', '32'], ['40']),
            onScore: (score) => setText('local-p2-score', score),
            onCrash: () => handleLocalCrash(1)
        }));
        showStartText(localRunners[1], ['38', '32']);
        waitForLocalConfirm();
    };

    // VS AI
    const resetVsAi = () => {
        destroyRunner(vsAiState.player);
        vsAiState.bots.forEach(destroyRunner);
        vsAiState.bots = [];

        ['vs-ai-player-score', 'vs-ai-bot-1-score', 'vs-ai-bot-2-score'].forEach(id => setText(id, '0'));
        ['vs-ai-player-state', 'vs-ai-bot-1-state', 'vs-ai-bot-2-state'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = 'Alive';
                el.classList.remove('status-dead');
                el.classList.add('status-alive');
            }
        });
        setText('vs-ai-status', 'Press Start to begin');

        const seed = Date.now();

        vsAiState.player = createRunner('vs-ai-player', {
            name: 'You',
            rngSeed: seed,
            onScore: (score) => setText('vs-ai-player-score', score),
            onCrash: () => {
                setText('vs-ai-player-state', 'Crashed');
                document.getElementById('vs-ai-player-state').classList.add('status-dead');
                checkVsAiWin();
            }
        });

        const botControls = buildControls([], []);
        const bot1 = createRunner('vs-ai-bot-1', {
            name: 'Bot 1',
            rngSeed: seed,
            controls: botControls,
            onScore: (score) => setText('vs-ai-bot-1-score', score),
            onCrash: () => {
                setText('vs-ai-bot-1-state', 'Crashed');
                document.getElementById('vs-ai-bot-1-state').classList.add('status-dead');
                checkVsAiWin();
            }
        });
        const bot2 = createRunner('vs-ai-bot-2', {
            name: 'Bot 2',
            rngSeed: seed,
            controls: botControls,
            onScore: (score) => setText('vs-ai-bot-2-score', score),
            onCrash: () => {
                setText('vs-ai-bot-2-state', 'Crashed');
                document.getElementById('vs-ai-bot-2-state').classList.add('status-dead');
                checkVsAiWin();
            }
        });

        vsAiState.bots = [bot1, bot2];
        setRunnerActive(vsAiState.player, false);
    };

    const startVsAi = () => {
        if (!vsAiState.player) resetVsAi();

        const seed = Date.now();
        // Recreate with new seed
        destroyRunner(vsAiState.player);
        vsAiState.bots.forEach(destroyRunner);

        vsAiState.player = createRunner('vs-ai-player', {
            name: 'You',
            rngSeed: seed,
            onScore: (score) => setText('vs-ai-player-score', score),
            onCrash: () => {
                setText('vs-ai-player-state', 'Crashed');
                document.getElementById('vs-ai-player-state').classList.add('status-dead');
                checkVsAiWin();
            }
        });

        const botControls = buildControls([], []);
        const bot1 = createRunner('vs-ai-bot-1', {
            name: 'Bot 1',
            rngSeed: seed,
            controls: botControls,
            onScore: (score) => setText('vs-ai-bot-1-score', score),
            onCrash: () => {
                setText('vs-ai-bot-1-state', 'Crashed');
                document.getElementById('vs-ai-bot-1-state').classList.add('status-dead');
                checkVsAiWin();
            }
        });
        const bot2 = createRunner('vs-ai-bot-2', {
            name: 'Bot 2',
            rngSeed: seed,
            controls: botControls,
            onScore: (score) => setText('vs-ai-bot-2-score', score),
            onCrash: () => {
                setText('vs-ai-bot-2-state', 'Crashed');
                document.getElementById('vs-ai-bot-2-state').classList.add('status-dead');
                checkVsAiWin();
            }
        });
        vsAiState.bots = [bot1, bot2];

        setText('vs-ai-status', 'Running!');

        [vsAiState.player, ...vsAiState.bots].forEach(r => {
            r.activated = true;
            r.play();
            r.tRex.startJump(r.currentSpeed);
        });
        setRunnerActive(vsAiState.player, true);
        attachBotBrain(bot1, 0.9);
        attachBotBrain(bot2, 0.85);
    };

    const checkVsAiWin = () => {
        if (vsAiState.player.crashed) {
            setText('vs-ai-status', 'You crashed! Bots win.');
        } else if (vsAiState.bots.every(b => b.crashed)) {
            setText('vs-ai-status', 'Victory! You outlasted the bots.');
        }
    };

    // Battle Royale (Online)
    class Matchmaker {
        constructor(onRoster, onGameStart, onRivalUpdate, onWelcome, onError) {
            this.socket = null;
            this.onRoster = onRoster;
            this.onGameStart = onGameStart;
            this.onRivalUpdate = onRivalUpdate;
            this.onWelcome = onWelcome;
            this.onError = onError;
        }
        connect({ name, room, quick }) {
            try {
                this.socket = new WebSocket(matchmakerUrl);
                this.socket.onopen = () => {
                    const type = quick ? 'QUICK_PLAY' : 'JOIN_ROOM';
                    this.socket.send(JSON.stringify({ type, room, playerName: name }));
                };
                this.socket.onmessage = (evt) => {
                    try {
                        const data = JSON.parse(evt.data);
                        if (data.type === 'ERROR') {
                            if (this.onError) this.onError(data.message);
                        } else if (data.type === 'WELCOME') {
                            if (this.onWelcome) this.onWelcome(data.id);
                        } else if (data.type === 'ROSTER_UPDATE') {
                            this.onRoster(data.roster);
                        } else if (data.type === 'GAME_START') {
                            this.onGameStart(data.seed);
                        } else if (data.type === 'COUNTDOWN_START' || data.type === 'COUNTDOWN_UPDATE') {
                            setText('royale-status', `Starting in ${data.count}...`);
                        } else if (data.type === 'RIVAL_UPDATE') {
                            this.onRivalUpdate(data.id, data.state);
                        }
                    } catch (err) {
                        console.error(err);
                    }
                };
                this.socket.onerror = () => {
                    if (this.onError) this.onError('Unable to connect to server.');
                };
                this.socket.onclose = () => {
                    if (this.onError) this.onError('Disconnected from server.');
                };
            } catch (err) {
                if (this.onError) this.onError(err.message);
            }
        }
        startGame() {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'START_GAME' }));
            }
        }
        sendUpdate(state) {
            if (this.socket && this.socket.readyState === WebSocket.OPEN) {
                this.socket.send(JSON.stringify({ type: 'PLAYER_UPDATE', state }));
            }
        }
        destroy() {
            if (this.socket) {
                this.socket.close();
                this.socket = null;
            }
        }
    }

    const tearDownRoyale = () => {
        if (royaleState.matchmaker) {
            royaleState.matchmaker.destroy();
            royaleState.matchmaker = null;
        }
        if (royaleState.heartbeatId) {
            clearInterval(royaleState.heartbeatId);
            royaleState.heartbeatId = null;
        }
        destroyRunner(royaleState.player);
        royaleState.rivals.forEach(destroyRunner);
        royaleState.minis.forEach(destroyRunner);
        royaleState = Object.assign(royaleState, {
            player: null,
            rivals: [],
            minis: [],
            alive: 0,
            roster: [],
            runnerMap: {},
            countingDown: false,
            gameStarted: false,
            heartbeatId: null
        });
        ['royale-mini-left', 'royale-mini-right', 'royale-mini-row-top', 'royale-mini-row-bottom'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });
        ['royale-player-score', 'royale-rival-a-score', 'royale-rival-b-score', 'royale-rival-c-score'].forEach(id => setText(id, '0'));
        ['royale-player-state', 'royale-rival-a-state', 'royale-rival-b-state', 'royale-rival-c-state'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = 'Alive';
                el.classList.remove('status-dead');
                el.classList.add('status-alive');
            }
        });
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
        const lobby = document.getElementById('royale-lobby');
        const lobbyInput = document.getElementById('lobby-input');
        const lobbyWaiting = document.getElementById('lobby-waiting');
        const layout = document.getElementById('royale-game-layout');
        const nextBtn = document.getElementById('royale-next');
        const returnBtn = document.getElementById('royale-return');
        const startBtn = document.getElementById('royale-start-btn');
        const rosterList = document.getElementById('lobby-roster-list');
        if (rosterList) rosterList.innerHTML = '';
        if (lobby) lobby.style.display = 'flex';
        if (lobbyInput) lobbyInput.style.display = 'block';
        if (lobbyWaiting) lobbyWaiting.style.display = 'none';
        if (layout) layout.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';
        if (returnBtn) returnBtn.style.display = 'none';
        if (startBtn) startBtn.style.display = 'none';
        setText('royale-status', 'Lobby idle');
    };

    const createMiniRunner = (player, skill, controls, index, seed, targetGridId) => {
        const grid = document.getElementById(targetGridId || 'royale-mini-left');
        if (!grid) return null;
        const slot = document.createElement('div');
        slot.className = 'mini-tile';
        const label = document.createElement('div');
        label.className = 'lane-label';
        label.innerHTML = `<strong>${player.name}</strong><span class="muted">Mini</span>`;
        const host = document.createElement('div');
        const hostId = 'mini-' + index;
        host.id = hostId;
        host.className = 'runner-host mini-runner';
        const meta = document.createElement('div');
        meta.className = 'meta-row';
        meta.innerHTML = `<span>Score: <strong id="${hostId}-score">0</strong></span><span id="${hostId}-state" class="status-alive">Alive</span>`;
        slot.appendChild(label);
        slot.appendChild(host);
        slot.appendChild(meta);
        grid.appendChild(slot);

        const runner = createRunner(hostId, {
            name: player.name,
            rngSeed: seed,
            controls: controls || buildControls([], []),
            dimensions: { HEIGHT: 110 },
            onScore: (score) => setText(`${hostId}-score`, score),
            onCrash: () => {
                runner.crashed = true; // CRITICAL: Mark runner as crashed
                const el = document.getElementById(`${hostId}-state`);
                if (el) {
                    el.textContent = 'Down';
                    el.classList.remove('status-alive');
                    el.classList.add('status-dead');
                }
            }
        });
        if (runner) runner.stopListening();
        // Only attach bot brain if it's a bot (no ID)
        if (!player.id) {
            attachBotBrain(runner, skill);
        }
        if (runner) {
            runner.playerInfo = player;
            runner.skill = skill;
            runner.slot = 'mini';
            runner.slotEl = slot;
        }
        return runner;
    };

    const pickNames = (selfName, roster) => {
        // Roster contains objects {id, name, isHost}
        const others = roster.filter(p => p.name !== selfName);

        const live = [{ name: selfName, id: 'me' }]; // Player
        const minis = [];

        // Fill rival slots with real players only
        if (others.length > 0) live.push(others[0]); // Rival A
        if (others.length > 1) live.push(others[1]); // Rival B
        if (others.length > 2) live.push(others[2]); // Rival C

        // Fill minis with remaining real players (up to 13)
        for (let i = 3; i < others.length && i < 16; i++) {
            minis.push(others[i]);
        }

        return { live, minis };
    };

    const startAutoCountdown = () => {
        if (royaleState.countingDown) return;
        royaleState.countingDown = true;
        let seconds = 10;
        if (countdownInterval) clearInterval(countdownInterval);

        countdownInterval = setInterval(() => {
            setText('royale-status', `Starting in ${seconds}s...`);
            seconds--;

            if (seconds < 0) {
                clearInterval(countdownInterval);
                countdownInterval = null;
                royaleState.countingDown = false;

                const host = royaleState.roster?.find(p => p.isHost) || royaleState.roster?.[0];
                if (host && host.name === royaleState.playerName) {
                    startRoyaleGame();
                }
            }
        }, 1000);
    };

    // Debug fill to visualize layout without server
    const debugFillRoyale = () => {
        tearDownRoyale();
        const pName = document.getElementById('player-name').value.trim() || 'You';
        const layout = document.getElementById('royale-game-layout');
        const lobby = document.getElementById('royale-lobby');
        const lobbyInput = document.getElementById('lobby-input');
        const lobbyWaiting = document.getElementById('lobby-waiting');

        const roster = [{ name: pName, isHost: true }];
        royaleNames.slice(0, 12).forEach((n, idx) => roster.push({ name: `${n}-${idx + 1}` }));
        royaleState.roster = roster;
        royaleState.roomName = 'Debug Bots';
        royaleState.playerName = pName;
        if (layout) layout.style.display = 'grid';
        if (lobby) lobby.style.display = 'none';
        if (lobbyInput) lobbyInput.style.display = 'none';
        if (lobbyWaiting) lobbyWaiting.style.display = 'none';
        setText('royale-status', 'Debug: layout preview');
        hydrateRoyale(Date.now(), true);
    };

    const hydrateRoyale = (seed, warmup = false, showPlaceholders = false) => {
        const { live, minis } = pickNames(royaleState.playerName, royaleState.roster || []);

        setText('royale-player-label', live[0]?.name || 'You');
        if (live[1]) setText('royale-rival-a-label', live[1].name || 'Rival A');
        if (live[2]) setText('royale-rival-b-label', live[2].name || 'Rival B');
        if (live[3]) setText('royale-rival-c-label', live[3].name || 'Rival C');

        // Destroy existing
        royaleState.seed = seed;
        destroyRunner(royaleState.player);
        royaleState.rivals.forEach(destroyRunner);
        royaleState.minis.forEach(destroyRunner);
        ['royale-mini-left', 'royale-mini-right', 'royale-mini-row-top', 'royale-mini-row-bottom'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.innerHTML = '';
        });
        const shell = document.getElementById('royale-game-layout');
        if (shell) {
            shell.classList.remove('no-rails', 'only-left', 'only-right');
        }
        royaleState.runnerMap = {};

        // Player
        royaleState.player = createRunner('royale-player', {
            name: live[0]?.name || 'You',
            rngSeed: seed,
            onScore: (score) => {
                setText('royale-player-score', score);
                if (royaleState.matchmaker) {
                    royaleState.matchmaker.sendUpdate({
                        score,
                        crashed: false,
                        jumping: royaleState.player.tRex.jumping || false,
                        ducking: royaleState.player.tRex.ducking || false
                    });
                }
            },
            onCrash: () => {
                royaleState.player.crashed = true;
                setText('royale-player-state', 'Down');
                const playerStateEl = document.getElementById('royale-player-state');
                if (playerStateEl) playerStateEl.classList.add('status-dead');

                // Send final crash update
                if (royaleState.matchmaker) {
                    royaleState.matchmaker.sendUpdate({ score: 0, crashed: true, jumping: false, ducking: false });
                }

                // Enter spectator mode
                setText('royale-status', 'You crashed! Spectating rivals...');

                // Check if all players are dead
                setTimeout(() => {
                    const allDead = [royaleState.player, ...royaleState.rivals, ...royaleState.minis].every(r => r && r.crashed);
                    if (allDead) {
                        handleRoyaleGameOver();
                    }
                }, 500);
            }
        });

        // Rivals
        const botControls = buildControls([], []);

        const rivalSlots = {
            'rival-a': { hostId: 'royale-rival-a', scoreId: 'royale-rival-a-score', stateId: 'royale-rival-a-state', skill: 0.9 },
            'rival-b': { hostId: 'royale-rival-b', scoreId: 'royale-rival-b-score', stateId: 'royale-rival-b-state', skill: 0.85 },
            'rival-c': { hostId: 'royale-rival-c', scoreId: 'royale-rival-c-score', stateId: 'royale-rival-c-state', skill: 0.82 }
        };

        const createRivalRunner = (slotKey, player, meta, skill) => {
            const slotEl = document.getElementById(meta.hostId)?.parentElement;
            if (!player) {
                if (slotEl) slotEl.style.visibility = 'hidden';
                return null;
            }
            if (slotEl) slotEl.style.visibility = 'visible';

            const runner = createRunner(meta.hostId, {
                name: player.name,
                rngSeed: seed,
                controls: botControls,
                onScore: (score) => setText(meta.scoreId, score),
                onCrash: () => {
                    runner.crashed = true; // CRITICAL: Mark runner as crashed
                    setText(meta.stateId, 'Down');
                    const stateEl = document.getElementById(meta.stateId);
                    if (stateEl) stateEl.classList.add('status-dead');
                    if (royaleState.promoteSlot) royaleState.promoteSlot(slotKey);
                }
            });
            runner.playerInfo = player;
            runner.slot = slotKey;
            runner.skill = skill;
            if (player.id) {
                royaleState.runnerMap[player.id] = { runner, scoreId: meta.scoreId, stateId: meta.stateId, slot: slotKey };
            } else {
                attachBotBrain(runner, skill);
            }
            return runner;
        };

        const rivalA = createRivalRunner('rival-a', live[1], rivalSlots['rival-a'], rivalSlots['rival-a'].skill);
        const rivalB = createRivalRunner('rival-b', live[2], rivalSlots['rival-b'], rivalSlots['rival-b'].skill);
        const rivalC = createRivalRunner('rival-c', live[3], rivalSlots['rival-c'], rivalSlots['rival-c'].skill);

        royaleState.rivals = [rivalA, rivalB, rivalC].filter(r => r);

        // Minis
        royaleState.minis = [];
        let leftCount = 0;
        let rightCount = 0;
        let topCount = 0;
        let bottomCount = 0;

        minis.forEach((player, i) => {
            let targetGrid = 'royale-mini-left'; // 0-2 left rail
            if (i >= 3 && i < 6) targetGrid = 'royale-mini-right'; // 3-5 right rail
            if (i >= 6 && i < 9) targetGrid = 'royale-mini-row-top'; // 6-8 first bottom row
            if (i >= 9 && i < 13) targetGrid = 'royale-mini-row-bottom'; // 9-12 second bottom row
            if (i >= 13) targetGrid = 'royale-mini-row-bottom';
            const runner = createMiniRunner(player, 0.72 + i * 0.03, botControls, i, seed, targetGrid);
            if (runner) {
                royaleState.minis.push(runner);
                if (targetGrid === 'royale-mini-left') leftCount++;
                if (targetGrid === 'royale-mini-right') rightCount++;
                if (targetGrid === 'royale-mini-row-top') topCount++;
                if (targetGrid === 'royale-mini-row-bottom') bottomCount++;
                if (player.id) {
                    royaleState.runnerMap[player.id] = {
                        runner,
                        scoreId: `mini-${i}-score`,
                        stateId: `mini-${i}-state`
                    };
                }
            }
        });

        // Fill placeholders to preserve layout when under-populated
        const appendPlaceholder = (gridId, count, max) => {
            const grid = document.getElementById(gridId);
            if (!grid) return;
            for (let i = count; i < max; i++) {
                const slot = document.createElement('div');
                slot.className = 'mini-tile placeholder';
                slot.innerHTML = `<div class="lane-label"><strong>Waiting...</strong><span class="muted">Mini</span></div>
                                  <div class="runner-host mini-runner"></div>
                                  <div class="meta-row"><span>Score: <strong>0</strong></span><span class="status-alive">Ready</span></div>`;
                grid.appendChild(slot);
            }
        };
        if (showPlaceholders) {
            appendPlaceholder('royale-mini-left', leftCount, 3);
            appendPlaceholder('royale-mini-right', rightCount, 3);
            appendPlaceholder('royale-mini-row-top', topCount, 3);
            appendPlaceholder('royale-mini-row-bottom', bottomCount, 4);
        }

        // Keep shell width consistent regardless of rail fill state; no layout collapsing here.

        // Start or warmup
        const allRunners = [royaleState.player, ...royaleState.rivals, ...royaleState.minis].filter(r => r);
        if (!warmup) {
            allRunners.forEach(r => {
                r.activated = true;
                r.play();
                r.tRex.startJump(r.currentSpeed);
            });
            setRunnerActive(royaleState.player, true);
        } else {
            allRunners.forEach(r => r.draw && r.draw());
        }
    };

    const handleRoyaleGameOver = () => {
        // Find survivor or highest scorer
        const allRunners = [royaleState.player, ...royaleState.rivals, ...royaleState.minis].filter(r => r);
        if (allRunners.length < 2) {
            setText('royale-status', 'Game Over');
            return;
        }
        const survivor = allRunners.find(r => !r.crashed);

        let winnerRunner = null;
        let winnerName = 'Unknown';

        if (survivor) {
            winnerRunner = survivor;
            winnerName = survivor.name || 'A player';
        } else {
            // Find highest scorer
            let maxScore = -1;
            allRunners.forEach(r => {
                const score = r.distanceRan || 0;
                if (score > maxScore) {
                    maxScore = score;
                    winnerRunner = r;
                    winnerName = r.name || 'A player';
                }
            });
        }

        // Check if local player won
        const isWinner = winnerRunner === royaleState.player && !royaleState.player.crashed;

        if (isWinner) {
            setText('royale-status', 'Victory! You are the last dino standing!');
        } else {
            setText('royale-status', `Game Over! ${winnerName} wins!`);
        }

        const returnBtn = document.getElementById('royale-return');
        const nextBtn = document.getElementById('royale-next');
        if (returnBtn) returnBtn.style.display = 'inline-block';
        if (nextBtn) nextBtn.style.display = 'inline-block';

        if (returnBtn) {
            returnBtn.onclick = () => {
                tearDownRoyale();
                const lobby = document.getElementById('royale-lobby');
                const lobbyInput = document.getElementById('lobby-input');
                const lobbyWaiting = document.getElementById('lobby-waiting');
                const layout = document.getElementById('royale-game-layout');
                if (layout) layout.style.display = 'none';
                if (lobby) lobby.style.display = 'flex';
                if (lobbyInput) lobbyInput.style.display = 'block';
                if (lobbyWaiting) lobbyWaiting.style.display = 'none';
                setText('royale-status', 'Lobby idle');
            };
        }

        if (nextBtn) {
            nextBtn.onclick = () => {
                joinRoyale({ quick: true });
            };
        }
    };

    const joinRoyale = ({ quick = false } = {}) => {
        tearDownRoyale();
        const pName = document.getElementById('player-name').value.trim() || `Player${Date.now().toString().slice(-4)}`;
        const roomInput = document.getElementById('room-name').value.trim() || 'Open Lobby';
        royaleState.playerName = pName;
        royaleState.roomName = quick ? 'Quick Play' : roomInput;

        const lobby = document.getElementById('royale-lobby');
        const lobbyInput = document.getElementById('lobby-input');
        const lobbyWaiting = document.getElementById('lobby-waiting');
        const layout = document.getElementById('royale-game-layout');
        const startBtn = document.getElementById('royale-start-btn');
        const returnBtn = document.getElementById('royale-return');
        const nextBtn = document.getElementById('royale-next');

        if (lobbyInput) lobbyInput.style.display = 'none';
        if (returnBtn) returnBtn.style.display = 'none';
        if (nextBtn) nextBtn.style.display = 'none';

        if (quick) {
            if (lobby) lobby.style.display = 'none';
            if (lobbyWaiting) lobbyWaiting.style.display = 'none';
            if (layout) layout.style.display = 'grid';
            setText('royale-status', 'Searching for players...');

            royaleState.player = createRunner('royale-player', {
                name: pName,
                rngSeed: 0,
                onScore: () => { },
                onCrash: () => { }
            });
            setText('royale-player-label', pName);
        } else {
            if (lobby) lobby.style.display = 'flex';
            if (lobbyWaiting) lobbyWaiting.style.display = 'block';
            if (layout) layout.style.display = 'none';
            if (startBtn) startBtn.style.display = 'none';
            setText('lobby-room-name', `Room: ${royaleState.roomName}`);
            setText('lobby-status-text', 'Connecting...');
            setText('royale-status', 'Connecting...');
        }

        const updateRoster = (roster = []) => {
            royaleState.roster = roster;
            const rosterEl = document.getElementById('lobby-roster-list');
            const isHost = roster.some(p => p.isHost && p.name === pName) || (roster[0] && roster[0].name === pName);

            if (rosterEl) {
                rosterEl.innerHTML = '';
                roster.forEach(player => {
                    const item = document.createElement('div');
                    item.className = 'roster-item' + (player.name === pName ? ' is-me' : '');
                    const role = player.isHost ? 'Host' : 'Player';
                    item.innerHTML = `<span>${player.name}</span><span class="muted">${role}</span>`;
                    rosterEl.appendChild(item);
                });
            }

            if (!quick) {
                setText('lobby-status-text', isHost ? 'You are host - start when ready.' : 'Waiting for host to start...');
                if (startBtn) startBtn.style.display = isHost && roster.length >= 2 ? 'inline-block' : 'none';
                setText('royale-status', `Lobby: ${roster.length} players`);
                // Render preview behind overlay so players can see who is here
                if (layout) layout.style.display = 'grid';
                if (!royaleState.gameStarted) {
                    const previewSeed = royaleState.seed || (roster.reduce((acc, p) => acc + (p.id ? p.id.length : 1), 0) + roster.length);
                    // Use warmup to avoid auto-starting the local runner during lobby
                    hydrateRoyale(previewSeed, true, true);
                    startHeartbeat();
                }
            } else {
                // Server handles countdown for Quick Play
                if (countdownInterval) {
                    clearInterval(countdownInterval);
                    countdownInterval = null;
                }
                royaleState.countingDown = false;

                if (roster.length >= 2) {
                    setText('royale-status', 'Waiting for server countdown...');
                } else {
                    setText('royale-status', 'Waiting for players...');
                }

                // Render preview with placeholders so others are visible
                if (layout) layout.style.display = 'grid';
                if (!royaleState.gameStarted) {
                    const previewSeed = royaleState.seed || (roster.reduce((acc, p) => acc + (p.id ? p.id.length : 1), 0) + roster.length);
                    // Use warmup to avoid auto-starting the local runner during lobby
                    hydrateRoyale(previewSeed, true, true);
                    startHeartbeat();
                }
            }
        };

        const startHeartbeat = () => {
            if (royaleState.heartbeatId) clearInterval(royaleState.heartbeatId);
            const send = () => {
                if (!royaleState.matchmaker) return;
                const r = royaleState.player;
                const payload = r ? {
                    score: Math.floor(r.distanceRan || 0),
                    crashed: !!r.crashed,
                    jumping: !!(r.tRex && r.tRex.jumping),
                    ducking: !!(r.tRex && r.tRex.ducking),
                    name: royaleState.playerName
                } : {
                    score: 0,
                    crashed: false,
                    jumping: false,
                    ducking: false,
                    name: royaleState.playerName
                };
                royaleState.matchmaker.sendUpdate(payload);
            };
            send();
            royaleState.heartbeatId = setInterval(send, 250);
        };

        const matchmaker = new Matchmaker(updateRoster, (seed) => {
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
                royaleState.countingDown = false;
            }
            royaleState.gameStarted = true;
            setText('royale-status', 'Game Started!');
            if (lobby) lobby.style.display = 'none';
            if (lobbyWaiting) lobbyWaiting.style.display = 'none';
            if (layout) layout.style.display = 'grid';
            if (startBtn) startBtn.style.display = 'none';
            hydrateRoyale(seed, false, false);
            startHeartbeat();
        }, (id, state) => {
            // Handle rival update; create runner if missing
            const getContainerByIndex = (idx) => {
                if (idx >= 0 && idx < 3) return document.getElementById('royale-mini-left');
                if (idx >= 3 && idx < 6) return document.getElementById('royale-mini-right');
                if (idx >= 6 && idx < 9) return document.getElementById('royale-mini-row-top');
                return document.getElementById('royale-mini-row-bottom');
            };
            const ensureRival = (playerId, playerState) => {
                if (royaleState.runnerMap[playerId]) return royaleState.runnerMap[playerId];
                const rosterIdx = (royaleState.roster || []).findIndex(p => p.id === playerId);
                const idx = rosterIdx >= 0 ? rosterIdx : Object.keys(royaleState.runnerMap).length;
                const hostId = `mini-${idx}`;
                // If tile exists, reuse it; else create
                let runnerHost = document.getElementById(hostId);
                if (!runnerHost) {
                    const slot = document.createElement('div');
                    slot.className = 'mini-tile';
                    slot.innerHTML = `<div class="lane-label"><strong>${playerState?.name || 'Waiting...'}</strong><span class="muted">Mini</span></div>
                                      <div class="runner-host mini-runner" id="${hostId}"></div>
                                      <div class="meta-row"><span>Score: <strong id="${hostId}-score">0</strong></span><span id="${hostId}-state" class="status-alive">Alive</span></div>`;
                    const grid = getContainerByIndex(idx);
                    if (grid) grid.appendChild(slot);
                }
                const runner = createRunner(hostId, {
                    name: playerState?.name || playerId,
                    rngSeed: royaleState.seed || Date.now(),
                    controls: buildControls([], [])
                });
                if (runner) {
                    runner.stopListening();
                    // Leave runner idle for real players in lobby; no bot brain here.
                }
                const entry = { runner, scoreId: `${hostId}-score`, stateId: `${hostId}-state`, slot: hostId };
                royaleState.runnerMap[playerId] = entry;
                return entry;
            };

            const target = ensureRival(id, state);
            if (!target || !target.runner) return;

            if (state.crashed) {
                if (!target.runner.crashed) {
                    target.runner.crashed = true; // Visual only
                    if (target.runner.gameOver) {
                        target.runner.gameOver();
                    } else if (target.runner.tRex && target.runner.tRex.update) {
                        target.runner.tRex.update(0, 'CRASHED');
                    }
                    setText(target.stateId, 'Down');
                    document.getElementById(target.stateId)?.classList.add('status-dead');
                    if (target.slot && target.slot.startsWith('rival') && royaleState.promoteSlot) {
                        royaleState.promoteSlot(target.slot);
                    }
                }
            } else {
                // If we had marked them crashed, revive visuals
                if (target.runner && target.runner.crashed) {
                    target.runner.crashed = false;
                    const stateEl = document.getElementById(target.stateId);
                    if (stateEl) {
                        stateEl.textContent = 'Alive';
                        stateEl.classList.remove('status-dead');
                        stateEl.classList.add('status-alive');
                    }
                }
                // Update score
                if (state.score !== undefined) {
                    setText(target.scoreId, state.score);
                    if (target.runner) {
                        target.runner.distanceRan = state.score;
                    }
                }

                // Apply action states for visual feedback
                if (target.runner && target.runner.tRex) {
                    // Apply jumping state
                    if (state.jumping && !target.runner.tRex.jumping) {
                        target.runner.tRex.startJump(target.runner.currentSpeed);
                    }

                    // Apply ducking state
                    if (state.ducking && !target.runner.tRex.ducking) {
                        target.runner.tRex.setDuck(true);
                    } else if (!state.ducking && target.runner.tRex.ducking) {
                        target.runner.tRex.setDuck(false);
                    }
                } else if (!target.runner) {
                        const tempRunner = createRunner(target.slot || `mini-${id}`, {
                            name: state.name || id,
                            rngSeed: royaleState.seed || Date.now(),
                            controls: buildControls([], [])
                        });
                    if (tempRunner) {
                        tempRunner.stopListening();
                        target.runner = tempRunner;
                        attachBotBrain(tempRunner, 0.8);
                    }
                }
            }
        }, (id) => {
            royaleState.myId = id;
            console.log('My ID:', id);
        }, (err) => {
            setText('royale-status', err);
            setText('lobby-status-text', err);
            if (countdownInterval) {
                clearInterval(countdownInterval);
                countdownInterval = null;
            }
            royaleState.countingDown = false;
            if (lobby) lobby.style.display = 'flex';
            if (lobbyInput) lobbyInput.style.display = 'block';
            if (lobbyWaiting) lobbyWaiting.style.display = 'none';
            if (layout) layout.style.display = 'none';
        });

        matchmaker.connect({ name: pName, room: royaleState.roomName, quick });
        royaleState.matchmaker = matchmaker;
    };

    const startRoyaleGame = () => {
        if (countdownInterval) {
            clearInterval(countdownInterval);
            countdownInterval = null;
        }
        royaleState.countingDown = false;
        setText('royale-status', 'Starting...');
        if (royaleState.matchmaker) {
            royaleState.matchmaker.startGame();
        }
    };

    const switchMode = (mode) => {
        activeMode = mode;
        document.querySelectorAll('.mode-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + mode));
        document.querySelectorAll('.tab-buttons button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));

        setRunnerActive(singleRunner, false);
        localRunners.forEach(r => setRunnerActive(r, false));
        setRunnerActive(vsAiState.player, false);
        setRunnerActive(royaleState.player, false);
        clearLocalConfirm();

        if (mode === 'single') {
            setTimeout(() => {
                if (!singleRunner) resetSingle();
                setRunnerActive(singleRunner, true);
            }, 100);
        }
        if (mode === 'local-2p') {
            setTimeout(() => {
                resetLocal();
            }, 100);
        }
        if (mode === 'vs-ai') {
            setTimeout(() => {
                resetVsAi();
            }, 100);
        }
        if (mode === 'royale') {
            tearDownRoyale();
        }
    };

    const bindUI = () => {
        document.querySelectorAll('.tab-buttons button').forEach(btn => {
            btn.addEventListener('click', () => switchMode(btn.dataset.mode));
        });
        document.getElementById('single-start')?.addEventListener('click', resetSingle);
        document.getElementById('local-reset')?.addEventListener('click', resetLocal);
        document.getElementById('vs-ai-start')?.addEventListener('click', startVsAi);

        document.getElementById('create-room')?.addEventListener('click', () => joinRoyale({ quick: false }));
        document.getElementById('royale-quick')?.addEventListener('click', () => joinRoyale({ quick: true }));
        document.getElementById('royale-start-btn')?.addEventListener('click', startRoyaleGame);
        document.getElementById('royale-leave-btn')?.addEventListener('click', tearDownRoyale);

        document.getElementById('debug-fill')?.addEventListener('click', debugFillRoyale);
        document.getElementById('royale-next')?.addEventListener('click', () => joinRoyale({ quick: true }));
        document.getElementById('royale-return')?.addEventListener('click', () => tearDownRoyale());
    };

    document.addEventListener('DOMContentLoaded', () => {
        bindUI();
        resetSingle();
        switchMode('single');
    });
})();
