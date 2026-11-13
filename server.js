// Last Laugh — an original phone-controlled party game.
// Run: npm start   → open http://localhost:3000/host on the TV/laptop.
const express = require('express');
const http = require('http');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');
const { Server } = require('socket.io');
const PROMPTS = require('./prompts');

const PORT = process.env.PORT || 3000;
const app = express();
const server = http.createServer(app);
const io = new Server(server);

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_, res) => res.sendFile(path.join(__dirname, 'public', 'host.html')));

// ---------- config ----------
const MIN_PLAYERS = 3;
const MAX_PLAYERS = 10;
const T = {
  roundIntro: 5000,
  answer: 90000,
  finalAnswer: 75000,
  vote: 20000,
  reveal: 7000,
  scores: 8000,
  finalVote: 30000,
  finalReveal: 14000,
};
const COLORS = ['#ff4d6d', '#ffb703', '#06d6a0', '#4cc9f0', '#b388ff', '#ff8fab', '#f77f00', '#90e0ef', '#c5f277', '#ffd6a5'];
const ROOM_LETTERS = 'BCDFGHJKLMNPQRSTVWXZ'; // no vowels → no accidental words

const rooms = new Map();

function lanIP() {
  for (const list of Object.values(os.networkInterfaces())) {
    for (const i of list || []) if (i.family === 'IPv4' && !i.internal) return i.address;
  }
  return 'localhost';
}

function newCode() {
  let c;
  do {
    c = Array.from({ length: 4 }, () => ROOM_LETTERS[Math.floor(Math.random() * ROOM_LETTERS.length)]).join('');
  } while (rooms.has(c));
  return c;
}

const shuffle = (a) => {
  a = [...a];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

function drawPrompts(room, n) {
  if (room.deck.length < n) room.deck = shuffle(PROMPTS);
  return room.deck.splice(0, n);
}

function clean(text, max = 80) {
  return String(text || '').replace(/\s+/g, ' ').trim().slice(0, max);
}

// ---------- room lifecycle ----------
function createRoom(hostSocket, origin) {
  const code = newCode();
  const room = {
    code,
    hostSocketId: hostSocket.id,
    origin,
    players: [], // {id,name,color,score,socketId,connected,lastGain}
    audience: new Map(), // audienceId -> socketId
    vipId: null,
    phase: 'lobby',
    round: 0,
    matchups: [],
    mIndex: 0,
    final: null,
    deadline: null,
    timer: null,
    deck: shuffle(PROMPTS),
    lastActive: Date.now(),
  };
  rooms.set(code, room);
  return room;
}

function setTimer(room, ms, fn) {
  clearTimeout(room.timer);
  room.deadline = Date.now() + ms;
  room.timer = setTimeout(() => {
    room.deadline = null;
    fn();
  }, ms);
}

function clearTimer(room) {
  clearTimeout(room.timer);
  room.deadline = null;
}

const player = (room, id) => room.players.find((p) => p.id === id);
const connectedPlayers = (room) => room.players.filter((p) => p.connected);

function startGame(room) {
  if (room.players.length < MIN_PLAYERS) return;
  room.players.forEach((p) => (p.score = 0));
  room.round = 0;
  nextRound(room);
}

function nextRound(room) {
  room.round += 1;
  room.players.forEach((p) => (p.lastGain = 0));
  room.phase = 'roundIntro';
  broadcast(room);
  setTimer(room, T.roundIntro, () => (room.round === 3 ? startFinal(room) : startAnswering(room)));
}

// Each player gets 2 prompts, each prompt is shared by exactly 2 players.
function startAnswering(room) {
  const order = shuffle(room.players.map((p) => p.id));
  const prompts = drawPrompts(room, order.length);
  room.matchups = order.map((id, i) => ({
    prompt: prompts[i],
    authors: [id, order[(i + 1) % order.length]],
    answers: {},
    votes: {}, // voterId -> authorId
    audienceVotes: {}, // audienceId -> authorId
    result: null,
  }));
  room.mIndex = 0;
  room.phase = 'answer';
  broadcast(room);
  setTimer(room, T.answer, () => startVoting(room));
}

function myMatchups(room, pid) {
  return room.matchups.map((m, i) => ({ m, i })).filter(({ m }) => m.authors.includes(pid));
}

function allAnswered(room) {
  return room.players.every((p) => !p.connected || myMatchups(room, p.id).every(({ m }) => m.answers[p.id] !== undefined));
}

function startVoting(room) {
  clearTimer(room);
  room.mIndex = 0;
  room.matchups = shuffle(room.matchups);
  showMatchup(room);
}

function showMatchup(room) {
  const m = room.matchups[room.mIndex];
  if (!m) return showScores(room);
  const [a, b] = m.authors;
  const hasA = m.answers[a] !== undefined;
  const hasB = m.answers[b] !== undefined;
  // If someone (or both) didn't answer, skip the vote — straight to reveal.
  if (!hasA || !hasB) return revealMatchup(room);
  room.phase = 'vote';
  broadcast(room);
  setTimer(room, T.vote, () => revealMatchup(room));
}

function eligibleVoters(room, m) {
  return room.players.filter((p) => p.connected && !m.authors.includes(p.id));
}

function revealMatchup(room) {
  clearTimer(room);
  const m = room.matchups[room.mIndex];
  const mult = room.round;
  const [a, b] = m.authors;
  const tally = { [a]: 0, [b]: 0 };
  Object.values(m.votes).forEach((id) => tally[id]++);
  const aud = { [a]: 0, [b]: 0 };
  Object.values(m.audienceVotes).forEach((id) => aud[id]++);
  const audTotal = aud[a] + aud[b];
  const total = tally[a] + tally[b];
  const gains = { [a]: 0, [b]: 0 };
  let sweep = null;
  let forfeit = null;

  const hasA = m.answers[a] !== undefined;
  const hasB = m.answers[b] !== undefined;
  if (hasA !== hasB) {
    forfeit = hasA ? a : b;
    gains[forfeit] = 500 * mult;
  } else if (hasA && hasB) {
    // Player votes are worth 1000 × round; the whole audience together is worth one extra player-vote.
    const voteUnits = total + (audTotal ? 1 : 0);
    for (const id of [a, b]) {
      const units = tally[id] + (audTotal ? aud[id] / audTotal : 0);
      gains[id] = voteUnits ? Math.round(((1000 * mult * units) / voteUnits) / 10) * 10 : 0;
    }
    if (total >= 2 && (tally[a] === total || tally[b] === total)) {
      sweep = tally[a] === total ? a : b;
      gains[sweep] += 250 * mult;
    }
  }
  for (const id of [a, b]) {
    const p = player(room, id);
    if (p) {
      p.score += gains[id];
      p.lastGain += gains[id];
    }
  }
  m.result = { tally, aud, gains, sweep, forfeit };
  room.phase = 'reveal';
  broadcast(room);
  setTimer(room, T.reveal, () => {
    room.mIndex += 1;
    showMatchup(room);
  });
}

function showScores(room) {
  room.phase = 'scores';
  broadcast(room);
  setTimer(room, T.scores, () => nextRound(room));
}

// ---------- final round: everyone answers one prompt, everyone votes ----------
function startFinal(room) {
  room.final = { prompt: drawPrompts(room, 1)[0], answers: {}, votes: {}, audienceVotes: {}, result: null, order: [] };
  room.phase = 'finalAnswer';
  broadcast(room);
  setTimer(room, T.finalAnswer, () => startFinalVote(room));
}

function startFinalVote(room) {
  clearTimer(room);
  const f = room.final;
  f.order = shuffle(Object.keys(f.answers));
  if (f.order.length < 2) return finalReveal(room);
  room.phase = 'finalVote';
  broadcast(room);
  setTimer(room, T.finalVote, () => finalReveal(room));
}

function finalReveal(room) {
  clearTimer(room);
  const f = room.final;
  const tally = {};
  f.order.forEach((id) => (tally[id] = 0));
  Object.values(f.votes).forEach((id) => tally[id]++);
  const aud = {};
  f.order.forEach((id) => (aud[id] = 0));
  Object.values(f.audienceVotes).forEach((id) => aud[id]++);
  const audTotal = Object.values(aud).reduce((s, n) => s + n, 0);
  const gains = {};
  f.order.forEach((id) => {
    gains[id] = tally[id] * 600 + (audTotal ? Math.round((600 * aud[id]) / audTotal / 10) * 10 : 0);
    const p = player(room, id);
    if (p) {
      p.score += gains[id];
      p.lastGain = gains[id];
    }
  });
  f.result = { tally, aud, gains, ranked: [...f.order].sort((x, y) => gains[y] - gains[x]) };
  room.phase = 'finalReveal';
  broadcast(room);
  setTimer(room, T.finalReveal, () => {
    room.phase = 'end';
    broadcast(room);
  });
}

// ---------- views ----------
function pub(p) {
  return { id: p.id, name: p.name, color: p.color, score: p.score, connected: p.connected, lastGain: p.lastGain || 0 };
}

function hostView(room) {
  const v = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    deadline: room.deadline,
    now: Date.now(),
    players: room.players.map(pub),
    vipId: room.vipId,
    audienceCount: room.audience.size,
    minPlayers: MIN_PLAYERS,
    maxPlayers: MAX_PLAYERS,
  };
  if (room.phase === 'answer') {
    v.done = room.players.filter((p) => myMatchups(room, p.id).every(({ m }) => m.answers[p.id] !== undefined)).map((p) => p.id);
  }
  if (['vote', 'reveal'].includes(room.phase)) {
    const m = room.matchups[room.mIndex];
    v.matchup = {
      index: room.mIndex,
      count: room.matchups.length,
      prompt: m.prompt,
      answers: m.authors.map((id) => ({ id, text: m.answers[id] ?? null })),
      voted: Object.keys(m.votes),
      audienceVoted: Object.keys(m.audienceVotes).length,
    };
    if (room.phase === 'reveal') {
      v.matchup.result = m.result;
      v.matchup.voters = Object.fromEntries(m.authors.map((id) => [id, Object.entries(m.votes).filter(([, t]) => t === id).map(([vid]) => vid)]));
    }
  }
  if (['finalAnswer', 'finalVote', 'finalReveal', 'end'].includes(room.phase) && room.final) {
    const f = room.final;
    v.final = {
      prompt: f.prompt,
      done: Object.keys(f.answers),
      voted: Object.keys(f.votes),
    };
    if (room.phase !== 'finalAnswer') v.final.answers = f.order.map((id) => ({ id, text: f.answers[id] }));
    if (f.result) v.final.result = f.result;
  }
  return v;
}

function playerView(room, p) {
  const v = {
    code: room.code,
    phase: room.phase,
    round: room.round,
    deadline: room.deadline,
    now: Date.now(),
    me: pub(p),
    isVip: room.vipId === p.id,
    playerCount: room.players.length,
    minPlayers: MIN_PLAYERS,
    rank: [...room.players].sort((a, b) => b.score - a.score).findIndex((x) => x.id === p.id) + 1,
  };
  if (room.phase === 'answer') {
    v.todo = myMatchups(room, p.id)
      .filter(({ m }) => m.answers[p.id] === undefined)
      .map(({ m, i }) => ({ i, prompt: m.prompt }));
  }
  if (room.phase === 'vote') {
    const m = room.matchups[room.mIndex];
    v.isAuthor = m.authors.includes(p.id);
    v.prompt = m.prompt;
    v.voted = m.votes[p.id] !== undefined;
    if (!v.isAuthor) v.options = m.authors.map((id) => ({ id, text: m.answers[id] }));
  }
  if (room.phase === 'finalAnswer') v.prompt = room.final.prompt, v.answered = room.final.answers[p.id] !== undefined;
  if (room.phase === 'finalVote') {
    v.prompt = room.final.prompt;
    v.voted = room.final.votes[p.id] !== undefined;
    v.options = room.final.order.filter((id) => id !== p.id).map((id) => ({ id, text: room.final.answers[id] }));
  }
  return v;
}

function audienceView(room, aid) {
  const v = { code: room.code, phase: room.phase, round: room.round, deadline: room.deadline, now: Date.now(), audience: true, audienceCount: room.audience.size };
  if (room.phase === 'vote') {
    const m = room.matchups[room.mIndex];
    v.prompt = m.prompt;
    v.voted = m.audienceVotes[aid] !== undefined;
    v.options = m.authors.map((id) => ({ id, text: m.answers[id] }));
  }
  if (room.phase === 'finalVote') {
    v.prompt = room.final.prompt;
    v.voted = room.final.audienceVotes[aid] !== undefined;
    v.options = room.final.order.map((id) => ({ id, text: room.final.answers[id] }));
  }
  return v;
}

function broadcast(room) {
  room.lastActive = Date.now();
  io.to(room.hostSocketId).emit('host:state', hostView(room));
  for (const p of room.players) if (p.connected) io.to(p.socketId).emit('player:state', playerView(room, p));
  for (const [aid, sid] of room.audience) io.to(sid).emit('player:state', audienceView(room, aid));
}

// ---------- sockets ----------
io.on('connection', (socket) => {
  let ctx = null; // {room, role:'host'|'player'|'audience', id}

  socket.on('host:create', async ({ origin, code } = {}, cb) => {
    let room = code && rooms.get(code);
    if (room) {
      room.hostSocketId = socket.id; // host page reloaded
    } else {
      let o = origin || `http://localhost:${PORT}`;
      try {
        const u = new URL(o);
        if (['localhost', '127.0.0.1', '::1'].includes(u.hostname)) u.hostname = lanIP();
        o = u.origin;
      } catch {}
      room = createRoom(socket, process.env.PUBLIC_URL || o);
    }
    ctx = { room, role: 'host' };
    const joinUrl = `${room.origin}/?room=${room.code}`;
    const qr = await QRCode.toDataURL(joinUrl, { margin: 1, width: 360, color: { dark: '#16062b', light: '#ffffff' } });
    cb && cb({ code: room.code, joinUrl, qr, origin: room.origin });
    broadcast(room);
  });

  socket.on('host:start', () => {
    if (ctx?.role === 'host' && ctx.room.phase === 'lobby') startGame(ctx.room);
  });

  socket.on('host:skip', () => {
    // host can skip the timer if things stall
    const room = ctx?.room;
    if (!room || ctx.role !== 'host') return;
    if (room.phase === 'answer') startVoting(room);
    else if (room.phase === 'vote') revealMatchup(room);
    else if (room.phase === 'finalAnswer') startFinalVote(room);
    else if (room.phase === 'finalVote') finalReveal(room);
  });

  socket.on('join', ({ code, name, playerId } = {}, cb) => {
    code = String(code || '').toUpperCase().trim();
    const room = rooms.get(code);
    if (!room) return cb({ error: "That room code doesn't exist. Check the TV." });

    // Rejoin as an existing player
    const existing = playerId && player(room, playerId);
    if (existing) {
      existing.socketId = socket.id;
      existing.connected = true;
      ctx = { room, role: 'player', id: existing.id };
      cb({ ok: true, playerId: existing.id, role: 'player' });
      return broadcast(room);
    }

    name = clean(name, 12).toUpperCase();
    if (!name) return cb({ error: 'Enter a name.' });

    if (room.phase !== 'lobby' || room.players.length >= MAX_PLAYERS) {
      const aid = playerId || Math.random().toString(36).slice(2);
      room.audience.set(aid, socket.id);
      ctx = { room, role: 'audience', id: aid };
      cb({ ok: true, playerId: aid, role: 'audience' });
      return broadcast(room);
    }
    if (room.players.some((p) => p.name === name)) return cb({ error: 'Someone already took that name.' });

    const id = Math.random().toString(36).slice(2);
    const used = new Set(room.players.map((p) => p.color));
    const color = COLORS.find((c) => !used.has(c)) || COLORS[0];
    room.players.push({ id, name, color, score: 0, socketId: socket.id, connected: true, lastGain: 0 });
    if (!room.vipId) room.vipId = id;
    ctx = { room, role: 'player', id };
    cb({ ok: true, playerId: id, role: 'player' });
    broadcast(room);
  });

  socket.on('vip:start', () => {
    if (ctx?.role === 'player' && ctx.room.vipId === ctx.id && ctx.room.phase === 'lobby') startGame(ctx.room);
  });

  socket.on('playAgain', () => {
    const room = ctx?.room;
    if (!room || room.phase !== 'end') return;
    if (ctx.role === 'host' || (ctx.role === 'player' && room.vipId === ctx.id)) {
      room.players = room.players.filter((p) => p.connected);
      if (!player(room, room.vipId)) room.vipId = room.players[0]?.id || null;
      room.phase = 'lobby';
      room.round = 0;
      room.players.forEach((p) => (p.score = 0, p.lastGain = 0));
      broadcast(room);
    }
  });

  socket.on('answer', ({ i, text } = {}) => {
    const room = ctx?.room;
    if (!room || ctx.role !== 'player') return;
    text = clean(text) || null;
    if (!text) return;
    if (room.phase === 'answer') {
      const m = room.matchups[i];
      if (!m || !m.authors.includes(ctx.id) || m.answers[ctx.id] !== undefined) return;
      m.answers[ctx.id] = text;
      if (allAnswered(room)) startVoting(room);
      else broadcast(room);
    } else if (room.phase === 'finalAnswer') {
      if (room.final.answers[ctx.id] !== undefined) return;
      room.final.answers[ctx.id] = text;
      if (connectedPlayers(room).every((p) => room.final.answers[p.id] !== undefined)) startFinalVote(room);
      else broadcast(room);
    }
  });

  socket.on('vote', ({ id } = {}) => {
    const room = ctx?.room;
    if (!room) return;
    if (room.phase === 'vote') {
      const m = room.matchups[room.mIndex];
      if (!m.authors.includes(id)) return;
      if (ctx.role === 'audience') {
        m.audienceVotes[ctx.id] = id;
        return broadcast(room);
      }
      if (m.authors.includes(ctx.id) || m.votes[ctx.id] !== undefined) return;
      m.votes[ctx.id] = id;
      if (eligibleVoters(room, m).every((p) => m.votes[p.id] !== undefined)) revealMatchup(room);
      else broadcast(room);
    } else if (room.phase === 'finalVote') {
      const f = room.final;
      if (!f.order.includes(id)) return;
      if (ctx.role === 'audience') {
        f.audienceVotes[ctx.id] = id;
        return broadcast(room);
      }
      if (id === ctx.id || f.votes[ctx.id] !== undefined) return;
      f.votes[ctx.id] = id;
      if (connectedPlayers(room).every((p) => f.votes[p.id] !== undefined || f.order.length < 2)) finalReveal(room);
      else broadcast(room);
    }
  });

  socket.on('disconnect', () => {
    if (!ctx) return;
    const { room, role, id } = ctx;
    if (role === 'player') {
      const p = player(room, id);
      if (p && p.socketId === socket.id) {
        p.connected = false;
        if (room.phase === 'lobby') {
          room.players = room.players.filter((x) => x.id !== id);
          if (room.vipId === id) room.vipId = room.players[0]?.id || null;
        }
      }
    } else if (role === 'audience') {
      if (room.audience.get(id) === socket.id) room.audience.delete(id);
    }
    broadcast(room);
  });
});

// Clean up abandoned rooms
setInterval(() => {
  for (const [code, room] of rooms) {
    if (Date.now() - room.lastActive > 1000 * 60 * 60) {
      clearTimer(room);
      rooms.delete(code);
    }
  }
}, 60000);

server.listen(PORT, () => {
  const ip = lanIP();
  console.log('\n  🎤 LAST LAUGH is running!\n');
  console.log(`  Open on the TV / laptop:  http://localhost:${PORT}/host`);
  console.log(`  Phones join at:           http://${ip}:${PORT}  (or just scan the QR code)\n`);
});
