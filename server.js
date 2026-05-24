// server.js — WordDuel 2-Player Hangman
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
const GRACE_SECONDS = 45;
const MAX_WRONG = 6;
const MAX_ROUNDS = 6;

// ── Room Store ───────────────────────────────
// gameState: 'waiting' | 'setup' | 'playing' | 'round_over' | 'game_over'
const rooms = {};
const gracePending = {};

function generateRoomId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createRoomState() {
    return {
        players: [],          // [{ id, name, score }]
        setterIndex: 0,       // alternates each round
        gameState: 'waiting',
        round: 1,
        totalRoundsPlayed: 0, // counts completed rounds
        // Current round data
        word: null,
        category: null,
        guessedLetters: new Set(),
        wrongCount: 0,
        // Next round / play again readiness — tracks socket IDs
        nextRoundReady: new Set(),
        playAgainReady: new Set(),
    };
}

// Build the display pattern: revealed chars + '_' for hidden
function buildPattern(word, guessedLetters) {
    return word.split('').map(c => guessedLetters.has(c) ? c : '_');
}

// Count how many positions in the word have been revealed
function countRevealedPositions(word, guessedLetters) {
    return word.split('').filter(c => guessedLetters.has(c)).length;
}

// ── Helpers ──────────────────────────────────
function getSetter(room) { return room.players[room.setterIndex]; }
function getGuesser(room) { return room.players[room.setterIndex === 0 ? 1 : 0]; }
function getGuesserName(room) { return getGuesser(room).name; }

function emitTurnUpdate(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    io.to(roomId).emit('turnUpdate', { guesserSocketId: getGuesser(room).id });
}

function startSetupPhase(roomId) {
    const room = rooms[roomId];
    if (!room) return;
    room.gameState = 'setup';
    room.word = null;
    room.category = null;
    room.guessedLetters = new Set();
    room.wrongCount = 0;
    room.pausedForDisconnect = false;
    room.nextRoundReady.clear();
    room.playAgainReady.clear();

    const setter = getSetter(room);
    const guesser = getGuesser(room);

    io.to(roomId).emit('playersInfo', {
        player1: room.players[0].name,
        player2: room.players[1].name,
    });
    io.to(roomId).emit('setupRound', {
        setter: setter.name,
        guesser: guesser.name,
        round: room.round,
        roundNumber: room.totalRoundsPlayed,
        maxRounds: MAX_ROUNDS,
    });
    io.to(roomId).emit('updateStatus', `Round ${room.round}: ${setter.name} is picking a word…`);
}

function endRound(roomId, outcome) {
    const room = rooms[roomId];
    if (!room) return;
    room.gameState = 'round_over';
    room.totalRoundsPlayed++;
    room.nextRoundReady.clear();
    room.playAgainReady.clear();

    const setter = getSetter(room);
    const guesser = getGuesser(room);

    // Award point
    let winner = null;
    if (outcome === 'guesser_wins') { guesser.score++; winner = guesser.name; }
    else if (outcome === 'setter_wins') { setter.score++; winner = setter.name; }

    const scores = {
        p1: room.players[0].score,
        p2: room.players[1].score,
    };

    const isLastRound = room.totalRoundsPlayed >= MAX_ROUNDS;

    io.to(roomId).emit('roundOver', {
        winner,
        word: room.word,
        outcome,
        newScores: scores,
        setterName: setter.name,
        roundNumber: room.totalRoundsPlayed,
        maxRounds: MAX_ROUNDS,
        isLastRound,
    });

    if (isLastRound) {
        let gameWinner = null;
        if (room.players[0].score > room.players[1].score) gameWinner = room.players[0].name;
        else if (room.players[1].score > room.players[0].score) gameWinner = room.players[1].name;

        // Small delay so clients receive roundOver before gameOver
        setTimeout(() => {
            if (!rooms[roomId]) return;
            io.to(roomId).emit('gameOver', {
                gameWinner,
                scores,
                p1Name: room.players[0].name,
                p2Name: room.players[1].name,
            });
            room.gameState = 'game_over';
        }, 400);
    }

    console.log(`Room ${roomId}: round over — ${outcome}, word: ${room.word}`);
}

// ── Connection Handler ───────────────────────
io.on('connection', (socket) => {
    console.log(`Connected: ${socket.id}`);

    // ── Reconnect ──────────────────────────────
    socket.on('rejoinRoom', ({ roomId, playerName }) => {
        const room = rooms[roomId];
        if (!room) { socket.emit('errorMsg', 'Room no longer exists.'); return; }

        const player = room.players.find(p => p.name === playerName);
        if (!player) { socket.emit('errorMsg', 'Could not find your slot.'); return; }

        // Cancel grace timer
        const grace = gracePending[player.id];
        if (grace) { clearTimeout(grace.graceTimer); delete gracePending[player.id]; }

        // FIX: Update nextRoundReady to use new socket ID if old one was recorded
        if (room.nextRoundReady.has(player.id)) {
            room.nextRoundReady.delete(player.id);
            room.nextRoundReady.add(socket.id);
        }
        if (room.playAgainReady.has(player.id)) {
            room.playAgainReady.delete(player.id);
            room.playAgainReady.add(socket.id);
        }

        const oldId = player.id;
        player.id = socket.id;
        socket.roomId = roomId;
        socket.join(roomId);

        console.log(`${playerName} rejoined room ${roomId} (${oldId} → ${socket.id})`);

        const setter = room.players[room.setterIndex];

        // Always re-send playersInfo so chips are correct after reconnect
        socket.emit('playersInfo', {
            player1: room.players[0].name,
            player2: room.players[1].name,
        });

        socket.emit('rejoinSuccess', {
            gameState: room.gameState,
            player1: room.players[0]?.name,
            player2: room.players[1]?.name,
            isSetter: setter?.name === playerName,
            roundNumber: room.totalRoundsPlayed,
            maxRounds: MAX_ROUNDS,
        });

        if (room.gameState === 'playing' && room.pausedForDisconnect) {
            room.pausedForDisconnect = false;
            io.to(roomId).emit('updateStatus', `${playerName} reconnected. Game resumed!`);
            emitTurnUpdate(roomId);
        } else {
            socket.emit('updateStatus', `Welcome back, ${playerName}!`);
        }

        if (room.gameState === 'playing') {
            // Re-sync full board state for rejoining player
            const pattern = buildPattern(room.word, room.guessedLetters);
            const correctCount = countRevealedPositions(room.word, room.guessedLetters);
            socket.emit('gameStart', {
                pattern,
                category: room.category,
                setter: room.players[room.setterIndex].name,
            });
            socket.emit('letterResult', {
                letter: null,
                correct: null,
                pattern,
                wrongCount: room.wrongCount,
                correctCount,
                flashPart: false,
                guessedLetters: [...room.guessedLetters],
            });
            emitTurnUpdate(roomId);
        }

        // FIX: Re-sync round_over state with correct ready count and player's own status
        if (room.gameState === 'round_over') {
            const youReady = room.nextRoundReady.has(socket.id);
            socket.emit('nextRoundReadyCount', {
                count: room.nextRoundReady.size,
                total: 2,
                youReady,
            });
        }

        // Re-sync game_over play-again state
        if (room.gameState === 'game_over') {
            const youReady = room.playAgainReady.has(socket.id);
            socket.emit('playAgainReadyCount', {
                count: room.playAgainReady.size,
                total: 2,
                youReady,
            });
        }
    });

    // ── Create Room ────────────────────────────
    socket.on('createRoom', (name) => {
        if (!name?.trim()) { socket.emit('errorMsg', 'Enter a valid name.'); return; }
        const roomId = generateRoomId();
        rooms[roomId] = createRoomState();
        rooms[roomId].players.push({ id: socket.id, name: name.trim(), score: 0 });
        socket.join(roomId);
        socket.roomId = roomId;
        socket.emit('roomCreated', { roomId });
        socket.emit('updateStatus', `Room ${roomId} created. Waiting for opponent…`);
        console.log(`Room ${roomId} created by ${name}`);
    });

    // ── Join Room ──────────────────────────────
    socket.on('joinRoom', ({ name, roomId }) => {
        if (!name?.trim()) { socket.emit('errorMsg', 'Enter a valid name.'); return; }
        const cleanId = roomId.trim().toUpperCase();
        const room = rooms[cleanId];
        if (!room) { socket.emit('errorMsg', `Room "${cleanId}" does not exist.`); return; }
        if (room.players.length >= 2) { socket.emit('errorMsg', 'Room is full.'); return; }
        if (room.gameState !== 'waiting') { socket.emit('errorMsg', 'Game already in progress.'); return; }
        if (room.players.some(p => p.name === name.trim())) {
            socket.emit('errorMsg', 'That name is already taken in this room.'); return;
        }

        room.players.push({ id: socket.id, name: name.trim(), score: 0 });
        socket.join(cleanId);
        socket.roomId = cleanId;

        io.to(cleanId).emit('playersInfo', {
            player1: room.players[0].name,
            player2: room.players[1].name,
        });
        io.to(cleanId).emit('updateStatus', 'Both players joined! Starting first round…');
        startSetupPhase(cleanId);
    });

    // ── Set Word (Setter) ──────────────────────
    socket.on('setWord', ({ word, category }) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'setup') return;

        const setter = room.players[room.setterIndex];
        if (setter.id !== socket.id) { socket.emit('errorMsg', 'You are not the setter!'); return; }
        if (!word || !/^[A-Z]{3,14}$/.test(word)) { socket.emit('errorMsg', 'Invalid word. Letters only, 3–14 characters.'); return; }

        room.word = word.toUpperCase();
        room.category = category?.trim() || null;
        room.guessedLetters = new Set();
        room.wrongCount = 0;
        room.gameState = 'playing';

        console.log(`Room ${roomId}: word set to "${room.word}" by ${setter.name}`);

        const pattern = buildPattern(room.word, room.guessedLetters);
        io.to(roomId).emit('gameStart', { pattern, category: room.category, setter: setter.name });
        io.to(roomId).emit('updateStatus', `Game on! ${getGuesserName(room)} is guessing…`);
        emitTurnUpdate(roomId);
    });

    // ── Guess Letter (Guesser) ─────────────────
    socket.on('guessLetter', (letter) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'playing') return;
        if (room.pausedForDisconnect) { socket.emit('errorMsg', 'Game is paused — waiting for opponent.'); return; }

        const guesser = getGuesser(room);
        if (guesser.id !== socket.id) { socket.emit('errorMsg', "It's not your turn!"); return; }
        if (!letter || !/^[A-Z]$/.test(letter)) { socket.emit('errorMsg', 'Invalid letter.'); return; }
        if (room.guessedLetters.has(letter)) { socket.emit('errorMsg', 'Already guessed!'); return; }

        room.guessedLetters.add(letter);
        const correct = room.word.includes(letter);

        if (!correct) room.wrongCount++;

        const pattern = buildPattern(room.word, room.guessedLetters);
        // FIX: correctCount is always derived from the pattern — no drifting accumulation
        const correctCount = countRevealedPositions(room.word, room.guessedLetters);

        io.to(roomId).emit('letterResult', {
            letter,
            correct,
            pattern,
            wrongCount: room.wrongCount,
            correctCount,
            flashPart: !correct,
            guessedLetters: [...room.guessedLetters],
        });

        // Check win conditions
        const wordSolved = pattern.every(c => c !== '_');
        const hanged = room.wrongCount >= MAX_WRONG;

        if (wordSolved) endRound(roomId, 'guesser_wins');
        else if (hanged) endRound(roomId, 'setter_wins');
    });

    // ── Next Round (both must confirm) ─────────
    socket.on('nextRound', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'round_over') return;

        // Ignore duplicate clicks from same player
        if (room.nextRoundReady.has(socket.id)) return;

        room.nextRoundReady.add(socket.id);
        const count = room.nextRoundReady.size;
        const total = room.players.length;

        console.log(`Room ${roomId}: nextRound confirmed ${count}/${total}`);

        // Tell everyone the updated count; mark the clicker as ready
        io.to(roomId).emit('nextRoundReadyCount', { count, total, youReady: false });
        socket.emit('nextRoundReadyCount', { count, total, youReady: true });

        if (count >= total) {
            room.nextRoundReady.clear();
            room.round++;
            // Swap setter/guesser each round
            room.setterIndex = room.setterIndex === 0 ? 1 : 0;
            startSetupPhase(roomId);
        }
    });

    // FIX: Play Again now requires both players to confirm (mirrors nextRound pattern)
    socket.on('playAgain', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'game_over') return;

        if (room.playAgainReady.has(socket.id)) return;

        room.playAgainReady.add(socket.id);
        const count = room.playAgainReady.size;
        const total = room.players.length;

        console.log(`Room ${roomId}: playAgain confirmed ${count}/${total}`);

        io.to(roomId).emit('playAgainReadyCount', { count, total, youReady: false });
        socket.emit('playAgainReadyCount', { count, total, youReady: true });

        if (count >= total) {
            room.round = 1;
            room.totalRoundsPlayed = 0;
            room.setterIndex = 0;
            room.gameState = 'waiting';
            room.word = null;
            room.category = null;
            room.guessedLetters = new Set();
            room.wrongCount = 0;
            room.pausedForDisconnect = false;
            room.nextRoundReady.clear();
            room.playAgainReady.clear();
            room.players.forEach(p => { p.score = 0; });

            io.to(roomId).emit('clearBoard');
            io.to(roomId).emit('gameStateUpdate', { state: 'waiting', reason: 'play_again' });
            io.to(roomId).emit('updateStatus', 'New match! Starting fresh…');
        }
    });

    // ── Disconnect ──────────────────────────────
    socket.on('disconnect', () => {
        console.log(`Disconnected: ${socket.id}`);
        const roomId = socket.roomId;
        if (!roomId || !rooms[roomId]) return;

        const room = rooms[roomId];
        const player = room.players.find(p => p.id === socket.id);
        if (!player) return;

        const isActiveGame = room.players.length === 2 && room.gameState !== 'waiting';

        if (isActiveGame) {
            room.pausedForDisconnect = true;

            io.to(roomId).emit('playerDisconnected', {
                playerName: player.name,
                graceSeconds: GRACE_SECONDS,
            });
            io.to(roomId).emit('updateStatus', `⚠️ ${player.name} disconnected. Waiting ${GRACE_SECONDS}s…`);

            gracePending[socket.id] = {
                roomId,
                playerName: player.name,
                graceTimer: setTimeout(() => {
                    delete gracePending[socket.id];
                    if (!rooms[roomId]) return;
                    room.players = room.players.filter(p => p.name !== player.name);
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        room.gameState = 'waiting';
                        room.pausedForDisconnect = false;
                        room.nextRoundReady.clear();
                        room.playAgainReady.clear();
                        io.to(roomId).emit('clearBoard');
                        io.to(roomId).emit('gameStateUpdate', { state: 'waiting', reason: 'disconnect' });
                        io.to(roomId).emit('updateStatus', `${player.name} didn't return. Waiting for new player…`);
                    }
                }, GRACE_SECONDS * 1000),
            };
        } else {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) {
                delete rooms[roomId];
            } else {
                room.gameState = 'waiting';
                room.nextRoundReady.clear();
                room.playAgainReady.clear();
                io.to(roomId).emit('clearBoard');
                io.to(roomId).emit('gameStateUpdate', { state: 'waiting', reason: 'disconnect' });
                io.to(roomId).emit('updateStatus', 'Opponent left. Waiting for new player…');
            }
        }
    });
});

// ── Start Server ─────────────────────────────
server.listen(PORT, () => {
    console.log(`WordDuel server running on http://localhost:${PORT}`);
});
