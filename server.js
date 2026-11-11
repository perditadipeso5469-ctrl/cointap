// Coin Tap server: Telegram login check, server-side balance, ad rewards, withdraw + admin panel
const express = require('express');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

// ===== ENV (hosting site e boshabe) =====
const BOT_TOKEN       = process.env.BOT_TOKEN || '';       // BotFather token
const ADMIN_ID        = process.env.ADMIN_ID || '';        // apnar Telegram numeric ID
const ADMIN_KEY       = process.env.ADMIN_KEY || '';       // admin panel er gopon password
const POSTBACK_SECRET = process.env.POSTBACK_SECRET || ''; // Monetag postback secret (optional)
const DATA_FILE       = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const PORT            = process.env.PORT || 3000;

// ===== SETTINGS =====
const CFG = {
  tapMax: 50,          // ek request e max tap
  tapPerSec: 8,        // server e max tap speed
  videoReward: 50,
  popReward: 25,
  adDailyCap: 30,      // ekjon user dine max koyta ad reward
  adCooldownSec: 20,   // (postback chhara mode) ad claim er gap
  minWithdraw: 5000,
  coinsPerTaka: 100,
  methods: ['bKash', 'Nagad', 'Rocket'],
};

// ===== SIMPLE JSON STORE =====
let db = { users: {}, withdrawals: [] };
try { db = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8')); } catch (e) {}
let dirty = false;
function flush() {
  if (!dirty) return;
  dirty = false;
  try {
    fs.writeFileSync(DATA_FILE + '.tmp', JSON.stringify(db));
    fs.renameSync(DATA_FILE + '.tmp', DATA_FILE);
  } catch (e) { console.error('save failed', e.message); dirty = true; }
}
setInterval(flush, 2000);
process.on('SIGTERM', () => { flush(); process.exit(0); });
process.on('SIGINT', () => { flush(); process.exit(0); });

const today = () => new Date().toISOString().slice(0, 10);
function getUser(tg) {
  const id = String(tg.id);
  if (!db.users[id]) {
    db.users[id] = { id, name: tg.username ? '@' + tg.username : (tg.first_name || 'user'),
      balance: 0, tapTokens: CFG.tapMax, lastTap: Date.now(), adDay: '', adsToday: 0, lastAdClaim: 0, created: Date.now() };
    dirty = true;
  }
  return db.users[id];
}
function creditAd(u, reward) {
  const d = today();
  if (u.adDay !== d) { u.adDay = d; u.adsToday = 0; }
  if (u.adsToday >= CFG.adDailyCap) return false;
  u.adsToday++; u.balance += reward; dirty = true;
  return true;
}

// ===== TELEGRAM =====
function verifyInitData(initData) {
  if (!BOT_TOKEN || !initData) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const str = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(BOT_TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(str).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date')) > 86400) return null;
  try { return JSON.parse(p.get('user')); } catch (e) { return null; }
}
async function sendMsg(chatId, text) {
  if (!BOT_TOKEN || !chatId) return;
  try {
    await fetch('https://api.telegram.org/bot' + BOT_TOKEN + '/sendMessage', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch (e) { console.error('sendMsg failed', e.message); }
}

// ===== APP =====
const app = express();
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));

function auth(req, res, next) {
  const tg = verifyInitData(req.get('x-init-data'));
  if (!tg) return res.status(401).json({ error: 'Open this app from Telegram' });
  req.u = getUser(tg);
  next();
}
const publicCfg = () => ({
  videoReward: CFG.videoReward, popReward: CFG.popReward, minWithdraw: CFG.minWithdraw,
  coinsPerTaka: CFG.coinsPerTaka, methods: CFG.methods, postbackMode: !!POSTBACK_SECRET,
});

app.post('/api/me', auth, (req, res) => res.json({ balance: req.u.balance, cfg: publicCfg() }));

app.post('/api/tap', auth, (req, res) => {
  const u = req.u, now = Date.now();
  u.tapTokens = Math.min(CFG.tapMax, u.tapTokens + ((now - u.lastTap) / 1000) * CFG.tapPerSec);
  u.lastTap = now;
  const want = Math.max(0, Math.min(parseInt(req.body.n, 10) || 0, CFG.tapMax));
  const give = Math.floor(Math.min(want, u.tapTokens));
  u.tapTokens -= give; u.balance += give; dirty = true;
  res.json({ balance: u.balance });
});

// Mode A: Monetag postback (safe). Monetag calls this URL after a valid ad view.
app.get('/postback', (req, res) => {
  if (!POSTBACK_SECRET || req.query.secret !== POSTBACK_SECRET) return res.status(403).send('forbidden');
  const u = db.users[String(req.query.ymid || '')];
  if (!u) return res.send('no user');
  const ev = req.query.reward_event_type;
  if (ev && ev !== 'valued') return res.send('not valued');
  const reward = req.query.request_var === 'pop' ? CFG.popReward : CFG.videoReward;
  res.send(creditAd(u, reward) ? 'ok' : 'cap');
});

// Mode B: client claim (easier but cheatable). Works only if POSTBACK_SECRET is NOT set.
app.post('/api/ad/claim', auth, (req, res) => {
  if (POSTBACK_SECRET) return res.status(403).json({ error: 'disabled' });
  const u = req.u, now = Date.now();
  if (now - u.lastAdClaim < CFG.adCooldownSec * 1000) return res.status(429).json({ error: 'Too fast. Wait a bit.' });
  u.lastAdClaim = now;
  const ok = creditAd(u, req.body.type === 'pop' ? CFG.popReward : CFG.videoReward);
  if (!ok) return res.status(429).json({ error: 'Daily ad limit reached' });
  res.json({ balance: u.balance });
});

app.post('/api/withdraw', auth, async (req, res) => {
  const u = req.u;
  const { method, number } = req.body;
  const amount = parseInt(req.body.amount, 10);
  if (!CFG.methods.includes(method)) return res.status(400).json({ error: 'Bad method' });
  if (!/^01[0-9]{9}$/.test(String(number))) return res.status(400).json({ error: 'Enter a valid 11-digit number' });
  if (!amount || amount < CFG.minWithdraw) return res.status(400).json({ error: 'Minimum is ' + CFG.minWithdraw + ' coins' });
  if (amount > u.balance) return res.status(400).json({ error: 'Not enough coins' });
  if (db.withdrawals.some(w => w.uid === u.id && w.status === 'pending'))
    return res.status(400).json({ error: 'You already have a pending request' });
  u.balance -= amount;
  const w = { id: db.withdrawals.length + 1, uid: u.id, name: u.name, method, number: String(number),
    coins: amount, taka: +(amount / CFG.coinsPerTaka).toFixed(2), status: 'pending', time: Date.now() };
  db.withdrawals.push(w); dirty = true;
  sendMsg(ADMIN_ID, `New withdraw #${w.id}\n${w.name} (ID ${w.uid})\n${w.method}: ${w.number}\n${w.taka} Taka (${w.coins} coins)`);
  res.json({ balance: u.balance });
});

// ===== ADMIN PANEL: /admin?key=ADMIN_KEY =====
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const keyOk = k => ADMIN_KEY && typeof k === 'string' && k.length === ADMIN_KEY.length &&
  crypto.timingSafeEqual(Buffer.from(k), Buffer.from(ADMIN_KEY));

app.get('/admin', (req, res) => {
  if (!keyOk(req.query.key)) return res.status(403).send('forbidden');
  const rows = db.withdrawals.slice().reverse().map(w => `
    <tr><td>#${w.id}</td><td>${esc(w.name)}<br><small>${esc(w.uid)}</small></td>
    <td>${esc(w.method)}<br>${esc(w.number)}</td><td>${w.taka} Tk<br><small>${w.coins} coins</small></td>
    <td>${esc(w.status)}</td><td>${w.status === 'pending' ? `
      <form method="post" action="/admin/act" style="display:inline">
        <input type="hidden" name="key" value="${esc(req.query.key)}"><input type="hidden" name="id" value="${w.id}">
        <button name="action" value="paid">Paid</button>
        <button name="action" value="reject">Reject</button></form>` : ''}</td></tr>`).join('');
  res.send(`<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1">
  <title>Admin</title><style>body{font-family:sans-serif;padding:12px}table{border-collapse:collapse;width:100%}
  td,th{border:1px solid #ccc;padding:6px;font-size:14px;text-align:left}button{padding:6px 10px;margin:2px}</style>
  <h2>Withdraw requests</h2><p>Users: ${Object.keys(db.users).length}</p>
  <table><tr><th>ID</th><th>User</th><th>Account</th><th>Amount</th><th>Status</th><th></th></tr>${rows}</table>`);
});

app.post('/admin/act', async (req, res) => {
  if (!keyOk(req.body.key)) return res.status(403).send('forbidden');
  const w = db.withdrawals.find(x => x.id === parseInt(req.body.id, 10));
  if (w && w.status === 'pending') {
    if (req.body.action === 'paid') {
      w.status = 'paid';
      sendMsg(w.uid, `Your withdrawal of ${w.taka} Taka was sent to your ${w.method} number.`);
    } else if (req.body.action === 'reject') {
      w.status = 'rejected';
      if (db.users[w.uid]) db.users[w.uid].balance += w.coins; // refund
      sendMsg(w.uid, `Your withdrawal #${w.id} was rejected. Coins were returned to your balance.`);
    }
    dirty = true;
  }
  res.redirect('/admin?key=' + encodeURIComponent(req.body.key));
});

app.listen(PORT, () => console.log('Coin Tap running on ' + PORT));
