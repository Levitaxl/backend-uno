const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- LÓGICA DEL JUEGO UNO ---
let players = []; // { ws, id, name, hand: [] }
let deck = [];
let discardPile = [];
let turnIndex = 0;
let gameStarted = false;
let gameDirection = 1; // 1 para derecha/adelante, -1 para izquierda/atrás

// Crear una baraja con cartas especiales
function createDeck() {
    const colors = ['Rojo', 'Amarillo', 'Verde', 'Azul'];
    const normales = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const especiales = ['Bloqueo', 'CambioSentido', '+2'];
    let newDeck = [];

    for (let color of colors) {
        // Cartas Numéricas
        for (let valor of normales) {
            newDeck.push({ color, value: valor });
            if (valor !== '0') newDeck.push({ color, value: valor });
        }
        // Especiales de color (Bloqueo, Reversa, +2)
        for (let esp of especiales) {
            newDeck.push({ color, value: esp });
            newDeck.push({ color, value: esp });
        }
    }

    // Cartas Comodín (+4) - Son negras/comodines, aquí las llamamos 'Especial'
    for (let i = 0; i < 4; i++) {
        newDeck.push({ color: 'Comodín', value: '+4' });
    }

    return newDeck.sort(() => Math.random() - 0.5);
}

function startGame() {
    deck = createDeck();
    discardPile = [];
    gameStarted = true;
    turnIndex = 0;
    gameDirection = 1;

    // Asegurar que la primera carta de la mesa NO sea un +4 para no romper el inicio
    let firstCard = deck.pop();
    while (firstCard.value === '+4') {
        deck.unshift(firstCard);
        firstCard = deck.pop();
    }
    discardPile.push(firstCard);

    // Repartir 7 cartas
    players.forEach(player => {
        player.hand = [];
        for (let i = 0; i < 7; i++) player.hand.push(deck.pop());
    });

    updateAllPlayers();
}

// Función para avanzar el turno respetando la dirección
function avanzarTurno(cantidad = 1) {
    turnIndex = (turnIndex + (cantidad * gameDirection) + players.length) % players.length;
}

// Hacer que un jugador robe cartas del mazo
function robarCartasAJugador(playerIndex, cantidad) {
    for (let i = 0; i < cantidad; i++) {
        if (deck.length === 0) {
            const topCard = discardPile.pop();
            deck = discardPile.sort(() => Math.random() - 0.5);
            discardPile = [topCard];
        }
        players[playerIndex].hand.push(deck.pop());
    }
}

function updateAllPlayers() {
    players.forEach((player, index) => {
        sendTo(player.ws, 'gameState', {
            hand: player.hand,
            topCard: discardPile[discardPile.length - 1],
            isMyTurn: index === turnIndex,
            currentTurnName: players[turnIndex].name,
            gameStarted,
            direction: gameDirection === 1 ? 'Derecha ➡️' : 'Izquierda ⬅️'
        });
    });
}

function broadcast(type, data) {
    players.forEach(p => sendTo(p.ws, type, data));
}

function sendTo(ws, type, data) {
    if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ type, data }));
    }
}

// --- MANEJO DE WEBSOCKETS ---
wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substring(2, 9);

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
            const cardToPlay = player.hand[data];
            const topCard = discardPile[discardPile.length - 1];

            // VALIDACIÓN: Coincide color, coincide valor, o es un comodín (+4)
            const esComodin = cardToPlay.color === 'Comodín';
            const esValido = esComodin || cardToPlay.color === topCard.color || cardToPlay.value === topCard.value;

            if (esValido) {
                // Si juegas un +4, para simplificar esta versión, toma el color de la carta anterior en la mesa
                if (esComodin) {
                    cardToPlay.color = topCard.color; 
                }

                // Remover de la mano y poner en descarte
                player.hand.splice(data, 1);
                discardPile.push(cardToPlay);

                // Verificar si ganó
                if (player.hand.length === 0) {
                    broadcast('gameOver', `${player.name} ha ganado el juego!`);
                    gameStarted = false;
                    players = [];
                    return;
                }

                // --- APLICAR EFECTOS DE LAS CARTAS ---
                let saltarSiguiente = false;

                if (cardToPlay.value === 'Bloqueo') {
                    saltarSiguiente = true;
                } 
                else if (cardToPlay.value === 'CambioSentido') {
                    if (players.length === 2) {
                        // En partidas de 2 jugadores, el cambio de sentido actúa como un bloqueo
                        saltarSiguiente = true;
                    } else {
                        gameDirection *= -1; // Invierte la dirección: 1 a -1 o viceversa
                    }
                } 
                else if (cardToPlay.value === '+2') {
                    // Calculamos quién es el siguiente afectado antes de cambiar el turno real
                    const siguienteIndex = (turnIndex + gameDirection + players.length) % players.length;
                    robarCartasAJugador(siguienteIndex, 2);
                    saltarSiguiente = true; // El que roba pierde su turno
                } 
                else if (cardToPlay.value === '+4') {
                    const siguienteIndex = (turnIndex + gameDirection + players.length) % players.length;
                    robarCartasAJugador(siguienteIndex, 4);
                    saltarSiguiente = true; // El que roba 4 pierde su turno
                }

                // Avanzar el turno
                avanzarTurno(saltarSiguiente ? 2 : 1);
                updateAllPlayers();
            } else {
                sendTo(ws, 'errorMsg', 'Movimiento inválido. Debe coincidir color o valor.');
            }
        }

        if (type === 'drawCard') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex !== turnIndex) return;

            robarCartasAJugador(playerIndex, 1);
            
            // Pasar turno normal al robar
            avanzarTurno(1);
            updateAllPlayers();
        }
    });

    ws.on('close', () => {
        players = players.filter(p => p.id !== clientId);
        if (players.length < 2 && gameStarted) {
            broadcast('errorMsg', 'Faltan jugadores. Partida cancelada.');
            gameStarted = false;
            players = [];
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));