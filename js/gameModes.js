(function () {
    const royaleNames = ['Quicksilver', 'Nebula', 'CometRush', 'ByteKnight', 'NovaBlade', 'ShadowDash', 'CircuitFox', 'Zenith', 'NightPulse', 'EchoSprite', 'Sunset', 'Vapor', 'Lumen', 'Solaris'];
    const matchmakerUrl = window.DINO_MATCHMAKER_URL || '';
    let activeMode = 'single';
    let singleRunner = null;
    let localRunners = [];
    let localActive = true;
    let localReadyFlags = { p1: false, p2: false };
    let localReadyHandler = null;
    let royaleState = {
        player: null,
        rivals: [],
        minis: [],
        roomName: 'Neon Lobby',
        playerName: 'You',
        alive: 0,
        roster: []
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
        setText('single-status', 'Press Space or Up to run immediately.');
    };

    // Local 2P
    const handleLocalCrash = (index) => {
        if (!localActive) return;
        const stateId = index === 0 ? 'local-p1-state' : 'local-p2-state';
        const name = index === 0 ? 'Player 1' : 'Player 2';
        setText(stateId, 'Crashed');
        const stateEl = document.getElementById(stateId);
        if (stateEl) {
            stateEl.classList.remove('status-alive');
            stateEl.classList.add('status-dead');
        }
        const survivors = localRunners.filter(r => r && !r.crashed);
        if (survivors.length <= 1) {
            localActive = false;
            if (survivors.length === 1) {
                const winnerIdx = localRunners.indexOf(survivors[0]);
                const winnerId = winnerIdx === 0 ? 'local-p1-state' : 'local-p2-state';
                setText(winnerId, 'Winner');
                const el = document.getElementById(winnerId);
                if (el) {
                    el.classList.remove('status-dead');
                    el.classList.add('status-alive');
                }
                setText('local-status', `${survivors[0].name} wins the duel!`);
            } else {
                setText('local-status', 'Both players wiped out — rematch?');
            }
        } else {
            setText('local-status', `${name} is out, keep going!`);
        }
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
                localRunners.forEach(r => {
                    if (r && r.removeStartText) {
                        r.removeStartText();
                    }
                    if (r && r.play) {
                        r.play();
                        if (r.tRex) {
                            r.tRex.startJump(r.currentSpeed);
                        }
                    }
                    setRunnerActive(r, true);
                });
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

        localRunners.push(createRunner('local-p1', {
            name: 'Player 1',
            controls: buildControls(['87'], ['83']),
            onScore: (score) => setText('local-p1-score', score),
            onCrash: () => handleLocalCrash(0)
        }));
        showStartText(localRunners[0], ['87']);

        localRunners.push(createRunner('local-p2', {
            name: 'Player 2',
            controls: buildControls(['38', '32'], ['40']),
            onScore: (score) => setText('local-p2-score', score),
            onCrash: () => handleLocalCrash(1)
        }));
        showStartText(localRunners[1], ['38', '32']);
        waitForLocalConfirm();
    };

    // Local relay fallback
    class LocalRelay {
        constructor(room, name, onRoster) {
            this.room = room;
            this.name = name;
            this.onRoster = onRoster;
            if (!LocalRelay.rosters[this.room]) LocalRelay.rosters[this.room] = [];
            this.channel = new BroadcastChannel('dino-royale-relay');
            this.handle = this.handle.bind(this);
            this.channel.addEventListener('message', this.handle);
            this.ping();
            this.pinger = setInterval(() => this.ping(), 2000);
        }
        handle(evt) {
            const payload = evt.data;
            if (!payload || payload.room !== this.room || payload.type !== 'presence') return;
            const merged = Array.from(new Set([...(LocalRelay.rosters[this.room] || []), ...(payload.roster || [])]));
            LocalRelay.rosters[this.room] = merged;
            this.onRoster(merged);
        }
        ping() {
            this.channel.postMessage({ type: 'presence', room: this.room, roster: LocalRelay.rosters[this.room] });
        }
        announceJoin() {
            const roster = LocalRelay.rosters[this.room];
            if (!roster.includes(this.name)) {
                roster.push(this.name);
            }
            this.ping();
            this.onRoster(roster);
        }
        destroy() {
            clearInterval(this.pinger);
            this.channel.removeEventListener('message', this.handle);
            this.channel.close();
            LocalRelay.rosters[this.room] = LocalRelay.rosters[this.room].filter(n => n !== this.name);
        }
    }
    LocalRelay.rosters = {};

    class Matchmaker {
        constructor(onRoster, onError) {
            this.socket = null;
            this.onRoster = onRoster;
            this.onError = onError;
            this.relay = null;
        }
        connect({ name, room, quick }) {
            if (matchmakerUrl) {
                try {
                    this.socket = new WebSocket(matchmakerUrl);
                    this.socket.onopen = () => {
                        this.socket.send(JSON.stringify({ type: 'join', room: quick ? 'quickplay' : room, name }));
                    };
                    this.socket.onmessage = (evt) => {
                        try {
                            const data = JSON.parse(evt.data);
                            if (data.type === 'roster' && Array.isArray(data.players)) {
                                this.onRoster(data.players);
                            } else if (data.type === 'error' && this.onError) {
                                this.onError(data.message || 'Matchmaker error');
                            }
                        } catch (err) {
                            if (this.onError) this.onError(err.message);
                        }
                    };
                    this.socket.onerror = () => {
                        if (this.onError) this.onError('Unable to reach server, falling back to local relay.');
                        this.useRelay(name, room || 'Local Lobby');
                    };
                } catch (err) {
                    if (this.onError) this.onError(err.message);
                    this.useRelay(name, room || 'Local Lobby');
                }
            } else {
                this.useRelay(name, room || 'Local Lobby');
            }
        }
        useRelay(name, room) {
            if (this.relay) this.relay.destroy();
            this.relay = new LocalRelay(room, name, this.onRoster);
            this.relay.announceJoin();
        }
        destroy() {
            if (this.socket) {
                this.socket.close();
                this.socket = null;
            }
            if (this.relay) {
                this.relay.destroy();
                this.relay = null;
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
            roster: royaleState.roster
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

    const updateAliveBadge = () => {
        setText('royale-status', `Room: ${royaleState.roomName} — ${royaleState.alive} alive`);
    };

    const onRoyaleCrash = (runner, labelId) => {
        const badge = document.getElementById(labelId);
        if (badge) {
            badge.textContent = 'Down';
            badge.classList.remove('status-alive');
            badge.classList.add('status-dead');
        }
        royaleState.alive = Math.max(royaleState.alive - 1, 0);
        updateAliveBadge();
        const survivors = [royaleState.player].concat(royaleState.rivals).concat(royaleState.minis).filter(r => r && !r.crashed);
        if (survivors.length === 1) {
            setText('royale-status', `${survivors[0].name} takes the crown!`);
        }
    };

    const createMiniRunner = (playerName, skill, controls, index) => {
        const grid = document.getElementById('royale-mini-grid');
        const slot = document.createElement('div');
        slot.className = 'mini-tile';
        const label = document.createElement('div');
        label.className = 'lane-label';
        label.innerHTML = `<strong>${playerName}</strong><span class="muted">Mini</span>`;
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
            name: playerName,
            controls: controls || buildControls([], []),
            dimensions: { HEIGHT: 110 },
            onScore: (score) => setText(`${hostId}-score`, score),
            onCrash: () => onRoyaleCrash(runner, `${hostId}-state`)
        });
        if (runner) runner.stopListening();
        attachBotBrain(runner, skill);
        return runner;
    };

    const pickNames = (selfName, roster) => {
        const others = roster.filter(n => n !== selfName);
        const fill = [...others, ...royaleNames].slice(0, 6);
        return {
            live: [selfName, fill[0] || 'Rival A', fill[1] || 'Rival B'],
            minis: fill.slice(2, 6)
        };
    };

    const startRoyale = ({ quick = false } = {}) => {
        tearDownRoyale();
        const pName = document.getElementById('player-name').value.trim() || 'You';
        const roomInput = document.getElementById('room-name').value.trim() || 'Open Lobby';
        royaleState.playerName = pName;
        royaleState.roomName = quick ? 'Quick Play' : roomInput;
        setText('royale-status', 'Connecting to lobby...');

        if (royaleState.matchmaker) {
            royaleState.matchmaker.destroy();
            royaleState.matchmaker = null;
        }
        const matchmaker = new Matchmaker((roster) => {
            royaleState.roster = roster;
            hydrateRoyale();
        }, (msg) => {
            setText('royale-status', msg);
            hydrateRoyale();
        });
        matchmaker.connect({ name: pName, room: roomInput, quick });
        royaleState.matchmaker = matchmaker;
    };

    const hydrateRoyale = () => {
        if (!royaleState.roster || royaleState.roster.length === 0) {
            royaleState.roster = [royaleState.playerName];
        }
        const { live, minis } = pickNames(royaleState.playerName, royaleState.roster);
        setText('royale-player-label', `${live[0]} (You)`);
        setText('royale-rival-a-label', live[1]);
        setText('royale-rival-b-label', live[2]);

        royaleState.player = createRunner('royale-player', {
            name: live[0],
            onScore: (score) => setText('royale-player-score', score),
            onCrash: () => onRoyaleCrash(royaleState.player, 'royale-player-state')
        });
        triggerBotStart(royaleState.player);

        const botControls = buildControls([], []);
        const rivalA = createRunner('royale-rival-a', {
            name: live[1],
            controls: botControls,
            onScore: (score) => setText('royale-rival-a-score', score),
            onCrash: () => onRoyaleCrash(rivalA, 'royale-rival-a-state')
        });
        const rivalB = createRunner('royale-rival-b', {
            name: live[2],
            controls: botControls,
            onScore: (score) => setText('royale-rival-b-score', score),
            onCrash: () => onRoyaleCrash(rivalB, 'royale-rival-b-state')
        });
        royaleState.rivals = [rivalA, rivalB];
        if (rivalA) rivalA.stopListening();
        if (rivalB) rivalB.stopListening();
        attachBotBrain(rivalA, 0.9);
        attachBotBrain(rivalB, 0.82);

        royaleState.minis = [];
        minis.forEach((name, i) => {
            royaleState.minis.push(createMiniRunner(name, 0.72 + i * 0.03, botControls, i));
        });
        royaleState.alive = 1 + royaleState.rivals.length + royaleState.minis.length;
        updateAliveBadge();
    };

    const switchMode = (mode) => {
        activeMode = mode;
        document.querySelectorAll('.mode-pane').forEach(p => p.classList.toggle('active', p.id === 'pane-' + mode));
        document.querySelectorAll('.tab-buttons button').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
        setRunnerActive(singleRunner, false);
        localRunners.forEach(r => setRunnerActive(r, false));
        setRunnerActive(royaleState.player, false);
        clearLocalConfirm();
        if (mode === 'single') {
            tearDownRoyale();
            if (!singleRunner) resetSingle();
            setRunnerActive(singleRunner, true);
        }
        if (mode === 'local') {
            tearDownRoyale();
            if (localRunners.length === 0) resetLocal(); else waitForLocalConfirm();
        }
        if (mode === 'royale') {
            startRoyale();
            setRunnerActive(royaleState.player, true);
        }
    };

    const bindUI = () => {
        document.querySelectorAll('.tab-buttons button').forEach(btn => {
            btn.addEventListener('click', () => switchMode(btn.dataset.mode));
        });
        document.getElementById('single-reset')?.addEventListener('click', resetSingle);
        document.getElementById('local-reset')?.addEventListener('click', resetLocal);
        document.getElementById('royale-start')?.addEventListener('click', () => startRoyale());
        document.getElementById('create-room')?.addEventListener('click', () => startRoyale({ quick: false }));
        document.getElementById('join-room')?.addEventListener('click', () => startRoyale({ quick: false }));
        document.getElementById('royale-quick')?.addEventListener('click', () => startRoyale({ quick: true }));
    };

    document.addEventListener('DOMContentLoaded', () => {
        bindUI();
        resetSingle();
        switchMode('single');
    });
})();
