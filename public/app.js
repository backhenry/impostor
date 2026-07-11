/* Cliente do jogo Impostor — conecta via Socket.io e renderiza as telas. */

const socket = io();

// ---------- Estado local ----------
let state = null;   // último room:update recebido do servidor
let myId = null;    // playerId persistente confirmado pelo servidor
let myRole = null;  // { isImpostor, word?, category } — privado desta tela
let myVote = null;  // targetId escolhido na votação atual

// ---------- Sessão persistente (permite reconectar do mesmo aparelho) ----------
// sessionStorage é por ABA: sobrevive a F5, tela bloqueada e quedas de rede,
// e ainda permite testar com várias abas no mesmo navegador (cada aba é um
// jogador diferente, como seriam dispositivos diferentes).
const SESSION_KEY = 'impostor:session';

function saveSession(code, playerId, name) {
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({ code, playerId, name }));
}
function loadSession() {
  try {
    return JSON.parse(sessionStorage.getItem(SESSION_KEY));
  } catch {
    return null;
  }
}
function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

// ---------- Helpers de DOM ----------
const $ = (id) => document.getElementById(id);

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function showScreen(name) {
  document.querySelectorAll('.screen').forEach((el) => el.classList.add('hidden'));
  $(`screen-${name}`).classList.remove('hidden');
}

let toastTimer = null;
function toast(message) {
  const el = $('toast');
  el.textContent = message;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 3000);
}

/** Emite um evento com ack e mostra erro em toast, se houver. */
function emit(event, payload, onOk) {
  socket.emit(event, payload, (res) => {
    if (res?.error) return toast(res.error);
    if (onOk) onOk(res);
  });
}

// ---------- Link de convite pré-preenchido (?code=ABCD) ----------
const urlCode = new URLSearchParams(location.search).get('code');
if (urlCode) {
  $('input-code').value = urlCode.toUpperCase().slice(0, 4);
  $('input-name').focus();
}

// ---------- Ações da tela HOME ----------
function enterRoom(res, name) {
  myId = res.playerId;
  saveSession(res.code, res.playerId, name);
  // Remove o ?code= da URL para um eventual F5 não confundir.
  history.replaceState(null, '', location.pathname);
}

$('btn-create').addEventListener('click', () => {
  const name = $('input-name').value;
  emit('room:create', { name }, (res) => enterRoom(res, name));
});

$('btn-join').addEventListener('click', () => {
  const name = $('input-name').value;
  emit('room:join', { name, code: $('input-code').value }, (res) => enterRoom(res, name));
});

$('input-code').addEventListener('input', (e) => {
  e.target.value = e.target.value.toUpperCase();
});

// ---------- Ações do LOBBY ----------
// Endereço do servidor na rede local, informado na conexão. Usado no lugar de
// "localhost" para que o QR/link funcione nos celulares dos convidados.
let serverLanUrl = null;
socket.on('server:info', ({ lanUrl }) => {
  serverLanUrl = lanUrl;
  qrRenderedFor = null; // força re-render do QR com o endereço correto
  if (state?.phase === 'lobby') render();
});

function inviteUrl() {
  const isLocalhost = ['localhost', '127.0.0.1'].includes(location.hostname);
  const base = isLocalhost && serverLanUrl ? serverLanUrl : location.origin;
  return `${base}/?code=${state?.code || ''}`;
}

$('btn-copy').addEventListener('click', () => {
  navigator.clipboard.writeText(state?.code || '').then(() => toast('Código copiado!'));
});

$('btn-copy-link').addEventListener('click', async () => {
  // No celular, abre a folha de compartilhamento nativa; senão, copia o link.
  if (navigator.share) {
    try {
      await navigator.share({ title: 'Impostor', text: 'Entre na minha sala!', url: inviteUrl() });
      return;
    } catch {
      /* usuário cancelou — cai no clipboard */
    }
  }
  navigator.clipboard.writeText(inviteUrl()).then(() => toast('Link de convite copiado!'));
});

$('select-rounds').addEventListener('change', (e) => {
  emit('room:setRounds', { rounds: Number(e.target.value) });
});

$('btn-start').addEventListener('click', () => {
  emit('game:start', {});
});

// ---------- Ações do JOGO ----------
$('hint-form').addEventListener('submit', (e) => {
  e.preventDefault();
  const text = $('input-hint').value;
  emit('game:hint', { text }, () => {
    $('input-hint').value = '';
  });
});

// ---------- Ações dos RESULTADOS ----------
$('btn-again').addEventListener('click', () => {
  myRole = null;
  emit('game:playAgain', {});
});

// ---------- Conexão e reconexão ----------
socket.on('connect', () => {
  // Ao (re)conectar, tenta voltar para a sala salva neste aparelho.
  const session = loadSession();
  if (!session?.code || !session?.playerId) return;

  socket.emit('room:rejoin', { code: session.code, playerId: session.playerId }, (res) => {
    if (res?.error) {
      // A sala acabou ou fomos removidos: limpa e volta para a home.
      clearSession();
      state = null;
      myId = null;
      showScreen('home');
      return;
    }
    myId = res.playerId;
  });
});

socket.on('disconnect', () => {
  toast('Conexão perdida. Reconectando…');
});

// ---------- Eventos do servidor ----------
socket.on('game:role', (role) => {
  myRole = role;
  render();
});

socket.on('room:update', (room) => {
  state = room;
  render();
});

// ---------- Renderização ----------
function render() {
  if (!state) return showScreen('home');

  // Se não estamos (mais) na lista de jogadores, volta para a home.
  if (!state.players.some((p) => p.id === myId)) {
    state = null;
    clearSession();
    return showScreen('home');
  }

  switch (state.phase) {
    case 'lobby':   return renderLobby();
    case 'playing': return renderGame();
    case 'voting':  return renderVoting();
    case 'results': return renderResults();
  }
}

const isHost = () => state.hostId === myId;

// QR code do link de convite — regenerado apenas quando o código da sala muda.
let qrRenderedFor = null;
let qrRetries = 0;
function renderQr() {
  const container = $('qr');
  if (qrRenderedFor === state.code) return;
  container.innerHTML = '';

  if (typeof QRCode === 'undefined') {
    // A lib do CDN ainda não carregou (ou estamos offline): mostra o link em
    // texto e tenta gerar o QR de novo em instantes.
    container.textContent = inviteUrl();
    if (qrRetries < 10) {
      qrRetries += 1;
      setTimeout(() => {
        if (state?.phase === 'lobby') render();
      }, 1000);
    }
    return;
  }

  new QRCode(container, {
    text: inviteUrl(),
    width: 140,
    height: 140,
    correctLevel: QRCode.CorrectLevel.M,
  });
  qrRenderedFor = state.code;
}

function renderLobby() {
  showScreen('lobby');
  $('lobby-code').textContent = state.code;
  $('lobby-count').textContent = `${state.players.length}/10`;
  renderQr();

  $('lobby-players').innerHTML = state.players
    .map(
      (p) => `
      <li class="flex items-center justify-between bg-slate-700/60 rounded-lg px-3 py-2
        ${p.connected ? '' : 'opacity-50'}">
        <span class="font-medium">${escapeHtml(p.name)}
          ${p.id === myId ? '<span class="text-xs text-slate-400">(você)</span>' : ''}
          ${p.connected ? '' : '<span class="text-xs text-amber-400">reconectando…</span>'}
        </span>
        <span class="text-xs">
          ${p.id === state.hostId ? '👑 Host' : ''}
          ${p.score > 0 ? `<span class="text-amber-400 ml-2">${p.score} pts</span>` : ''}
        </span>
      </li>`
    )
    .join('');

  $('lobby-host-controls').classList.toggle('hidden', !isHost());
  $('lobby-waiting').classList.toggle('hidden', isHost());

  if (isHost()) {
    $('select-rounds').value = String(state.settings.rounds);
    const connected = state.players.filter((p) => p.connected).length;
    const canStart = connected >= 3;
    $('btn-start').disabled = !canStart;
    $('btn-start').textContent = canStart
      ? 'Iniciar Partida'
      : `Iniciar Partida (mín. 3 jogadores)`;
  }
}

function renderRoleCard() {
  const card = $('role-card');
  if (!myRole) {
    card.className = 'rounded-2xl p-5 text-center shadow-xl bg-slate-800';
    card.innerHTML = '<span class="text-slate-400">Carregando papel…</span>';
    return;
  }
  if (myRole.isImpostor) {
    card.className = 'rounded-2xl p-5 text-center shadow-xl bg-rose-950 ring-2 ring-rose-500';
    card.innerHTML = `
      <div class="text-2xl font-extrabold text-rose-400">🎭 Você é o Impostor!</div>
      <div class="text-sm text-rose-200/80 mt-2">
        Descubra a palavra e não seja pego!<br/>
        Dica: a categoria é <b>${escapeHtml(myRole.category)}</b>.
      </div>`;
  } else {
    card.className = 'rounded-2xl p-5 text-center shadow-xl bg-emerald-950 ring-2 ring-emerald-500';
    card.innerHTML = `
      <div class="text-xs uppercase tracking-widest text-emerald-400/70">
        Palavra secreta · ${escapeHtml(myRole.category)}
      </div>
      <div class="text-3xl font-extrabold text-emerald-300 mt-1">${escapeHtml(myRole.word)}</div>`;
  }
}

function hintsBoardHtml(hints, totalRounds) {
  if (!hints.length) {
    return '<p class="text-slate-500 text-sm">Nenhuma palavra dita ainda.</p>';
  }
  let html = '';
  for (let round = 1; round <= totalRounds; round++) {
    const roundHints = hints.filter((h) => h.round === round);
    if (!roundHints.length) continue;
    html += `<div>
      <div class="text-xs text-slate-500 uppercase tracking-wide mb-1">Rodada ${round}</div>
      <div class="flex flex-wrap gap-2">
        ${roundHints
          .map(
            (h) => `<span class="bg-slate-700 rounded-full px-3 py-1 text-sm">
              <b class="text-sky-300">${escapeHtml(h.name)}:</b> ${escapeHtml(h.text)}
            </span>`
          )
          .join('')}
      </div>
    </div>`;
  }
  return html;
}

function renderGame() {
  showScreen('game');
  renderRoleCard();

  const { game } = state;
  $('game-round').textContent = `Rodada ${game.round} de ${game.totalRounds}`;

  const current = state.players.find((p) => p.id === game.currentTurnId);
  const myTurn = game.currentTurnId === myId;
  $('game-turn').innerHTML = myTurn
    ? '<span class="text-emerald-400 font-bold">✨ Sua vez!</span>'
    : `Vez de <b class="text-sky-300">${escapeHtml(current?.name || '…')}</b>`;

  const board = $('hints-board');
  board.innerHTML = hintsBoardHtml(game.hints, game.totalRounds);
  board.scrollTop = board.scrollHeight;

  $('input-hint').disabled = !myTurn;
  $('btn-hint').disabled = !myTurn;
  $('input-hint').placeholder = myTurn
    ? 'Digite uma palavra relacionada…'
    : 'Aguarde sua vez…';
  if (myTurn) $('input-hint').focus();
}

function renderVoting() {
  showScreen('voting');

  $('voting-hints').innerHTML = hintsBoardHtml(state.game.hints, state.game.totalRounds);

  const me = state.players.find((p) => p.id === myId);
  const iVoted = Boolean(me?.hasVoted);

  $('voting-grid').innerHTML = state.players
    .filter((p) => p.connected || p.hasVoted)
    .map((p) => {
      const self = p.id === myId;
      const chosen = myVote === p.id;
      return `
      <button data-target="${p.id}" ${self || iVoted ? 'disabled' : ''}
        class="vote-card rounded-xl p-4 text-center transition active:scale-[.97]
        ${chosen ? 'bg-rose-600 ring-2 ring-rose-300' : 'bg-slate-800 hover:bg-slate-700'}
        ${self ? 'opacity-40 cursor-not-allowed' : ''}
        ${iVoted && !chosen ? 'opacity-50' : ''}">
        <div class="text-2xl">${p.hasVoted ? '✅' : '🤔'}</div>
        <div class="font-bold mt-1">${escapeHtml(p.name)}${self ? ' (você)' : ''}</div>
        <div class="text-xs text-slate-400">${p.hasVoted ? 'já votou' : 'pensando…'}</div>
      </button>`;
    })
    .join('');

  document.querySelectorAll('.vote-card:not([disabled])').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.dataset.target;
      emit('game:vote', { targetId }, () => {
        myVote = targetId;
        render();
      });
    });
  });

  const pending = state.players.filter((p) => p.connected && !p.hasVoted).length;
  $('voting-status').textContent = iVoted
    ? `Voto registrado! Aguardando ${pending} jogador(es)…`
    : 'Toque em um jogador para votar.';
}

function renderResults() {
  showScreen('results');
  const r = state.game.results;

  const banner = $('results-banner');
  if (r.caught) {
    banner.className = 'rounded-2xl p-6 text-center shadow-xl bg-emerald-950 ring-2 ring-emerald-500';
    banner.innerHTML = `
      <div class="text-2xl font-extrabold text-emerald-300">🎉 Impostor descoberto!</div>
      <div class="mt-2 text-emerald-100">
        <b>${escapeHtml(r.impostorName)}</b> era o Impostor.
      </div>
      <div class="text-sm text-emerald-200/70 mt-1">
        A palavra era <b>${escapeHtml(r.word)}</b> (${escapeHtml(r.category)}).
      </div>`;
  } else {
    banner.className = 'rounded-2xl p-6 text-center shadow-xl bg-rose-950 ring-2 ring-rose-500';
    banner.innerHTML = `
      <div class="text-2xl font-extrabold text-rose-300">😈 O Impostor escapou!</div>
      <div class="mt-2 text-rose-100">
        <b>${escapeHtml(r.impostorName)}</b> era o Impostor e não foi descoberto.
      </div>
      <div class="text-sm text-rose-200/70 mt-1">
        A palavra era <b>${escapeHtml(r.word)}</b> (${escapeHtml(r.category)}).
      </div>`;
  }

  $('results-votes').innerHTML = r.votes
    .map(
      (v) => `
      <li class="flex items-center justify-between bg-slate-700/60 rounded-lg px-3 py-2">
        <span>${escapeHtml(v.voterName)} votou em <b>${escapeHtml(v.targetName)}</b></span>
        <span>${v.correct ? '🎯' : '❌'}</span>
      </li>`
    )
    .join('');

  const sorted = [...state.players].sort((a, b) => b.score - a.score);
  $('results-scores').innerHTML = sorted
    .map(
      (p, i) => `
      <li class="flex items-center justify-between bg-slate-700/60 rounded-lg px-3 py-2">
        <span>${i === 0 && p.score > 0 ? '🥇' : ''} ${escapeHtml(p.name)}
          ${p.id === r.impostorId ? '<span class="text-rose-400 text-xs">(impostor)</span>' : ''}
        </span>
        <b class="text-amber-400">${p.score} pts</b>
      </li>`
    )
    .join('');

  $('btn-again').classList.toggle('hidden', !isHost());
  $('results-waiting').classList.toggle('hidden', isHost());
}
