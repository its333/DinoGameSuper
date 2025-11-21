const WebSocket = require('ws');

const wss = new WebSocket.Server({ port: 8080 });

const rooms = {};
const QUICK_PLAY_ROOM = 'quickplay_lobby';

console.log('Dino Royale Server started on port 8080');

function broadcastToRoom(roomId, message) {
    if (rooms[roomId]) {
        rooms[roomId].forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify(message));
            }
        });
    }
}

function createRoom(roomId) {
    if (!rooms[roomId]) {
        rooms[roomId] = new Set();
        console.log(`Room created: ${roomId}`);
    }
}

function joinRoom(ws, roomId, playerName) {
    // Leave current room if any
    if (ws.roomId) {
        leaveRoom(ws);
    }

    createRoom(roomId);
    rooms[roomId].add(ws);
    ws.roomId = roomId;
    ws.playerName = playerName || 'Anonymous';

    console.log(`${ws.playerName} joined room ${roomId}`);

    // Broadcast updated roster
    broadcastRoster(roomId);

    // Check for Quick Play start
    if (roomId === QUICK_PLAY_ROOM && rooms[roomId].size >= 2) {
        startQuickPlayCountdown(roomId);
    }
}

function leaveRoom(ws) {
    if (ws.roomId && rooms[ws.roomId]) {
        rooms[ws.roomId].delete(ws);
        console.log(`${ws.playerName} left room ${ws.roomId}`);

        broadcastRoster(ws.roomId);

        if (rooms[ws.roomId].size === 0) {
            delete rooms[ws.roomId];
            console.log(`Room destroyed: ${ws.roomId}`);
        }
        ws.roomId = null;
    }
}

function broadcastRoster(roomId) {
    if (!rooms[roomId]) return;
    const roster = Array.from(rooms[roomId]).map(client => ({
        id: client.id,
        name: client.playerName,
        isHost: client === Array.from(rooms[roomId])[0] // First player is host
    }));
    broadcastToRoom(roomId, { type: 'ROSTER_UPDATE', roster });
}

let quickPlayTimer = null;

function startQuickPlayCountdown(roomId) {
    if (quickPlayTimer) return;

    console.log('Starting Quick Play countdown...');
    let count = 10;

    // Broadcast initial countdown
    broadcastToRoom(roomId, { type: 'COUNTDOWN_START', count });

    quickPlayTimer = setInterval(() => {
        count--;
        if (count > 0) {
            broadcastToRoom(roomId, { type: 'COUNTDOWN_UPDATE', count });
        } else {
            clearInterval(quickPlayTimer);
            quickPlayTimer = null;
            startGame(roomId);
        }
    }, 1000);
}

function startGame(roomId) {
    const seed = Date.now();
    console.log(`Starting game in room ${roomId} with seed ${seed}`);
    broadcastToRoom(roomId, { type: 'GAME_START', seed });
}

wss.on('connection', (ws) => {
    ws.id = Math.random().toString(36).substr(2, 9);
    console.log(`New connection: ${ws.id}`);

    ws.on('message', (message) => {
        try {
            const data = JSON.parse(message);

            switch (data.type) {
                case 'JOIN_ROOM':
                    joinRoom(ws, data.roomId, data.playerName);
                    break;
                case 'QUICK_PLAY':
                    joinRoom(ws, QUICK_PLAY_ROOM, data.playerName);
                    break;
                case 'START_GAME':
                    // Only host can start custom rooms
                    if (ws.roomId && rooms[ws.roomId] && rooms[ws.roomId].values().next().value === ws) {
                        startGame(ws.roomId);
                    }
                    break;
                case 'PLAYER_UPDATE':
                    if (ws.roomId) {
                        // Broadcast player state (score, alive/dead) to others
                        rooms[ws.roomId].forEach(client => {
                            if (client !== ws && client.readyState === WebSocket.OPEN) {
                                client.send(JSON.stringify({
                                    type: 'RIVAL_UPDATE',
                                    id: ws.id,
                                    state: data.state
                                }));
                            }
                        });
                    }
                    break;
            }
        } catch (e) {
            console.error('Error processing message:', e);
        }
    });

    ws.on('close', () => {
        leaveRoom(ws);
    });
});
