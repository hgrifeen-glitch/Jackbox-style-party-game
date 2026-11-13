const socket = io();
const $ = (s) => document.querySelector(s);
const main = $('#main');
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const pick = (a) => a[Math.floor(Math.random() * a.length)];

let S = null; // latest state
let info = null; // {code, joinUrl, qr}
let lastKey = '';
let clockOffset = 0;
let prevPlayers = new Set();

// ---------------- audio ----------------
let audioOn = false;
let narrator = localStorage.getItem('ll-narrator') !== 'off';
let actx;
function unlockAudio() {
  if (audioOn) return;
  audioOn = true;
  actx = new (window.AudioContext || window.webkitAudioContext)();
  $('#soundHint').classList.add('hidden');
  if (S?.phase === 'lobby') say(pick(LINES.lobby));
}
document.addEventListener('click', unlockAudio);
document.addEventListener('keydown', unlockAudio);

function tone(freq, dur = 0.12, type = 'square', vol = 0.08, when = 0) {
  if (!actx) return;
  const t = actx.currentTime + when;
  const o = actx.createOscillator();
  const g = actx.createGain();
  o.type = type;
  o.frequency.setValueAtTime(freq, t);
  g.gain.setValueAtTime(vol, t);
  g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(actx.destination);
  o.start(t);
  o.stop(t + dur);
}
const sfx = {
  join: () => { tone(523, .1); tone(784, .15, 'square', .08, .08); },
  ding: () => { tone(880, .25, 'triangle', .15); tone(1320, .4, 'triangle', .1, .1); },
  tick: () => tone(1200, .05, 'square', .04),
  whoosh: () => { [300, 450, 600, 900].forEach((f, i) => tone(f, .08, 'sawtooth', .05, i * .04)); },
  fanfare: () => { [523, 659, 784, 1046, 784, 1046].forEach((f, i) => tone(f, .22, 'square', .08, i * .14)); },
  boo: () => { tone(200, .4, 'sawtooth', .08); tone(150, .5, 'sawtooth', .08, .3); },
};

function say(text) {
  if (!audioOn || !narrator || !window.speechSynthesis) return;
  speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/_{2,}/g, 'blank'));
  u.rate = 1.05;
  u.pitch = 1.05;
  const voices = speechSynthesis.getVoices();
  const v = voices.find((v) => /en-(US|GB)/.test(v.lang) && /Daniel|Google UK English Male|Alex|Samantha|Google US/.test(v.name)) || voices.find((v) => v.lang?.startsWith('en'));
  if (v) u.voice = v;
  speechSynthesis.speak(u);
}

const LINES = {
  lobby: [
    "Welcome to Last Laugh. Grab your phones, grab a drink, and lower your standards.",
    "Scan the code, enter your name, and prepare to lose friends.",
    "Welcome, degenerates. Join on your phones. Yes, you have to put the vape down.",
  ],
  join: ["{n} is here. Things just got worse.", "Oh great, {n} showed up.", "{n} has entered the chat. Lock up your liquor.", "Welcome {n}. We've been expecting you. Unfortunately.", "{n}! The group's designated disappointment."],
  round1: "Round one. Look at your phones and answer your prompts. Be funny. Or at least be fast.",
  round2: "Round two. Everything is worth double now, so stop playing it safe, cowards.",
  round3: "Final round. The Last Laugh. Everyone answers the same prompt. This is where friendships end.",
  answering: ["Clock's ticking. Type something stupid.", "Think hard. Or don't. Honestly, it shows either way."],
  vote: ["Vote for your favorite.", "Which one made you snort?", "Pick one. Don't overthink it, you're drunk.", "Vote now. Authors, keep your mouth shut."],
  sweep: ["Total sweep! {n} just ended someone's whole career.", "Sweep! {n} gets every vote. Nobody else even tried apparently."],
  forfeit: ["{n} didn't even answer. Free points for the other guy.", "Nothing from {n}. Bold strategy."],
  tie: ["It's a tie. Equally mediocre.", "A tie! How beautifully average."],
  scores: ["Here's the damage so far.", "Let's check the scoreboard and see who's carrying.", "Scores! Somebody's in last place and everyone knows it."],
  final: "And the winner of Last Laugh is {n}! Everyone else, please reflect on your choices.",
};

// ---------------- controls ----------------
$('#muteBtn').onclick = (e) => {
  e.stopPropagation();
  narrator = !narrator;
  localStorage.setItem('ll-narrator', narrator ? 'on' : 'off');
  if (!narrator) speechSynthesis?.cancel();
  updateMuteBtn();
};
function updateMuteBtn() { $('#muteBtn').textContent = narrator ? '🔊 Narrator on' : '🔇 Narrator off'; }
updateMuteBtn();
$('#skipBtn').onclick = (e) => { e.stopPropagation(); socket.emit('host:skip'); };
$('#fsBtn').onclick = (e) => {
  e.stopPropagation();
  document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen?.();
};

// ---------------- connection ----------------
function create() {
  socket.emit('host:create', { origin: location.origin, code: sessionStorage.getItem('ll-room') }, (res) => {
    info = res;
    sessionStorage.setItem('ll-room', res.code);
    lastKey = '';
    if (S) render();
  });
}
socket.on('connect', create);
socket.on('host:state', (s) => {
  clockOffset = Date.now() - s.now;
  // announce new joins
  if (s.phase === 'lobby' && S) {
    for (const p of s.players) if (!prevPlayers.has(p.id)) { sfx.join(); say(pick(LINES.join).replace('{n}', p.name)); }
  }
  prevPlayers = new Set(s.players.map((p) => p.id));
  S = s;
  render();
});

// ---------------- timer ----------------
let timerTotal = 0, lastSec = null;
setInterval(() => {
  const el = $('#hdrTimer');
  if (!S?.deadline || ['roundIntro', 'reveal', 'scores', 'finalReveal'].includes(S.phase)) { el.innerHTML = ''; return; }
  const left = Math.max(0, (S.deadline + clockOffset - Date.now()) / 1000);
  const sec = Math.ceil(left);
  if (!timerTotal || left > timerTotal) timerTotal = left;
  el.innerHTML = `<div class="timer ${sec <= 5 ? 'urgent' : ''}" style="--p:${(left / timerTotal) * 100}%"><span>${sec}</span></div>`;
  if (sec !== lastSec && sec <= 5 && sec > 0) sfx.tick();
  lastSec = sec;
}, 200);

// ---------------- rendering ----------------
const P = (id) => S.players.find((p) => p.id === id) || { name: '???', color: '#888' };
const chipFor = (p, done) => `<div class="chip ${done ? 'done' : ''}" data-id="${p.id}" style="background:${p.color}">${esc(p.name)}</div>`;

function render() {
  if (!S || !info) return;
  const key = `${S.phase}|${S.round}|${S.matchup?.index ?? ''}`;
  const fresh = key !== lastKey;
  if (fresh) { timerTotal = 0; lastKey = key; }

  $('#hdrMid').classList.toggle('hidden', S.phase === 'lobby' || S.phase === 'end');
  $('#hdrMid').innerHTML = `Join at <b>${esc(info.origin.replace(/^https?:\/\//, ''))}</b> · Room <b>${S.code}</b>${S.audienceCount ? ` · 👀 ${S.audienceCount} audience` : ''}`;
  $('#hdrLogo').style.visibility = S.phase === 'lobby' ? 'hidden' : 'visible';

  main.classList.toggle('many', S.players.length > 6);
  const fn = VIEWS[S.phase];
  if (fn) fn(fresh);
}

const VIEWS = {
  lobby(fresh) {
    const slots = Array.from({ length: S.maxPlayers }, (_, i) => {
      const p = S.players[i];
      if (!p) return `<div class="slot">waiting…</div>`;
      return `<div class="slot filled" style="background:${p.color}">${esc(p.name)}${p.id === S.vipId ? '<span class="crown">👑 VIP</span>' : ''}</div>`;
    }).join('');
    const enough = S.players.length >= S.minPlayers;
    const vip = S.players.find((p) => p.id === S.vipId);
    main.innerHTML = `
      <div class="lobby">
        <div>
          <div class="logo"><span>LAST</span><br><span>LAUGH</span></div>
          <div class="joinbox">
            <img src="${info.qr}" alt="QR code to join" />
            <div>
              <div class="step">Scan the code or go to</div>
              <div class="url">${esc(info.origin.replace(/^https?:\/\//, ''))}</div>
              <div class="step" style="margin-top:.6em">Room code</div>
              <div class="code">${S.code}</div>
            </div>
          </div>
        </div>
        <div>
          <div class="slots">${slots}</div>
          <div class="lobby-foot">
            <div class="hint">${enough ? `${vip ? `👑 ${esc(vip.name)} can start from their phone — or ` : ''}hit start when everyone's in.` : `Need at least ${S.minPlayers} players. Extra people join as the audience.`}${S.audienceCount ? `<br>👀 ${S.audienceCount} in the audience` : ''}</div>
            <button class="btn pink" id="startBtn" ${enough ? '' : 'disabled'}>Everybody's in</button>
          </div>
        </div>
      </div>`;
    $('#startBtn').onclick = () => socket.emit('host:start');
  },

  roundIntro(fresh) {
    if (!fresh) return;
    sfx.whoosh();
    const r = S.round;
    const title = r === 3 ? 'THE LAST LAUGH' : `ROUND ${r}`;
    const sub = r === 1 ? 'Answer your prompts on your phone. Someone else got the same prompt — be funnier than them.'
      : r === 2 ? 'Same deal, but every vote is worth <b style="color:var(--yellow)">DOUBLE</b>.'
      : 'Everyone answers the same prompt. Everyone votes. Every vote is 600 points. Anything can happen.';
    main.innerHTML = `<div class="huge pop">${title}</div><div class="sub slideUp" style="animation-delay:.3s">${sub}</div>`;
    say(LINES['round' + r]);
  },

  answer(fresh) {
    if (fresh) {
      main.innerHTML = `<div class="huge pop" style="font-size:6em">📱 LOOK AT<br>YOUR PHONE</div><div class="sub">Answer both of your prompts before time runs out.</div><div class="chips" id="chips"></div>`;
      setTimeout(() => say(pick(LINES.answering)), 400);
    }
    $('#chips').innerHTML = S.players.map((p) => chipFor(p, S.done.includes(p.id))).join('');
  },

  vote(fresh) {
    const m = S.matchup;
    if (fresh) {
      sfx.whoosh();
      main.innerHTML = `
        <div class="count">Matchup ${m.index + 1} of ${m.count}</div>
        <div class="prompt pop">${esc(m.prompt)}</div>
        <div class="vs">
          <div class="answer slideUp">${esc(m.answers[0].text)}</div>
          <div class="mid">VS</div>
          <div class="answer slideUp" style="animation-delay:.2s">${esc(m.answers[1].text)}</div>
        </div>
        <div class="chips" id="chips"></div>`;
      say(`${m.prompt}. ... ${m.answers[0].text}. ... Or. ... ${m.answers[1].text}`);
    }
    const authors = m.answers.map((a) => a.id);
    const voters = S.players.filter((p) => !authors.includes(p.id) && p.connected);
    $('#chips').innerHTML = voters.map((p) => chipFor(p, m.voted.includes(p.id))).join('') + (m.audienceVoted ? `<div class="chip done" style="background:#fff">👀 ${m.audienceVoted} audience</div>` : '');
  },

  reveal(fresh) {
    if (!fresh) return;
    const m = S.matchup;
    const r = m.result;
    const [a, b] = m.answers;
    const card = (ans, i) => {
      const p = P(ans.id);
      const voters = (m.voters?.[ans.id] || []).map((id) => `<span style="background:${P(id).color}">${esc(P(id).name)}</span>`).join('');
      const audN = r.aud[ans.id];
      const won = r.gains[ans.id] > r.gains[(i ? a : b).id];
      return `<div class="answer ${won ? 'winner' : ''} ${ans.text == null ? 'noanswer' : ''}">
        <div class="pts pop" style="animation-delay:${0.6 + i * .2}s">+${r.gains[ans.id]}</div>
        ${ans.text == null ? 'no answer 🦗' : esc(ans.text)}
        <div class="votes pop" style="animation-delay:.3s">${r.tally[ans.id]} vote${r.tally[ans.id] === 1 ? '' : 's'}${audN ? ` <small style="font-size:.6em">+ ${audN} 👀</small>` : ''}</div>
        <div class="voters">${voters}</div>
        <div class="who pop" style="background:${p.color};animation-delay:.9s">${esc(p.name)}</div>
      </div>`;
    };
    let banner = '';
    let line = '';
    if (r.sweep) { banner = `SWEEP! 🧹`; line = pick(LINES.sweep).replace('{n}', P(r.sweep).name); sfx.fanfare(); }
    else if (r.forfeit) { const loser = m.answers.find((x) => x.id !== r.forfeit).id; banner = `${esc(P(loser).name)} FORFEITS 🦗`; line = pick(LINES.forfeit).replace('{n}', P(loser).name); sfx.boo(); }
    else if (r.gains[a.id] === r.gains[b.id]) { banner = `IT'S A TIE`; line = pick(LINES.tie); sfx.ding(); }
    else { const w = r.gains[a.id] > r.gains[b.id] ? a : b; line = `${P(w.id).name} wins that one.`; sfx.ding(); }
    main.innerHTML = `
      <div class="prompt" style="font-size:2.4em">${esc(m.prompt)}</div>
      <div class="vs">${card(a, 0)}<div class="mid">VS</div>${card(b, 1)}</div>
      ${banner ? `<div class="banner pop" style="animation-delay:1.2s">${banner}</div>` : ''}`;
    setTimeout(() => say(line), 600);
  },

  scores(fresh) {
    if (!fresh) return;
    renderBoard(S.round === 2 ? 'Heading into the final round…' : 'Scores');
    say(pick(LINES.scores));
  },

  finalAnswer(fresh) {
    if (fresh) {
      main.innerHTML = `<div class="count">THE LAST LAUGH · Everyone answers</div><div class="prompt pop" style="font-size:3.6em">${esc(S.final.prompt)}</div><div class="sub">Answer on your phone!</div><div class="chips" id="chips"></div>`;
      say(`Final prompt. ${S.final.prompt}`);
    }
    $('#chips').innerHTML = S.players.map((p) => chipFor(p, S.final.done.includes(p.id))).join('');
  },

  finalVote(fresh) {
    if (fresh) {
      sfx.whoosh();
      main.innerHTML = `<div class="prompt" style="font-size:2.4em;margin-bottom:.8em">${esc(S.final.prompt)}</div>
        <div class="grid">${S.final.answers.map((a, i) => `<div class="answer slideUp" style="animation-delay:${i * .12}s"><span class="tag">${i + 1}</span>${esc(a.text)}</div>`).join('')}</div>
        <div class="chips" id="chips"></div>`;
      say('Read them all, then vote for your favorite. You can\'t vote for yourself, narcissist.');
    }
    $('#chips').innerHTML = S.players.filter((p) => p.connected).map((p) => chipFor(p, S.final.voted.includes(p.id))).join('');
  },

  finalReveal(fresh) {
    if (!fresh) return;
    sfx.fanfare();
    const f = S.final;
    const r = f.result;
    const byId = Object.fromEntries(f.answers.map((a) => [a.id, a.text]));
    main.innerHTML = `<div class="prompt" style="font-size:2.2em;margin-bottom:.8em">${esc(f.prompt)}</div>
      <div class="grid">${r.ranked.map((id, i) => {
        const p = P(id);
        return `<div class="answer pop ${i === 0 && r.gains[id] > 0 ? 'winner' : ''}" style="animation-delay:${(r.ranked.length - i) * .35}s">
          <div class="pts">+${r.gains[id]}</div>
          ${esc(byId[id])}
          <div class="votes">${r.tally[id]} vote${r.tally[id] === 1 ? '' : 's'}${r.aud[id] ? ` <small style="font-size:.6em">+ ${r.aud[id]} 👀</small>` : ''}</div>
          <div class="who" style="background:${p.color}">${esc(p.name)}</div>
        </div>`;
      }).join('')}</div>`;
    const top = r.ranked[0];
    if (top) setTimeout(() => say(`The crowd's favorite: ${byId[top]}. by ${P(top).name}.`), 800);
  },

  end(fresh) {
    if (!fresh) return;
    const sorted = [...S.players].sort((a, b) => b.score - a.score);
    const w = sorted[0];
    const tied = sorted.filter((p) => p.score === w.score);
    const name = tied.map((p) => esc(p.name)).join(' & ');
    main.innerHTML = `
      <div class="crown-big">👑</div>
      <div class="winner-name pop" style="color:${w.color}">${name}</div>
      <div class="sub">${tied.length > 1 ? 'WIN (tie, somehow)' : 'WINS'} with ${w.score.toLocaleString()} points</div>
      <div class="board" style="margin-top:1.5em;max-width:40em" id="endBoard"></div>
      <div style="margin-top:1.6em;display:flex;gap:1em">
        <button class="btn pink" id="againBtn">Play again</button>
        <button class="btn ghost" id="newBtn">New room</button>
      </div>`;
    $('#endBoard').innerHTML = boardRows(sorted, false);
    $('#againBtn').onclick = () => socket.emit('playAgain');
    $('#newBtn').onclick = () => { sessionStorage.removeItem('ll-room'); location.reload(); };
    sfx.fanfare();
    setTimeout(() => sfx.fanfare(), 1000);
    say(LINES.final.replace('{n}', tied.map((p) => p.name).join(' and ')));
  },
};

function boardRows(sorted, showGain = true) {
  const max = Math.max(1, ...sorted.map((p) => p.score));
  return sorted.map((p, i) => `
    <div class="row slideUp" style="animation-delay:${i * .08}s">
      <div class="rank">${i + 1}</div>
      <div class="bar" style="background:${p.color};width:0%" data-w="${Math.max(18, (p.score / max) * 100)}%">${esc(p.name)}</div>
      <div class="score">${p.score.toLocaleString()}</div>
      ${showGain && p.lastGain ? `<div class="gain">+${p.lastGain}</div>` : ''}
    </div>`).join('');
}

function renderBoard(title) {
  const sorted = [...S.players].sort((a, b) => b.score - a.score);
  main.innerHTML = `<div class="huge pop board-title" style="font-size:4.5em;margin-bottom:.6em">${title}</div><div class="board">${boardRows(sorted)}</div>`;
  growBars();
}
function growBars() {
  requestAnimationFrame(() => setTimeout(() => document.querySelectorAll('.bar[data-w]').forEach((b) => (b.style.width = b.dataset.w)), 100));
}
// also grow bars on end screen
new MutationObserver(() => { if (document.querySelector('.bar[data-w]')) growBars(); }).observe(main, { childList: true });
