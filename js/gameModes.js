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
        runnerMap: {} // Map server ID to runner instance
    };

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
        runner.botLoopId = setInterval(() => {
            if (runner.crashed || runner.destroyed) return;
            const obstacle = runner.horizon && runner.horizon.obstacles && runner.horizon.obstacles[0];
            if (!obstacle) return;
            const distanceToPlayer = obstacle.xPos - runner.tRex.xPos;
            const reactionWindow = 110 + Math.random() * 20;
            if (distanceToPlayer < reactionWindow && !runner.tRex.jumping && !runner.tRex.ducking) {
                if (Math.random() < skill) {
                    runner.tRex.startJump(runner.currentSpeed);
                }
            }
        }, 18);
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
        constructor(onRoster, onGameStart, onRivalUpdate, onError) {
            this.socket = null;
            this.onRoster = onRoster;
            this.onGameStart = onGameStart;
            this.onRivalUpdate = onRivalUpdate;
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
                        if (data.type === 'ROSTER_UPDATE') {
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
        destroyRunner(royaleState.player);
        royaleState.rivals.forEach(destroyRunner);
        royaleState.minis.forEach(destroyRunner);
        royaleState = Object.assign(royaleState, {
            player: null,
            rivals: [],
            minis: [],
            alive: 0,
            roster: [],
            runnerMap: {}
        });
        const miniGrid = document.getElementById('royale-mini-grid');
        if (miniGrid) miniGrid.innerHTML = '';
        ['royale-player-score', 'royale-rival-a-score', 'royale-rival-b-score'].forEach(id => setText(id, '0'));
        ['royale-player-state', 'royale-rival-a-state', 'royale-rival-b-state'].forEach(id => {
            const el = document.getElementById(id);
            if (el) {
                el.textContent = 'Alive';
                el.classList.remove('status-dead');
                el.classList.add('status-alive');
            }
        });
    };

    const createMiniRunner = (player, skill, controls, index, seed) => {
        const grid = document.getElementById('royale-mini-grid');
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
        return runner;
    };

    const pickNames = (selfName, roster) => {
        // Roster contains objects {id, name, isHost}
        // We need to separate real players from bots if roster is small
        const others = roster.filter(p => p.name !== selfName);

        const live = [{ name: selfName, id: 'me' }]; // Placeholder for self
        const minis = [];

        // Fill live slots (Rival A, Rival B)
        if (others.length > 0) live.push(others[0]);
        else live.push({ name: royaleNames[0], isBot: true });

        if (others.length > 1) live.push(others[1]);
        else live.push({ name: royaleNames[1], isBot: true });

        // Fill minis
        for (let i = 2; i < others.length; i++) {
            minis.push(others[i]);
        }
        // Fill remaining minis with bots if needed (up to 4 minis total)
        while (minis.length < 4) {
            minis.push({ name: royaleNames[minis.length + 2], isBot: true });
        }

        return { live, minis };
    };

    const hydrateRoyale = (seed) => {
        const { live, minis } = pickNames(royaleState.playerName, royaleState.roster);

        setText('royale-player-label', `${live[0].name} (You)`);
        setText('royale-rival-a-label', live[1].name);
        setText('royale-rival-b-label', live[2].name);

        // Destroy existing
        destroyRunner(royaleState.player);
        royaleState.rivals.forEach(destroyRunner);
        royaleState.minis.forEach(destroyRunner);
        document.getElementById('royale-mini-grid').innerHTML = '';
        royaleState.runnerMap = {};

        // Player
        royaleState.player = createRunner('royale-player', {
            name: live[0].name,
            rngSeed: seed,
            onScore: (score) => {
                setText('royale-player-score', score);
                if (royaleState.matchmaker) royaleState.matchmaker.sendUpdate({ score, crashed: false });
            },
            onCrash: () => {
                setText('royale-player-state', 'Down');
                document.getElementById('royale-player-state').classList.add('status-dead');
                if (royaleState.matchmaker) royaleState.matchmaker.sendUpdate({ score: 0, crashed: true });
            }
        });

        // Rivals
        const botControls = buildControls([], []);

        const createRival = (player, hostId, scoreId, stateId, skill) => {
            const runner = createRunner(hostId, {
                name: player.name,
                rngSeed: seed,
                controls: botControls,
                onScore: (score) => setText(scoreId, score),
                onCrash: () => {
                    setText(stateId, 'Down');
                    document.getElementById(stateId).classList.add('status-dead');
                }
            });
            if (player.id) {
                royaleState.runnerMap[player.id] = { runner, scoreId, stateId };
            } else {
                attachBotBrain(runner, skill);
            }
            return runner;
        };

        const rivalA = createRival(live[1], 'royale-rival-a', 'royale-rival-a-score', 'royale-rival-a-state', 0.9);
        const rivalB = createRival(live[2], 'royale-rival-b', 'royale-rival-b-score', 'royale-rival-b-state', 0.85);

        royaleState.rivals = [rivalA, rivalB];

        // Minis
        royaleState.minis = [];
        minis.forEach((player, i) => {
            const runner = createMiniRunner(player, 0.72 + i * 0.03, botControls, i, seed);
            royaleState.minis.push(runner);
            if (player.id) {
                royaleState.runnerMap[player.id] = {
                    runner,
                    scoreId: `mini-${i}-score`,
                    stateId: `mini-${i}-state`
                };
            }
        });

        // Start all
        [royaleState.player, ...royaleState.rivals, ...royaleState.minis].forEach(r => {
            r.activated = true;
            r.play();
            r.tRex.startJump(r.currentSpeed);
        });
        setRunnerActive(royaleState.player, true);
    };

    const joinRoyale = ({ quick = false } = {}) => {
        tearDownRoyale();
        const pName = document.getElementById('player-name').value.trim() || 'You';
        const roomInput = document.getElementById('room-name').value.trim() || 'Open Lobby';
        royaleState.playerName = pName;
        royaleState.roomName = quick ? 'Quick Play' : roomInput;
        setText('royale-status', 'Connecting...');

        const matchmaker = new Matchmaker((roster) => {
            royaleState.roster = roster;
            setText('royale-status', `Lobby: ${roster.length} players`);
        }, (seed) => {
            setText('royale-status', 'Game Started!');
            hydrateRoyale(seed);
        }, (id, state) => {
            // Handle rival update
            const target = royaleState.runnerMap[id];
            if (target) {
                if (state.crashed) {
                    if (!target.runner.crashed) {
                        target.runner.crashed = true; // Visual only
                        target.runner.tRex.startCrash();
                        setText(target.stateId, 'Down');
                        document.getElementById(target.stateId).classList.add('status-dead');
                    }
                } else {
                    if (state.score !== undefined) {
                        setText(target.scoreId, state.score);
                    }
                }
            }
        }, (err) => {
            setText('royale-status', err);
        });

        matchmaker.connect({ name: pName, room: roomInput, quick });
        royaleState.matchmaker = matchmaker;
    };

    const startRoyaleGame = () => {
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
        document.getElementById('join-room')?.addEventListener('click', () => joinRoyale({ quick: false }));
        document.getElementById('royale-quick')?.addEventListener('click', () => joinRoyale({ quick: true }));
        document.getElementById('royale-start')?.addEventListener('click', startRoyaleGame);
    };

    document.addEventListener('DOMContentLoaded', () => {
        bindUI();
        resetSingle();
        switchMode('single');
    });
})();
