// Jonli Quiz serveri. Hech qanday npm paketi kerak emas (Node 18+).
// Tarkibi: 1) saqlash  2) o'yin mantig'i  3) WebSocket (RFC6455)  4) HTTP
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const PORT = process.env.PORT || 3000;
const FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const GRACE = 300; // tarmoq kechikishi uchun qo'shimcha vaqt (ms)
const rooms = new Map(), all = new Set();

// ---------- 1. Saqlash: xonalar data.json ga yoziladi (server qayta ishga tushsa ham yo'qolmaydi) ----------
let saveT;
function save() {
  clearTimeout(saveT);
  saveT = setTimeout(() => {
    const d = [...rooms.values()].map(r => ({ code: r.code, key: r.key, qs: r.qs, state: r.state, qi: r.qi, end: r.end, made: r.made, players: [...r.players] }));
    fs.writeFile(FILE, JSON.stringify(d), () => {});
  }, 1000);
}
try {
  for (const x of JSON.parse(fs.readFileSync(FILE)))
    rooms.set(x.code, { ...x, players: new Map(x.players), socks: new Set(), state: x.state === 'question' ? 'reveal' : x.state, timer: null, pt: 0 });
} catch {}

// ---------- 2. O'yin mantig'i ----------
// Xona kodi: 6 xonali raqam (takrorlanmaydi)
const newCode = () => { let c; do c = String(100000 + Math.floor(Math.random() * 900000)); while (rooms.has(c)); return c; };

// Savollarni tekshirish: 1-100 ta savol, 4 ta variant, to'g'ri javob 0-3, vaqt 5-120 s
function cleanQs(a) {
  if (!Array.isArray(a) || !a.length || a.length > 100) return null;
  const out = [];
  for (const x of a) {
    const q = String(x.q || '').trim().slice(0, 300);
    const o = Array.isArray(x.o) ? x.o.map(v => String(v || '').trim().slice(0, 120)) : [];
    const c = +x.c, time = Math.min(120, Math.max(5, +x.time || 20));
    if (!q || o.length !== 4 || o.some(v => !v) || !(c >= 0 && c <= 3)) return null;
    out.push({ q, o, c, time });
  }
  return out;
}

// Reyting: ball bo'yicha kamayish; teng bo'lsa — to'g'ri javoblarga ketgan umumiy vaqt kam bo'lgan yuqori
const rank = r => [...r.players].map(([sid, p]) => ({ sid, ...p })).sort((a, b) => b.score - a.score || a.ms - b.ms);

// Har bir ulanish uchun alohida "ko'rinish". To'g'ri javob qatnashchiga FAQAT reveal'da yuboriladi.
function view(r, ws, sorted) {
  const role = ws.role, q = r.qs[r.qi];
  const o = { t: 'state', now: Date.now(), state: r.state, code: r.code, n: r.qs.length, qi: r.qi, count: r.players.size };
  if (q && (r.state === 'question' || r.state === 'reveal')) {
    o.q = { text: q.q, o: q.o, time: q.time }; o.end = r.end;
    o.answered = [...r.players.values()].filter(p => p.a[r.qi]).length;
    if (r.state === 'reveal') o.correct = q.c; // to'g'ri javob faqat natija ko'rsatilganda
  }
  if (r.state === 'lobby' && role === 'host') o.names = [...r.players.values()].map(p => p.name);
  if (r.state === 'reveal' || r.state === 'end') o.top = sorted.slice(0, 10).map(p => ({ n: p.name, s: p.score, me: p.sid === ws.sid }));
  if (role === 'play') {
    const p = r.players.get(ws.sid), a = p && p.a[r.qi];
    o.me = { name: p.name, score: p.score, rank: sorted.findIndex(x => x.sid === ws.sid) + 1, ans: a ? a.i : null };
    if (r.state === 'reveal') { o.me.ok = a ? a.ok : null; o.me.pts = a ? a.pts : 0; }
  }
  return o;
}
function push(r, f) { const s = rank(r); for (const ws of r.socks) if (!f || f(ws)) ws.send(view(r, ws, s)); save(); }
// Ko'p kishi qo'shilganda yuklamani kamaytirish uchun yangilanishlar 150 ms ichida birlashtiriladi
function pushSoon(r) { if (r.pt) return; r.pt = setTimeout(() => { r.pt = 0; push(r); }, 150); }

function startQ(r, i) {
  clearTimeout(r.timer);
  r.qi = i; r.state = 'question';
  r.end = Date.now() + r.qs[i].time * 1000;                 // server vaqti — countdown manbai
  r.timer = setTimeout(() => reveal(r), r.qs[i].time * 1000 + GRACE);
  push(r);
}
function reveal(r) { if (r.state !== 'question') return; clearTimeout(r.timer); r.state = 'reveal'; push(r); }
function finish(r) { clearTimeout(r.timer); r.state = 'end'; push(r); }

// Javob qabul qilish va ball hisoblash (faqat serverda).
// To'g'ri javob: 1000 dan 500 gacha (qancha kech bo'lsa, shuncha kam). Noto'g'ri yoki javobsiz: 0.
function answer(ws, i) {
  const r = ws.room, p = r && r.players.get(ws.sid), now = Date.now();
  if (!p || r.state !== 'question' || now > r.end + GRACE || p.a[r.qi] || !(i >= 0 && i <= 3)) return;
  const q = r.qs[r.qi], lim = q.time * 1000, el = Math.min(lim, Math.max(0, now - (r.end - lim)));
  const ok = i === q.c, pts = ok ? Math.round(1000 - 500 * el / lim) : 0;
  p.a[r.qi] = { i, ok, pts }; p.score += pts; if (ok) p.ms += el;
  push(r, w => w.role !== 'play' || w === ws);              // boshqalar bu javobni ko'rmaydi
  if ([...r.players.values()].every(x => x.a[r.qi])) reveal(r); // hamma javob bergan bo'lsa — darhol natija
}

function attach(ws, r, role) { ws.room = r; ws.role = role; r.socks.add(ws); }
const err = (ws, e) => ws.send({ t: 'err', e });

function onMsg(ws, m) {
  const r = ws.room;
  switch (m.t) {
    case 'create': { // yangi xona
      const qs = cleanQs(m.qs);
      if (!qs) return err(ws, 'Savollarni tekshiring: matn, 4 ta variant va to‘g‘ri javob to‘ldirilishi kerak');
      const room = { code: newCode(), key: crypto.randomUUID(), qs, state: 'lobby', qi: -1, end: 0, made: Date.now(), players: new Map(), socks: new Set(), timer: null, pt: 0 };
      rooms.set(room.code, room); save();
      return ws.send({ t: 'created', code: room.code, key: room.key });
    }
    case 'host': case 'screen': { // boshlovchi (kalit bilan) yoki katta ekran
      const x = rooms.get(String(m.code));
      if (!x || (m.t === 'host' && x.key !== m.key)) return err(ws, 'Xona topilmadi');
      attach(ws, x, m.t); return push(x, w => w === ws);
    }
    case 'join': { // qatnashchi; sid bo'lsa — qayta ulanish
      const x = rooms.get(String(m.code || '').trim());
      if (!x) return err(ws, 'Xona kodi noto‘g‘ri');
      const name = String(m.name || '').trim().slice(0, 20);
      if (!name) return err(ws, 'Ismingizni kiriting');
      let sid = m.sid;
      if (!x.players.has(sid)) {
        if (x.state === 'end') return err(ws, 'O‘yin tugagan');
        if (x.players.size >= 150) return err(ws, 'Xona to‘lgan');
        sid = crypto.randomUUID(); x.players.set(sid, { name, score: 0, ms: 0, a: {} });
      }
      attach(ws, x, 'play'); ws.sid = sid;
      ws.send({ t: 'joined', sid, name: x.players.get(sid).name });
      push(x, w => w === ws); return pushSoon(x);
    }
    case 'answer': return answer(ws, +m.i);
  }
  if (!r || ws.role !== 'host') return; // quyida faqat boshlovchi buyruqlari
  if (m.t === 'start' && r.state === 'lobby') startQ(r, 0);
  else if (m.t === 'reveal') reveal(r);
  else if (m.t === 'next' && r.state === 'reveal') r.qi + 1 < r.qs.length ? startQ(r, r.qi + 1) : finish(r);
  else if (m.t === 'end') finish(r);
}

// ---------- 3. WebSocket (qo'lda, kutubxonasiz) ----------
function frame(sock, op, p) {
  if (sock.destroyed) return;
  const l = p.length; let h;
  if (l < 126) h = Buffer.from([128 | op, l]);
  else if (l < 65536) { h = Buffer.alloc(4); h[0] = 128 | op; h[1] = 126; h.writeUInt16BE(l, 2); }
  else { h = Buffer.alloc(10); h[0] = 128 | op; h[1] = 127; h.writeBigUInt64BE(BigInt(l), 2); }
  sock.write(Buffer.concat([h, p]));
}

const server = http.createServer((req, res) => {
  // ---------- 4. HTTP: barcha sahifalar (/, /play, /host/:kod, /screen/:kod) bitta index.html ----------
  if (req.url === '/health') return res.end('ok');
  fs.readFile(path.join(__dirname, 'index.html'), (e, d) => { res.writeHead(e ? 500 : 200, { 'Content-Type': 'text/html; charset=utf-8' }); res.end(d); });
});

server.on('upgrade', (req, sock) => {
  const k = req.headers['sec-websocket-key'];
  if (req.url !== '/ws' || !k) return sock.destroy();
  sock.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
    crypto.createHash('sha1').update(k + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64') + '\r\n\r\n');
  sock.setNoDelay(true);
  const ws = { sock, room: null, role: null, sid: null, send: o => frame(sock, 1, Buffer.from(JSON.stringify(o))) };
  all.add(ws);
  let buf = Buffer.alloc(0);
  sock.on('data', d => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 2) {
      const op = buf[0] & 15; let len = buf[1] & 127, off = 2;
      if (len === 126) { if (buf.length < 4) break; len = buf.readUInt16BE(2); off = 4; }
      else if (len === 127) { if (buf.length < 10) break; len = Number(buf.readBigUInt64BE(2)); off = 10; }
      if (len > 65536) return sock.destroy();
      if (buf.length < off + 4 + len) break;
      const mask = buf.subarray(off, off + 4), data = Buffer.from(buf.subarray(off + 4, off + 4 + len));
      for (let i = 0; i < len; i++) data[i] ^= mask[i & 3];
      buf = buf.subarray(off + 4 + len);
      if (op === 8) return sock.end();
      if (op === 9) frame(sock, 10, data);
      else if (op === 1) { try { onMsg(ws, JSON.parse(data)); } catch (e) { console.error(e.message); } }
    }
  });
  sock.on('error', () => {});
  sock.on('close', () => { // qatnashchi ma'lumotlari saqlanadi — qayta ulansa, davom etadi
    all.delete(ws);
    if (ws.room) { ws.room.socks.delete(ws); if (ws.role === 'play') pushSoon(ws.room); }
  });
});

setInterval(() => { for (const w of all) frame(w.sock, 9, Buffer.alloc(0)); }, 25000); // ulanishni tirik tutish
setInterval(() => { for (const [c, r] of rooms) if (Date.now() - r.made > 12 * 3600e3) { clearTimeout(r.timer); rooms.delete(c); } }, 3600e3);
server.listen(PORT, () => console.log('Quiz server: http://localhost:' + PORT));
