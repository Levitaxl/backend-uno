const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
// Creamos el servidor de WebSockets nativos
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- LÓGICA DEL JUEGO UNO ---
let players = []; // { ws, id, name, hand: [] }
let deck = [];
let discardPile = [];
let turnIndex = 0;
let gameStarted = false;

function createDeck() {
    const colors = ['Rojo', 'Amarillo', 'Verde', 'Azul'];
    const values = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    let newDeck = [];
    for (let color of colors) {
        for (let value of values) {
            newDeck.push({ color, value });
            if (value !== '0') newDeck.push({ color, value });
        }
    }
    return newDeck.sort(() => Math.random() - 0.5);
}

function startGame() {
    deck = createDeck();
    discardPile = [deck.pop()];
    gameStarted = true;
    turnIndex = 0;

    players.forEach(player => {
        player.hand = [];
        for (let i = 0; i < 7; i++) player.hand.push(deck.pop());
    });

    updateAllPlayers();
}

function updateAllPlayers() {
    players.forEach((player, index) => {
        sendTo(player.ws, 'gameState', {
            hand: player.hand,
            topCard: discardPile[discardPile.length - 1],
            isMyTurn: index === turnIndex,
            currentTurnName: players[turnIndex].name,
            gameStarted
        });
    });
}

function broadcast(type, data) {
    players.forEach(p => sendTo(p.ws, type, data));
}

// Función auxiliar para enviar JSON de forma limpia
function sendTo(ws, type, data) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, data }));
    }
}

// --- MANEJO DE CONEXIONES WEBSOCKET ---
wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substring(2, 9);
    console.log(`Usuario conectado: ${clientId}`);

    ws.on('message', (message) => {
        const { type, data } = JSON.parse(message);

        if (type === 'joinGame') {
            if (gameStarted) return sendTo(ws, 'errorMsg', 'El juego ya empezó.');
            if (players.length >= 4) return sendTo(ws, 'errorMsg', 'Sala llena.');

            players.push({ ws, id: clientId, name: data || `Jugador ${players.length + 1}`, hand: [] });
            
            if (players.length === 4) {
                startGame();
            } else {
                broadcast('waitingRoom', players.map(p => p.name));
            }
        }

        if (type === 'playCard') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex !== turnIndex) return;

            const player = players[playerIndex];
            const cardToPlay = player.hand[data]; // data es el index de la carta
            const topCard = discardPile[discardPile.length - 1];

            if (cardToPlay.color === topCard.color || cardToPlay.value === topCard.value) {
                player.hand.splice(data, 1);
                discardPile.push(cardToPlay);

                if (player.hand.length === 0) {
                    broadcast('gameOver', `${player.name} ha ganado el juego!`);
                    gameStarted = false;
                    players = [];
                    return;
                }

                turnIndex = (turnIndex + 1) % players.length;
                updateAllPlayers();
            } else {
                sendTo(ws, 'errorMsg', 'Movimiento inválido.');
            }
        }

        if (type === 'drawCard') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex !== turnIndex) return;

            if (deck.length === 0) {
                const topCard = discardPile.pop();
                deck = discardPile.sort(() => Math.random() - 0.5);
                discardPile = [topCard];
            }

            players[playerIndex].hand.push(deck.pop());
            turnIndex = (turnIndex + 1) % players.length;
            updateAllPlayers();
        }
    });

    ws.on('close', () => {
        console.log(`Usuario desconectado: ${clientId}`);
        players = players.filter(p => p.id !== clientId);
        if (players.length < 2 && gameStarted) {
            broadcast('errorMsg', 'Faltan jugadores. Partida cancelada.');
            gameStarted = false;
            players = [];
        }
    });
});

server.listen(3000, () => console.log('Servidor en http://localhost:3000'));