const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

// --- LÓGICA DEL JUEGO UNO ---
let players = []; 
let deck = [];
let discardPile = [];
let turnIndex = 0;
let gameStarted = false;
let gameDirection = 1; 

function createDeck() {
    const colors = ['Rojo', 'Amarillo', 'Verde', 'Azul'];
    const normales = ['0', '1', '2', '3', '4', '5', '6', '7', '8', '9'];
    const especiales = ['Bloqueo', 'CambioSentido', '+2'];
    let newDeck = [];

    for (let color of colors) {
        for (let valor of normales) {
            newDeck.push({ color, value: valor });
            if (valor !== '0') newDeck.push({ color, value: valor });
        }
        for (let esp of especiales) {
            newDeck.push({ color, value: esp });
            newDeck.push({ color, value: esp });
        }
    }
    for (let i = 0; i < 4; i++) {
        newDeck.push({ color: 'Comodín', value: 'CambiaColor' });
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

    let firstCard = deck.pop();
    while (firstCard.color === 'Comodín') {
        deck.unshift(firstCard);
        firstCard = deck.pop();
    }
    discardPile.push(firstCard);

    players.forEach(player => {
        player.hand = [];
        for (let i = 0; i < 7; i++) player.hand.push(deck.pop());
    });

    updateAllPlayers(`¡El juego ha comenzado! Carta inicial: ${firstCard.color} ${firstCard.value}. Turno de ${players[turnIndex].name}.`);
}

function resetGameTotal(mensajeError) {
    // 1. Avisar a todos los que queden conectados el motivo del reinicio
    broadcast('gameOver', mensajeError);
    
    // 2. Resetear todas las variables de estado al punto inicial
    deck = [];
    discardPile = [];
    turnIndex = 0;
    gameStarted = false;
    gameDirection = 1;
    players = []; // Vaciamos la lista de jugadores para obligar un nuevo login
    console.log("El juego ha sido reiniciado por completo debido a una desconexión.");
}

function avanzarTurno(cantidad = 1) {
    turnIndex = (turnIndex + (cantidad * gameDirection) + players.length) % players.length;
}

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

function updateAllPlayers(actionLog = "") {
    players.forEach((player, index) => {
        sendTo(player.ws, 'gameState', {
            hand: player.hand,
            topCard: discardPile[discardPile.length - 1],
            isMyTurn: index === turnIndex,
            currentTurnName: players[turnIndex].name,
            gameStarted,
            direction: gameDirection === 1 ? 'Derecha ➡️' : 'Izquierda ⬅️',
            log: actionLog
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
    let myName = ""; // Guardamos el nombre asignado a este socket de forma local

    ws.on('message', (message) => {
        const { type, data } = JSON.parse(message);

        if (type === 'joinGame') {
            if (gameStarted) return sendTo(ws, 'errorMsg', 'El juego ya empezó.');
            if (players.length >= 4) return sendTo(ws, 'errorMsg', 'Sala llena.');

            myName = data || `Jugador ${players.length + 1}`;
            players.push({ ws, id: clientId, name: myName, hand: [] });
            
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
            const cardIndex = data.index;
            const chosenColor = data.chosenColor; 
            const cardToPlay = player.hand[cardIndex];
            const topCard = discardPile[discardPile.length - 1];

            const esComodin = cardToPlay.color === 'Comodín' || cardToPlay.isComodinReal; 
            const esValido = esComodin || cardToPlay.color === topCard.color || cardToPlay.value === topCard.value;

            if (esValido) {
                let logMsg = `${player.name} jugó ${cardToPlay.color === 'Comodín' ? cardToPlay.value : cardToPlay.color + ' ' + cardToPlay.value}.`;

                if (cardToPlay.color === 'Comodín') {
                    cardToPlay.isComodinReal = true; 
                    cardToPlay.color = chosenColor; 
                    logMsg += ` Cambió el color a ${chosenColor}.`;
                }

                player.hand.splice(cardIndex, 1);
                discardPile.push(cardToPlay);

                if (player.hand.length === 0) {
                    broadcast('gameOver', `¡${player.name} ha ganado el juego!`);
                    gameStarted = false;
                    players = [];
                    return;
                }

                let saltarSiguiente = false;
                const siguienteIndex = (turnIndex + gameDirection + players.length) % players.length;
                const siguienteJugador = players[siguienteIndex];

                if (cardToPlay.value === 'Bloqueo') {
                    saltarSiguiente = true;
                    logMsg += ` ¡Se saltó el turno de ${siguienteJugador.name}!`;
                } 
                else if (cardToPlay.value === 'CambioSentido') {
                    if (players.length === 2) {
                        saltarSiguiente = true;
                        logMsg += ` ¡Se saltó el turno de ${siguienteJugador.name}!`;
                    } else {
                        gameDirection *= -1;
                        logMsg += ` Se invirtió el sentido del juego.`;
                    }
                } 
                else if (cardToPlay.value === '+2') {
                    robarCartasAJugador(siguienteIndex, 2);
                    saltarSiguiente = true;
                    logMsg += ` ${siguienteJugador.name} roba 2 cartas y se salta su turno.`;
                } 
                else if (cardToPlay.value === '+4') {
                    robarCartasAJugador(siguienteIndex, 4);
                    saltarSiguiente = true;
                    logMsg += ` ${siguienteJugador.name} roba 4 cartas y se salta su turno.`;
                }

                avanzarTurno(saltarSiguiente ? 2 : 1);
                logMsg += ` Ahora es el turno de ${players[turnIndex].name}.`;

                updateAllPlayers(logMsg);
            } else {
                sendTo(ws, 'errorMsg', 'Movimiento inválido. Debe coincidir color o valor.');
            }
        }

        if (type === 'drawCard') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex !== turnIndex) return;

            robarCartasAJugador(playerIndex, 1);
            const player = players[playerIndex];
            avanzarTurno(1);
            updateAllPlayers(`${player.name} robó una carta. Turno de ${players[turnIndex].name}.`);
        }
    });

    // --- DETECTAR CUANDO ALGUIEN SE SALE / CIERRA LA PANTALLA ---
    ws.on('close', () => {
        console.log(`Usuario desconectado: ${clientId} (${myName || 'Sin registrar'})`);

        // Si el juego ya había comenzado, la salida de cualquiera arruina la partida en curso
        if (gameStarted) {
            resetGameTotal(`Partida cancelada: El jugador "${myName || 'Un usuario'}" abandonó la sala. El juego se reiniciará para todos.`);
        } else {
            // Si aún estaban en la sala de espera, simplemente lo sacamos de la lista sin reiniciar todo
            players = players.filter(p => p.id !== clientId);
            broadcast('waitingRoom', players.map(p => p.name));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));