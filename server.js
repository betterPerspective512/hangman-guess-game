// server.js — WordDuel 2-Player Hangman
const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

const GRACE_SECONDS = 45;
const MAX_WRONG = 6;

// ── Room Store ───────────────────────────────
// gameState: 'waiting' | 'setup' | 'playing' | 'round_over'
const rooms = {};
const gracePending = {};

function generateRoomId() {
    return crypto.randomBytes(3).toString('hex').toUpperCase();
}

function createRoom() {
    return {
        players: [],          // [{ id, name, score }]
        setterIndex: 0,       // alternates each round
        gameState: 'waiting',
        round: 1,
        // Current round data
        word: null,
        category: null,
        guessedLetters: new Set(),
        wrongCount: 0,
        correctCount: 0,
        pausedForDisconnect: false,
    };
}

// Build the display pattern: revealed chars + '_' for hidden
function buildPattern(word, guessedLetters) {
    return word.split('').map(c => guessedLetters.has(c) ? c : '_');
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

        const oldId = player.id;
        player.id = socket.id;
        socket.roomId = roomId;
        socket.join(roomId);

        console.log(`${playerName} rejoined room ${roomId} (${oldId} → ${socket.id})`);

        const setter = room.players[room.setterIndex];
        socket.emit('rejoinSuccess', {
            gameState: room.gameState,
            player1: room.players[0]?.name,
            player2: room.players[1]?.name,
            isSetter: setter?.name === playerName,
        });

        if (room.gameState === 'playing' && room.pausedForDisconnect) {
            room.pausedForDisconnect = false;
            io.to(roomId).emit('updateStatus', `${playerName} reconnected. Game resumed!`);
            emitTurnUpdate(roomId);
        } else {
            socket.emit('updateStatus', `Welcome back, ${playerName}!`);
        }

        if (room.gameState === 'playing') {
            // Re-sync board state
            const pattern = buildPattern(room.word, room.guessedLetters);
            socket.emit('gameStart', { pattern, category: room.category, setter: room.players[room.setterIndex].name });
            socket.emit('letterResult', {
                letter: null,
                correct: null,
                pattern,
                wrongCount: room.wrongCount,
                correctCount: room.correctCount,
                flashPart: false
            });
            emitTurnUpdate(roomId);
        }
    });

    // ── Create Room ────────────────────────────
    socket.on('createRoom', (name) => {
        if (!name?.trim()) { socket.emit('errorMsg', 'Enter a valid name.'); return; }
        const roomId = generateRoomId();
        rooms[roomId] = createRoom();
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
        if (room.gameState !== 'waiting') { socket.emit('errorMsg', 'Game already started.'); return; }

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
        if (!word || !/^[A-Z]{3,14}$/.test(word)) { socket.emit('errorMsg', 'Invalid word.'); return; }

        room.word = word.toUpperCase();
        room.category = category?.trim() || null;
        room.guessedLetters = new Set();
        room.wrongCount = 0;
        room.correctCount = 0;
        room.gameState = 'playing';

        console.log(`Room ${roomId}: word set to "${room.word}" by ${setter.name}`);

        const pattern = buildPattern(room.word, room.guessedLetters);
        io.to(roomId).emit('gameStart', { pattern, category: room.category, setter: setter.name });
        io.to(roomId).emit('updateStatus', `Game started! ${getGuesserName(room)} is guessing.`);
        emitTurnUpdate(roomId);
    });

    // ── Guess Letter (Guesser) ─────────────────
    socket.on('guessLetter', (letter) => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'playing') return;

        const guesser = getGuesser(room);
        if (guesser.id !== socket.id) { socket.emit('errorMsg', "It's not your turn!"); return; }
        if (!letter || !/^[A-Z]$/.test(letter)) { socket.emit('errorMsg', 'Invalid letter.'); return; }
        if (room.guessedLetters.has(letter)) { socket.emit('errorMsg', 'Already guessed!'); return; }

        room.guessedLetters.add(letter);
        const correct = room.word.includes(letter);

        if (correct) {
            room.correctCount += room.word.split('').filter(c => c === letter).length;
        } else {
            room.wrongCount++;
        }

        const pattern = buildPattern(room.word, room.guessedLetters);
        const totalLetters = new Set(room.word.split('')).size;

        io.to(roomId).emit('letterResult', {
            letter,
            correct,
            pattern,
            wrongCount: room.wrongCount,
            correctCount: pattern.filter(c => c !== '_').length,
            flashPart: !correct
        });

        // Check win conditions
        const wordSolved = pattern.every(c => c !== '_');
        const hanged = room.wrongCount >= MAX_WRONG;

        if (wordSolved) {
            endRound(roomId, 'guesser_wins');
        } else if (hanged) {
            endRound(roomId, 'setter_wins');
        }
        // else continue — same guesser's turn (setter doesn't get turns in classic hangman)
    });

    // ── Next Round ─────────────────────────────
    socket.on('nextRound', () => {
        const roomId = socket.roomId;
        const room = rooms[roomId];
        if (!room || room.gameState !== 'round_over') return;

        room.round++;
        // Swap setter/guesser
        room.setterIndex = room.setterIndex === 0 ? 1 : 0;
        startSetupPhase(roomId);
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
            clearInterval(room.timerInterval);
            room.pausedForDisconnect = true;

            io.to(roomId).emit('playerDisconnected', { playerName: player.name, graceSeconds: GRACE_SECONDS });
            io.to(roomId).emit('updateStatus', `⚠️ ${player.name} disconnected. Waiting ${GRACE_SECONDS}s…`);

            gracePending[socket.id] = {
                roomId, playerName: player.name,
                graceTimer: setTimeout(() => {
                    delete gracePending[socket.id];
                    if (!rooms[roomId]) return;
                    room.players = room.players.filter(p => p.name !== player.name);
                    if (room.players.length === 0) {
                        delete rooms[roomId];
                    } else {
                        room.gameState = 'waiting';
                        room.pausedForDisconnect = false;
                        io.to(roomId).emit('clearBoard');
                        io.to(roomId).emit('gameStateUpdate', 'waiting');
                        io.to(roomId).emit('updateStatus', `${player.name} didn't return. Waiting for new player…`);
                    }
                }, GRACE_SECONDS * 1000)
            };
        } else {
            room.players = room.players.filter(p => p.id !== socket.id);
            if (room.players.length === 0) { delete rooms[roomId]; }
            else {
                room.gameState = 'waiting';
                io.to(roomId).emit('clearBoard');
                io.to(roomId).emit('gameStateUpdate', 'waiting');
                io.to(roomId).emit('updateStatus', 'Opponent left. Waiting for new player…');
            }
        }
    });
});

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
    room.correctCount = 0;
    room.pausedForDisconnect = false;

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
    });
    io.to(roomId).emit('updateStatus', `Round ${room.round}: ${setter.name} is picking a word…`);
}

function endRound(roomId, outcome) {
    const room = rooms[roomId];
    if (!room) return;
    room.gameState = 'round_over';

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

    io.to(roomId).emit('roundOver', {
        winner,
        word: room.word,
        outcome,
        newScores: scores,
        setterName: setter.name,
    });
    console.log(`Room ${roomId}: round over — ${outcome}, word: ${room.word}`);
}

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
    console.log(`WordDuel server running at http://localhost:${PORT}`);
});
