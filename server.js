const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

app.use(express.static(path.join(__dirname, 'public')));

let players = []; 
let deck = [];
let discardPile = [];
let turnIndex = 0;
let gameStarted = false;
let gameDirection = 1; 
let isPaused = false; 
let forzarOcultarBotonera = false;

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
    isPaused = false;
    forzarOcultarBotonera = false;

    let firstCard = deck.pop();
    while (firstCard.color === 'Comodín') {
        deck.unshift(firstCard);
        firstCard = deck.pop();
    }
    discardPile.push(firstCard);

    players.forEach(player => {
        player.hand = [];
        player.dijoUno = false; 
        for (let i = 0; i < 7; i++) player.hand.push(deck.pop());
    });

    updateAllPlayers(`¡El juego ha comenzado! Carta inicial: ${firstCard.color} ${firstCard.value}. Turno de ${players[turnIndex].name}.`);
}

function resetGameTotal(mensajeError) {
    broadcast('gameOver', mensajeError);
    deck = [];
    discardPile = [];
    turnIndex = 0;
    gameStarted = false;
    gameDirection = 1;
    isPaused = false;
    forzarOcultarBotonera = false;
    players = [];
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
    if (players[playerIndex].hand.length !== 1) {
        players[playerIndex].dijoUno = false;
    }
}

function updateAllPlayers(actionLog = "") {
    const alguienTieneUnaCartaGlobal = forzarOcultarBotonera ? false : players.some(p => p.hand.length === 1);

    players.forEach((player, index) => {
        sendTo(player.ws, 'gameState', {
            hand: player.hand,
            topCard: discardPile[discardPile.length - 1],
            isMyTurn: index === turnIndex && !isPaused, 
            currentTurnName: players[turnIndex].name,
            gameStarted,
            direction: gameDirection === 1 ? 'Derecha ➡️' : 'Izquierda ⬅️',
            log: actionLog,
            isPaused: isPaused,
            dijoUno: player.dijoUno,
            mostrarBotoneraUno: alguienTieneUnaCartaGlobal 
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

wss.on('connection', (ws) => {
    const clientId = Math.random().toString(36).substring(2, 9);
    let myName = ""; 

    ws.on('message', (message) => {
        const { type, data } = JSON.parse(message);

        if (type === 'joinGame') {
            if (gameStarted) return sendTo(ws, 'errorMsg', 'El juego ya empezó.');
            if (players.length >= 4) return sendTo(ws, 'errorMsg', 'Sala llena.');

            myName = data || `Jugador ${players.length + 1}`;
            players.push({ ws, id: clientId, name: myName, hand: [], dijoUno: false });
            
            if (players.length === 4) {
                startGame();
            } else {
                broadcast('waitingRoom', players.map(p => p.name));
            }
        }

        if (type === 'cantarUno') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex === -1 || !gameStarted) return;

            const player = players[playerIndex];
            if (player.hand.length === 1) {
                player.dijoUno = true;
                forzarOcultarBotonera = true;
                updateAllPlayers(`⚡ ¡${player.name} gritó ¡UNO! Justo a tiempo y se protegió.`);
            } else {
                sendTo(ws, 'errorMsg', 'No puedes cantar UNO si no tienes exactamente 1 carta.');
            }
            return;
        }

        if (type === 'cantarCorte') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex === -1 || !gameStarted) return;

            const gritador = players[playerIndex];
            const descuidadoIndex = players.findIndex(p => p.hand.length === 1 && !p.dijoUno);

            if (descuidadoIndex !== -1) {
                const descuidado = players[descuidadoIndex];
                robarCartasAJugador(descuidadoIndex, 4);
                
                forzarOcultarBotonera = true;
                isPaused = true;
                updateAllPlayers(`🔥 ¡${gritador.name} cantó ¡CORTE! a ${descuidado.name} por no decir UNO! Roba 4 cartas.`);
                sendTo(descuidado.ws, 'showPopup', `¡Te atraparon! No cantaste UNO a tiempo. Robas 4 cartas de castigo.`);
            } else {
                sendTo(ws, 'errorMsg', 'Nadie está vulnerable al Corte en este momento.');
            }
            return;
        }

        if (isPaused && type !== 'resolvePopup') return;

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

                if (player.hand.length !== 1) {
                    player.dijoUno = false;
                }

                if (player.hand.length === 1) {
                    forzarOcultarBotonera = false; 
                    logMsg += ` ¡A ${player.name} le queda solo 1 carta!`;
                } else {
                    const nadieTieneUnaCarta = !players.some(p => p.hand.length === 1);
                    if (nadieTieneUnaCarta) forzarOcultarBotonera = false;
                }

                if (player.hand.length === 0) {
                    broadcast('gameOver', `¡${player.name} ha ganado el juego!`);
                    gameStarted = false;
                    players = [];
                    return;
                }

                let saltarSiguiente = false;
                let siguienteIndex = (turnIndex + gameDirection + players.length) % players.length;
                let siguienteJugador = players[siguienteIndex];

                if (cardToPlay.value === 'Bloqueo') {
                    saltarSiguiente = true;
                    isPaused = true; 
                    logMsg += ` ¡Se saltó el turno de ${siguienteJugador.name}!`;
                    sendTo(siguienteJugador.ws, 'showPopup', 'Te han bloqueado. Se salta tu turno.');
                } 
                else if (cardToPlay.value === 'CambioSentido') {
                    if (players.length === 2) {
                        saltarSiguiente = true;
                        isPaused = true;
                        logMsg += ` ¡Se saltó el turno de ${siguienteJugador.name}!`;
                        sendTo(siguienteJugador.ws, 'showPopup', 'Te han bloqueado (Reversa). Se salta tu turno.');
                    } else {
                        gameDirection *= -1;
                        isPaused = true;
                        siguienteIndex = (turnIndex + gameDirection + players.length) % players.length;
                        siguienteJugador = players[siguienteIndex];
                        logMsg += ` Se invirtió el sentido del juego.`;
                        sendTo(siguienteJugador.ws, 'showPopup', `Se cambió la dirección del juego. ¡Te toca reaccionar!`);
                    }
                } 
                else if (cardToPlay.value === '+2') {
                    robarCartasAJugador(siguienteIndex, 2);
                    saltarSiguiente = true;
                    isPaused = true;
                    logMsg += ` ${siguienteJugador.name} roba 2 cartas y se salta su turno.`;
                    sendTo(siguienteJugador.ws, 'showPopup', 'Te tiraron un +2. Robas 2 cartas y pierdes tu turno.');
                } 
                else if (cardToPlay.value === '+4') {
                    robarCartasAJugador(siguienteIndex, 4);
                    saltarSiguiente = true;
                    isPaused = true;
                    logMsg += ` ${siguienteJugador.name} roba 4 cartas y se salta su turno.`;
                    sendTo(siguienteJugador.ws, 'showPopup', 'Te tiraron un +4. Robas 4 cartas y pierdes tu turno.');
                }

                if (isPaused) {
                    avanzarTurno(saltarSiguiente ? 2 : 1);
                    updateAllPlayers(`${logMsg} Esperando que acepte la penalización...`);
                } else {
                    avanzarTurno(1);
                    logMsg += ` Ahora es el turno de ${players[turnIndex].name}.`;
                    updateAllPlayers(logMsg);
                }

            } else {
                sendTo(ws, 'errorMsg', 'Movimiento inválido. Debe coincidir color o valor.');
            }
        }

        if (type === 'drawCard') {
            const playerIndex = players.findIndex(p => p.id === clientId);
            if (playerIndex !== turnIndex) return;

            robarCartasAJugador(playerIndex, 1);
            const player = players[playerIndex];
            
            const nadieTieneUnaCarta = !players.some(p => p.hand.length === 1);
            if (nadieTieneUnaCarta) forzarOcultarBotonera = false;

            avanzarTurno(1);
            updateAllPlayers(`${player.name} robó una carta. Turno de ${players[turnIndex].name}.`);
        }

        if (type === 'resolvePopup') {
            isPaused = false; 
            avanzarTurno(0); 
            updateAllPlayers(`El juego se reanuda. Turno de ${players[turnIndex].name}.`);
        }
    });

    ws.on('close', () => {
        if (gameStarted) {
            resetGameTotal(`Partida cancelada: Alguien abandonó la sala.`);
        } else {
            players = players.filter(p => p.id !== clientId);
            broadcast('waitingRoom', players.map(p => p.name));
        }
    });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Servidor corriendo en el puerto ${PORT}`));