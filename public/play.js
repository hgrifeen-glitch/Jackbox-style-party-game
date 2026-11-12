const socket = io();
const $ = (s) => document.querySelector(s);
const screen = $('#screen');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = (a) => a[Math.floor(Math.random() * a.length)];
const buzz = (ms = 30) => navigator.vibrate?.(ms);

const SAFETY = [
  'my ex', 'a damp sock', 'your mom', 'jungle juice', 'tax fraud', 'the RA', 'crippling debt',
  'a Juul in the toilet', 'Four Loko', 'my therapist', 'an emotional support raccoon', 'Applebee\'s',
  'a sexy tax audit', 'Crocs in sport mode', 'one (1) hot dog', 'a strongly worded email', 'vibes',
  'an STI-themed escape room', 'thirteen White Claws', 'a cursed Costco membership', 'Steve from Accounting',
  'the walk of shame', 'unpaid parking tickets', 'a lukewarm Natty Light', 'a haunted futon',
];

const params = new URLSearchParams(location.search);
let S = null;
let role = null;
let lastKey = '';
let clockOffset = 0;
let joined = false;

// ---------------- join ----------------
function showJoin(err = '') {
  joined = false;
  lastKey = 'join';
  $('#meTag').innerHTML = '';
  $('#timer').innerHTML = '';
  const code = (params.get('room') || localStorage.getItem('ll-code') || '').toUpperCase();
  screen.className = 'screen';
  screen.innerHTML = `
    <div class="logo"><span>LAST</span><br><span>LAUGH</span></div>
    <label>ROOM CODE</label>
    <input id="code" maxlength="4" autocomplete="off" autocapitalize="characters" placeholder="ABCD" value="${esc(code)}" />
    <label>YOUR NAME</label>
    <input id="name" maxlength="12" autocomplete="off" placeholder="ENTER NAME" value="${esc(localStorage.getItem('ll-name') || '')}" />
    <div class="err">${esc(err)}</div>
    <button class="btn pink" id="joinBtn">Play</button>
    <p class="muted" style="text-align:center">Game already started or full? You'll join as the audience and can still vote.</p>
    <a href="/host" class="btn ghost" style="text-align:center;text-decoration:none;margin-top:24px">📺 Host a game on this screen</a>`;
  const go = () => join($('#code').value, $('#name').value);
  $('#joinBtn').onclick = go;
  $('#name').onkeydown = (e) => e.key === 'Enter' && go();
  if (!code) $('#code').focus();
}

function join(code, name, silent) {
  code = String(code).toUpperCase().trim();
  const playerId = localStorage.getItem('ll-id-' + code);
  socket.emit('join', { code, name, playerId }, (res) => {
    if (res.error) {
      if (silent) return showJoin();
      return showJoin(res.error);
    }
    joined = true;
    role = res.role;
    localStorage.setItem('ll-code', code);
    localStorage.setItem('ll-id-' + code, res.playerId);
    if (name) localStorage.setItem('ll-name', name);
    history.replaceState(null, '', `/?room=${code}`);
    buzz(60);
  });
}

socket.on('connect', () => {
  // auto-rejoin after refresh / phone lock
  const code = (params.get('room') || localStorage.getItem('ll-code') || '').toUpperCase();
  if (code && localStorage.getItem('ll-id-' + code)) join(code, localStorage.getItem('ll-name'), true);
  else if (!joined) showJoin();
});
socket.on('disconnect', () => {
  if (joined) $('#timer').innerHTML = '<span class="timerSmall urgent">reconnecting…</span>';
});

socket.on('player:state', (s) => {
  clockOffset = Date.now() - s.now;
  S = s;
  render();
});

// ---------------- timer ----------------
setInterval(() => {
  if (!S?.deadline || !joined || !['answer', 'vote', 'finalAnswer', 'finalVote'].includes(S.phase)) { if (joined && socket.connected) $('#timer').innerHTML = ''; return; }
  const sec = Math.max(0, Math.ceil((S.deadline + clockOffset - Date.now()) / 1000));
  $('#timer').innerHTML = `<span class="timerSmall ${sec <= 10 ? 'urgent' : ''}">${sec}</span>`;
}, 250);

// ---------------- render ----------------
function render() {
  if (!S || !joined) return;
  const me = S.me;
  $('#meTag').innerHTML = me
    ? `<div class="me" style="background:${me.color}"><span class="dot">${S.isVip ? '👑' : esc(me.name[0])}</span>${esc(me.name)}</div>`
    : `<div class="me" style="background:#fff"><span class="dot">👀</span>AUDIENCE</div>`;

  // Re-render only when what's on screen actually changes (so typing isn't wiped).
  const key = [S.phase, S.round, S.todo?.[0]?.i, S.prompt, S.voted, S.answered, S.isVip, S.playerCount, S.isAuthor].join('|');
  if (key === lastKey) return;
  lastKey = key;
  screen.className = 'screen';
  const view = (S.audience ? AUDIENCE : PLAYER)[S.phase];
  if (view) view();
  else waitScreen('👀', 'Look at the TV');
}

function waitScreen(emoji, title, sub = '') {
  screen.className = 'screen center';
  screen.innerHTML = `<div class="emoji">${emoji}</div><div class="big">${title}</div>${sub ? `<div class="muted">${sub}</div>` : ''}`;
}

function answerForm(prompt, label, onSubmit) {
  screen.innerHTML = `
    <div class="promptbox slideUp"><small>${label}</small>${esc(prompt)}</div>
    <textarea id="ans" maxlength="80" placeholder="Type something funny…"></textarea>
    <div class="counter" id="cnt">0/80</div>
    <div class="row2">
      <button class="btn ghost" id="safety" style="flex:0 0 auto">🛟 Safety</button>
      <button class="btn pink" id="send">Send</button>
    </div>`;
  const ta = $('#ans');
  ta.oninput = () => ($('#cnt').textContent = `${ta.value.length}/80`);
  ta.focus();
  $('#safety').onclick = () => { ta.value = pick(SAFETY); ta.oninput(); };
  $('#send').onclick = () => {
    const t = ta.value.trim();
    if (!t) { ta.focus(); buzz(80); return; }
    buzz();
    onSubmit(t);
  };
  ta.onkeydown = (e) => { if (e.key === 'Enter') { e.preventDefault(); $('#send').click(); } };
}

function voteList(prompt, options, onVote, cols) {
  screen.innerHTML = `<div class="promptbox"><small>VOTE FOR YOUR FAVORITE</small>${esc(prompt)}</div>` +
    options.map((o) => `<button class="choice slideUp" data-id="${o.id}">${esc(o.text)}</button>`).join('');
  screen.querySelectorAll('.choice').forEach((b) => (b.onclick = () => {
    b.classList.add('picked');
    buzz(50);
    onVote(b.dataset.id);
  }));
}

const rankText = (n) => { const s = ['th', 'st', 'nd', 'rd'], v = n % 100; return n + (s[(v - 20) % 10] || s[v] || s[0]); };

const PLAYER = {
  lobby() {
    if (S.isVip) {
      const enough = S.playerCount >= S.minPlayers;
      screen.className = 'screen center';
      screen.innerHTML = `<div class="emoji">👑</div><div class="big">You're the VIP</div>
        <div class="muted">${enough ? `${S.playerCount} players in. Start when everyone's here.` : `Waiting for at least ${S.minPlayers} players (${S.playerCount} so far)…`}</div>
        <button class="btn pink" id="start" ${enough ? '' : 'disabled'} style="width:100%;margin-top:10px">Everybody's in</button>`;
      $('#start').onclick = () => socket.emit('vip:start');
    } else waitScreen('🍻', "You're in!", 'Look at the TV. The VIP will start the game soon.');
  },
  roundIntro() { waitScreen(S.round === 3 ? '💀' : '🔥', S.round === 3 ? 'FINAL ROUND' : `ROUND ${S.round}`, 'Get ready to type something unhinged.'); },
  answer() {
    const t = S.todo?.[0];
    if (!t) return waitScreen('😎', 'Done!', 'Waiting for the slowpokes…');
    answerForm(t.prompt, S.todo.length === 2 ? 'PROMPT 1 OF 2' : 'LAST ONE', (text) => socket.emit('answer', { i: t.i, text }));
  },
  vote() {
    if (S.isAuthor) return waitScreen('😬', 'This is YOUR matchup', "No voting. Just sit there and sweat.");
    if (S.voted) return waitScreen('🗳️', 'Vote locked in', 'No take-backs.');
    voteList(S.prompt, S.options, (id) => socket.emit('vote', { id }));
  },
  reveal() { waitScreen('👀', 'Look at the TV'); },
  scores() { waitScreen(S.rank === 1 ? '🏆' : '📉', `You're in ${rankText(S.rank)}`, `${S.me.score.toLocaleString()} points`); },
  finalAnswer() {
    if (S.answered) return waitScreen('🤞', 'Locked in', 'Pray it lands.');
    answerForm(S.prompt, 'THE LAST LAUGH', (text) => socket.emit('answer', { text }));
  },
  finalVote() {
    if (S.voted) return waitScreen('🗳️', 'Vote locked in', 'Look at the TV.');
    if (!S.options.length) return waitScreen('👀', 'Look at the TV');
    voteList(S.prompt, S.options, (id) => socket.emit('vote', { id }));
  },
  finalReveal() { waitScreen('🥁', 'Look at the TV'); },
  end() {
    screen.className = 'screen center';
    screen.innerHTML = `<div class="emoji">${S.rank === 1 ? '👑' : S.rank === S.playerCount ? '🗑️' : '🍻'}</div>
      <div class="big">${S.rank === 1 ? 'YOU WON!' : S.rank === S.playerCount ? 'Dead last. Iconic.' : `You got ${rankText(S.rank)}`}</div>
      <div class="muted">${S.me.score.toLocaleString()} points</div>
      ${S.isVip ? '<button class="btn pink" id="again" style="width:100%;margin-top:10px">Play again</button>' : '<div class="muted">The VIP can start another game.</div>'}`;
    $('#again') && ($('#again').onclick = () => socket.emit('playAgain'));
  },
};

const AUDIENCE = {
  lobby() { waitScreen('👀', "You're in the audience", "The game's full or already started. You'll get to vote!"); },
  vote() {
    if (S.voted) return waitScreen('🗳️', 'Audience vote counted', 'Look at the TV.');
    voteList(S.prompt, S.options, (id) => socket.emit('vote', { id }));
  },
  finalVote() {
    if (S.voted) return waitScreen('🗳️', 'Audience vote counted', 'Look at the TV.');
    voteList(S.prompt, S.options, (id) => socket.emit('vote', { id }));
  },
};
