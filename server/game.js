const { drawWord } = require('./words');

// Fases possíveis de uma sala.
const PHASES = {
  LOBBY: 'lobby',       // aguardando jogadores / configuração
  PLAYING: 'playing',   // rodadas de palavras-dica
  VOTING: 'voting',     // mural de votação
  GUESSING: 'guessing', // impostor desmascarado tenta adivinhar a palavra
  RESULTS: 'results',   // revelação e pontuação
};

const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const MIN_ROUNDS = 1;
const MAX_ROUNDS = 5;

// Pontuação
const POINTS_IMPOSTOR_ESCAPED = 3;      // impostor não foi o mais votado
const POINTS_CORRECT_VOTE = 2;          // votou no impostor e ele foi descoberto
const POINTS_CORRECT_VOTE_MINORITY = 1; // votou no impostor, mas ele escapou
const POINTS_IMPOSTOR_GUESS = 2;        // impostor descoberto adivinha a palavra

/** Compara palavras ignorando caixa, acentos e espaços nas pontas. */
function normalizeWord(text) {
  return String(text || '')
    .trim()
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

function shuffle(array) {
  const copy = [...array];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

/**
 * Os jogadores são identificados por um playerId persistente (chave de sessão),
 * e NÃO pelo socket.id — assim quem recarrega a página ou perde a conexão no
 * celular consegue voltar para a mesma cadeira. O socketId atual de cada
 * jogador fica em player.socketId e é atualizado a cada reconexão.
 */
class Room {
  constructor(code, hostId) {
    this.code = code;
    this.hostId = hostId;
    this.phase = PHASES.LOBBY;
    this.settings = { rounds: 3 };
    // players: Map<playerId, { id, name, score, connected, socketId }>
    this.players = new Map();
    this.game = null; // estado da partida em andamento
  }

  // ---------- Lobby / presença ----------

  addPlayer(id, name, socketId) {
    if (this.phase !== PHASES.LOBBY) {
      return { error: 'A partida já começou nesta sala.' };
    }
    if (this.players.size >= MAX_PLAYERS) {
      return { error: 'A sala está cheia.' };
    }
    const taken = [...this.players.values()].some(
      (p) => p.name.toLowerCase() === name.toLowerCase()
    );
    if (taken) {
      return { error: 'Já existe um jogador com esse nome na sala.' };
    }
    this.players.set(id, { id, name, score: 0, connected: true, socketId });
    return { ok: true };
  }

  /**
   * Queda de conexão (F5, tela bloqueada, rede). O jogador pode voltar.
   * Se era a vez dele, o turno NÃO é pulado na hora — o servidor agenda
   * skipTurnIfDisconnected() com uma tolerância, para um simples refresh
   * não custar a vez do jogador.
   */
  disconnectPlayer(id) {
    const player = this.players.get(id);
    if (!player) return;
    player.connected = false;
    player.socketId = null;
    // O host não é reatribuído aqui: o servidor agenda reassignHostIfNeeded()
    // com tolerância, para um F5 do host não custar a coroa.
  }

  /** Pula o turno do jogador se ele continua desconectado. Retorna true se avançou. */
  skipTurnIfDisconnected(id) {
    const player = this.players.get(id);
    if (this.phase !== PHASES.PLAYING) return false;
    if (this.currentTurnId() !== id) return false;
    if (player?.connected) return false;
    this.advanceTurn();
    return true;
  }

  /** Reconexão de um jogador que já estava na sala. */
  reconnectPlayer(id, socketId) {
    const player = this.players.get(id);
    if (!player) return { error: 'Você não está (mais) nesta sala.' };
    player.connected = true;
    player.socketId = socketId;
    return { ok: true };
  }

  /** Remoção definitiva (após o período de tolerância sem reconectar). */
  removePlayer(id) {
    if (this.phase === PHASES.LOBBY) {
      this.players.delete(id);
    }
    // Durante a partida mantemos o registro (dicas/votos já dados),
    // apenas seguimos com o jogador marcado como desconectado.
    this.reassignHostIfNeeded();
  }

  reassignHostIfNeeded() {
    const host = this.players.get(this.hostId);
    if (host && host.connected) return;
    const next = [...this.players.values()].find((p) => p.connected);
    if (next) this.hostId = next.id;
  }

  setRounds(requesterId, rounds) {
    if (requesterId !== this.hostId) return { error: 'Apenas o host pode alterar as configurações.' };
    if (this.phase !== PHASES.LOBBY) return { error: 'A partida já começou.' };
    const n = Number(rounds);
    if (!Number.isInteger(n) || n < MIN_ROUNDS || n > MAX_ROUNDS) {
      return { error: `Rodadas deve ser um número entre ${MIN_ROUNDS} e ${MAX_ROUNDS}.` };
    }
    this.settings.rounds = n;
    return { ok: true };
  }

  // ---------- Início da partida ----------

  startGame(requesterId) {
    if (requesterId !== this.hostId) return { error: 'Apenas o host pode iniciar a partida.' };
    if (this.phase !== PHASES.LOBBY) return { error: 'A partida já está em andamento.' };
    const activeIds = [...this.players.values()]
      .filter((p) => p.connected)
      .map((p) => p.id);
    if (activeIds.length < MIN_PLAYERS) {
      return { error: `São necessários pelo menos ${MIN_PLAYERS} jogadores conectados.` };
    }

    const impostorId = activeIds[Math.floor(Math.random() * activeIds.length)];
    const { category, word } = drawWord();

    this.game = {
      impostorId,
      word,
      category,
      order: shuffle(activeIds), // ordem dos turnos
      round: 1,
      turnIndex: 0,
      hints: [],  // { playerId, name, text, round }
      votes: {},  // voterId -> targetId
      caught: null, // definido ao fechar a votação
      results: null,
    };
    this.phase = PHASES.PLAYING;
    return { ok: true };
  }

  // ---------- Fase de ação (rodadas) ----------

  currentTurnId() {
    if (this.phase !== PHASES.PLAYING || !this.game) return null;
    return this.game.order[this.game.turnIndex];
  }

  submitHint(playerId, text) {
    if (this.phase !== PHASES.PLAYING) return { error: 'Não é a fase de dicas.' };
    if (this.currentTurnId() !== playerId) return { error: 'Não é a sua vez.' };

    const hint = String(text || '').trim().slice(0, 40);
    if (!hint) return { error: 'Digite uma palavra.' };
    if (normalizeWord(hint) === normalizeWord(this.game.word)) {
      return { error: 'Você não pode dizer a própria palavra secreta!' };
    }

    const player = this.players.get(playerId);
    this.game.hints.push({
      playerId,
      name: player.name,
      text: hint,
      round: this.game.round,
    });

    this.advanceTurn();
    return { ok: true };
  }

  /**
   * Avança para o próximo jogador conectado. Quando a ordem completa um ciclo,
   * incrementa a rodada; se todas as rodadas acabaram, abre a votação.
   */
  advanceTurn() {
    if (this.phase !== PHASES.PLAYING) return;
    const { order } = this.game;

    let advanced = 0;
    do {
      this.game.turnIndex += 1;
      if (this.game.turnIndex >= order.length) {
        this.game.turnIndex = 0;
        this.game.round += 1;
        if (this.game.round > this.settings.rounds) {
          this.startVoting();
          return;
        }
      }
      advanced += 1;
      // Pula jogadores desconectados; se todos caíram, encerra na votação.
      if (advanced > order.length) {
        this.startVoting();
        return;
      }
    } while (!this.players.get(this.currentTurnId())?.connected);
  }

  // ---------- Fase de votação ----------

  startVoting() {
    this.phase = PHASES.VOTING;
    this.game.votes = {};
  }

  submitVote(voterId, targetId) {
    if (this.phase !== PHASES.VOTING) return { error: 'Não é a fase de votação.' };
    const voter = this.players.get(voterId);
    const target = this.players.get(targetId);
    if (!voter || !target) return { error: 'Jogador inválido.' };
    if (voterId === targetId) return { error: 'Você não pode votar em si mesmo.' };
    if (this.game.votes[voterId]) return { error: 'Você já votou.' };

    this.game.votes[voterId] = targetId;

    if (this.allVotesIn()) this.closeVoting();
    return { ok: true };
  }

  /** Todos os jogadores conectados já votaram? */
  allVotesIn() {
    if (this.phase !== PHASES.VOTING) return false;
    return [...this.players.values()].every(
      (p) => !p.connected || this.game.votes[p.id]
    );
  }

  /**
   * Fecha a votação: se o impostor foi descoberto e está conectado, ele ganha
   * uma última chance de adivinhar a palavra (fase GUESSING); caso contrário,
   * a partida termina direto.
   */
  closeVoting() {
    const { votes, impostorId } = this.game;

    // Conta os votos por alvo.
    const tally = {};
    for (const targetId of Object.values(votes)) {
      tally[targetId] = (tally[targetId] || 0) + 1;
    }

    // O impostor é descoberto se for o ÚNICO mais votado (empate = escapou).
    const max = Math.max(0, ...Object.values(tally));
    const mostVoted = Object.keys(tally).filter((id) => tally[id] === max);
    this.game.caught = max > 0 && mostVoted.length === 1 && mostVoted[0] === impostorId;

    const impostor = this.players.get(impostorId);
    if (this.game.caught && impostor?.connected) {
      this.phase = PHASES.GUESSING;
    } else {
      this.finishGame(null);
    }
  }

  /** Palpite de redenção do impostor desmascarado. */
  submitGuess(playerId, text) {
    if (this.phase !== PHASES.GUESSING) return { error: 'Não é a fase de palpite.' };
    if (playerId !== this.game.impostorId) return { error: 'Apenas o impostor dá o palpite.' };
    const guess = String(text || '').trim().slice(0, 40);
    if (!guess) return { error: 'Digite o seu palpite.' };
    this.finishGame(guess);
    return { ok: true };
  }

  // ---------- Revelação e pontuação ----------

  finishGame(guess) {
    const { votes, impostorId, caught } = this.game;
    const impostor = this.players.get(impostorId);

    const guessedRight =
      guess !== null && normalizeWord(guess) === normalizeWord(this.game.word);

    if (caught) {
      // Quem desmascarou o impostor pontua.
      for (const [voterId, targetId] of Object.entries(votes)) {
        if (voterId !== impostorId && targetId === impostorId) {
          const p = this.players.get(voterId);
          if (p) p.score += POINTS_CORRECT_VOTE;
        }
      }
      // Redenção: descoberto, mas adivinhou a palavra.
      if (guessedRight && impostor) impostor.score += POINTS_IMPOSTOR_GUESS;
    } else {
      if (impostor) impostor.score += POINTS_IMPOSTOR_ESCAPED;
      // Consolação: votou certo mesmo com o impostor escapando.
      for (const [voterId, targetId] of Object.entries(votes)) {
        if (voterId !== impostorId && targetId === impostorId) {
          const p = this.players.get(voterId);
          if (p) p.score += POINTS_CORRECT_VOTE_MINORITY;
        }
      }
    }

    this.game.results = {
      impostorId,
      impostorName: impostor?.name || '???',
      caught,
      guess,
      guessedRight,
      word: this.game.word,
      category: this.game.category,
      votes: Object.entries(votes).map(([voterId, targetId]) => ({
        voterName: this.players.get(voterId)?.name || '???',
        targetName: this.players.get(targetId)?.name || '???',
        correct: targetId === impostorId && voterId !== impostorId,
      })),
    };
    this.phase = PHASES.RESULTS;
  }

  /**
   * Volta ao lobby mantendo jogadores e placar. Jogadores desconectados NÃO
   * são removidos aqui — a tela do celular bloqueia o tempo todo, e quem cair
   * entre partidas ainda tem o período de tolerância para voltar.
   */
  resetToLobby(requesterId) {
    if (requesterId !== this.hostId) return { error: 'Apenas o host pode iniciar uma nova partida.' };
    if (this.phase !== PHASES.RESULTS) return { error: 'A partida ainda não terminou.' };
    this.game = null;
    this.phase = PHASES.LOBBY;
    return { ok: true };
  }

  isEmpty() {
    return [...this.players.values()].every((p) => !p.connected);
  }

  // ---------- Serialização ----------

  /**
   * Estado visível a TODOS os jogadores. Nunca inclui a palavra secreta
   * nem a identidade do impostor antes da fase de resultados.
   */
  publicState() {
    const votes = this.game?.votes || {};
    return {
      code: this.code,
      phase: this.phase,
      hostId: this.hostId,
      settings: this.settings,
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        name: p.name,
        score: p.score,
        connected: p.connected,
        hasVoted: Boolean(votes[p.id]),
      })),
      game: this.game
        ? {
            round: Math.min(this.game.round, this.settings.rounds),
            totalRounds: this.settings.rounds,
            currentTurnId: this.currentTurnId(),
            hints: this.game.hints,
            // Na fase de palpite o impostor já foi desmascarado publicamente.
            guessingName:
              this.phase === PHASES.GUESSING
                ? this.players.get(this.game.impostorId)?.name || '???'
                : null,
            results: this.phase === PHASES.RESULTS ? this.game.results : null,
          }
        : null,
    };
  }

  /** Informação privada enviada individualmente a cada jogador. */
  roleFor(playerId) {
    if (!this.game) return null;
    if (playerId === this.game.impostorId) {
      return { isImpostor: true, category: this.game.category };
    }
    return { isImpostor: false, word: this.game.word, category: this.game.category };
  }
}

module.exports = { Room, PHASES, MIN_PLAYERS, MAX_PLAYERS, MIN_ROUNDS, MAX_ROUNDS };
