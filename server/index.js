const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
const express = require('express');
const { Server } = require('socket.io');
const { Room } = require('./game');

const PORT = process.env.PORT || 3000;

// Tempo que um jogador desconectado tem para voltar antes de ser removido
// (tela bloqueada no celular, troca de app, F5, oscilação de rede).
// Generoso de propósito: em celulares a conexão cai o tempo todo.
const RECONNECT_GRACE_MS = 180_000;

// Se a queda acontecer na vez do jogador, quanto tempo o turno espera por ele
// antes de ser pulado (um F5 leva ~2s; não pode custar a vez).
const TURN_SKIP_GRACE_MS = 10_000;

const app = express();
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);
const io = new Server(server);

// rooms: Map<code, Room>
const rooms = new Map();
// Timers de remoção definitiva de jogadores desconectados: Map<`${code}:${playerId}`, Timeout>
const removalTimers = new Map();

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ'; // sem I e O para evitar confusão
function generateCode() {
  let code;
  do {
    code = Array.from({ length: 4 }, () =>
      CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)]
    ).join('');
  } while (rooms.has(code));
  return code;
}

function sanitizeName(name) {
  return String(name || '').trim().slice(0, 16);
}

/** Envia o estado público atualizado para todos na sala. */
function broadcast(room) {
  io.to(room.code).emit('room:update', room.publicState());
}

/** Envia a cada jogador conectado seu papel privado (palavra ou impostor). */
function sendRoles(room) {
  for (const player of room.players.values()) {
    if (!player.connected || !player.socketId) continue;
    io.to(player.socketId).emit('game:role', room.roleFor(player.id));
  }
}

function cancelRemoval(code, playerId) {
  const key = `${code}:${playerId}`;
  const timer = removalTimers.get(key);
  if (timer) {
    clearTimeout(timer);
    removalTimers.delete(key);
  }
}

/** Agenda a remoção definitiva de um jogador que não reconectar a tempo. */
function scheduleRemoval(code, playerId) {
  cancelRemoval(code, playerId);
  const key = `${code}:${playerId}`;
  removalTimers.set(
    key,
    setTimeout(() => {
      removalTimers.delete(key);
      const room = rooms.get(code);
      if (!room) return;
      const player = room.players.get(playerId);
      if (!player || player.connected) return; // já voltou

      room.removePlayer(playerId);

      // Sala abandonada por todos? Libera o código.
      if (room.isEmpty()) {
        rooms.delete(code);
        return;
      }
      broadcast(room);
    }, RECONNECT_GRACE_MS)
  );
}

io.on('connection', (socket) => {
  // Informa o endereço de rede local: se o host abriu via "localhost", o
  // cliente usa este endereço para montar o link/QR de convite dos celulares.
  const lan = lanAddresses()[0];
  socket.emit('server:info', { lanUrl: lan ? `http://${lan}:${PORT}` : null });

  // Identidade do jogador neste socket (playerId persistente + sala atual).
  socket.data.roomCode = null;
  socket.data.playerId = null;

  function getRoom() {
    return rooms.get(socket.data.roomCode);
  }

  function bindToRoom(code, playerId) {
    socket.join(code);
    socket.data.roomCode = code;
    socket.data.playerId = playerId;
    cancelRemoval(code, playerId);
  }

  socket.on('room:create', ({ name }, ack) => {
    const playerName = sanitizeName(name);
    if (!playerName) return ack({ error: 'Digite seu nome.' });

    const code = generateCode();
    const playerId = crypto.randomUUID();
    const room = new Room(code, playerId);
    room.addPlayer(playerId, playerName, socket.id);
    rooms.set(code, room);

    bindToRoom(code, playerId);
    ack({ ok: true, code, playerId });
    broadcast(room);
  });

  socket.on('room:join', ({ code, name }, ack) => {
    const playerName = sanitizeName(name);
    const roomCode = String(code || '').trim().toUpperCase();
    if (!playerName) return ack({ error: 'Digite seu nome.' });

    const room = rooms.get(roomCode);
    if (!room) return ack({ error: 'Sala não encontrada. Confira o código.' });

    const playerId = crypto.randomUUID();
    const result = room.addPlayer(playerId, playerName, socket.id);
    if (result.error) return ack(result);

    bindToRoom(roomCode, playerId);
    ack({ ok: true, code: roomCode, playerId });
    broadcast(room);
  });

  // Reconexão: o cliente guarda { code, playerId } no localStorage e tenta
  // voltar para a mesma cadeira ao abrir/recuperar a conexão.
  socket.on('room:rejoin', ({ code, playerId }, ack) => {
    const roomCode = String(code || '').trim().toUpperCase();
    const room = rooms.get(roomCode);
    if (!room) return ack({ error: 'A sala não existe mais.' });

    const result = room.reconnectPlayer(String(playerId || ''), socket.id);
    if (result.error) return ack(result);

    bindToRoom(roomCode, playerId);
    ack({ ok: true, code: roomCode, playerId });

    // Reenvia o papel privado se há partida em andamento.
    if (room.game) {
      socket.emit('game:role', room.roleFor(playerId));
    }
    broadcast(room);
  });

  socket.on('room:setRounds', ({ rounds }, ack) => {
    const room = getRoom();
    if (!room) return ack({ error: 'Sala não encontrada.' });
    const result = room.setRounds(socket.data.playerId, rounds);
    if (result.error) return ack(result);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('game:start', (_payload, ack) => {
    const room = getRoom();
    if (!room) return ack({ error: 'Sala não encontrada.' });
    const result = room.startGame(socket.data.playerId);
    if (result.error) return ack(result);
    ack({ ok: true });
    sendRoles(room);
    broadcast(room);
  });

  socket.on('game:hint', ({ text }, ack) => {
    const room = getRoom();
    if (!room) return ack({ error: 'Sala não encontrada.' });
    const result = room.submitHint(socket.data.playerId, text);
    if (result.error) return ack(result);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('game:vote', ({ targetId }, ack) => {
    const room = getRoom();
    if (!room) return ack({ error: 'Sala não encontrada.' });
    const result = room.submitVote(socket.data.playerId, targetId);
    if (result.error) return ack(result);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('game:guess', ({ text }, ack) => {
    const room = getRoom();
    if (!room) return ack({ error: 'Sala não encontrada.' });
    const result = room.submitGuess(socket.data.playerId, text);
    if (result.error) return ack(result);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('game:playAgain', (_payload, ack) => {
    const room = getRoom();
    if (!room) return ack({ error: 'Sala não encontrada.' });
    const result = room.resetToLobby(socket.data.playerId);
    if (result.error) return ack(result);
    ack({ ok: true });
    broadcast(room);
  });

  socket.on('disconnect', () => {
    const room = getRoom();
    const { playerId } = socket.data;
    if (!room || !playerId) return;

    // Reconexão em outra aba/socket já assumiu esta cadeira? Não derruba.
    const player = room.players.get(playerId);
    if (player?.socketId && player.socketId !== socket.id) return;

    room.disconnectPlayer(playerId);
    scheduleRemoval(room.code, playerId);

    // Se caiu na própria vez, espera a tolerância antes de pular o turno.
    if (room.phase === 'playing' && room.currentTurnId() === playerId) {
      const code = room.code;
      setTimeout(() => {
        const r = rooms.get(code);
        if (r && r.skipTurnIfDisconnected(playerId)) broadcast(r);
      }, TURN_SKIP_GRACE_MS);
    }

    // Se o host caiu, espera a mesma tolerância antes de passar a coroa.
    if (room.hostId === playerId) {
      const code = room.code;
      setTimeout(() => {
        const r = rooms.get(code);
        if (!r || r.hostId !== playerId) return;
        const host = r.players.get(playerId);
        if (host?.connected) return; // voltou a tempo
        r.reassignHostIfNeeded();
        broadcast(r);
      }, TURN_SKIP_GRACE_MS);
    }

    // Se o impostor sumiu na fase de palpite, espera a tolerância e encerra.
    if (room.phase === 'guessing' && room.game?.impostorId === playerId) {
      const code = room.code;
      setTimeout(() => {
        const r = rooms.get(code);
        if (!r || r.phase !== 'guessing') return;
        const impostor = r.players.get(playerId);
        if (impostor?.connected) return; // voltou a tempo
        r.finishGame(null);
        broadcast(r);
      }, TURN_SKIP_GRACE_MS);
    }

    // Se a saída do jogador destravou o fim da votação, resolve agora.
    if (room.allVotesIn()) room.closeVoting();

    broadcast(room);
  });
});

/** Endereços IPv4 da máquina na rede local (para acesso de outros aparelhos). */
function lanAddresses() {
  const addresses = [];
  for (const iface of Object.values(os.networkInterfaces())) {
    for (const info of iface || []) {
      if (info.family === 'IPv4' && !info.internal) {
        addresses.push(info.address);
      }
    }
  }
  return addresses;
}

server.listen(PORT, () => {
  console.log('🎭 Impostor no ar!');
  console.log(`   Neste computador:  http://localhost:${PORT}`);
  for (const address of lanAddresses()) {
    console.log(`   Na mesma rede:     http://${address}:${PORT}  ← celulares/outros aparelhos`);
  }
  console.log('   (para jogar pela internet, veja o README: túnel ou deploy)');
});
