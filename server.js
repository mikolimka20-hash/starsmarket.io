// server.js
require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');
const fs = require('fs');
const crypto = require('crypto');
const cors = require('cors');
const app = express();

const PORT = process.env.PORT || 3000;
const BOT_TOKEN = process.env.BOT_TOKEN;
const BOT_USERNAME = process.env.BOT_USERNAME; // without @
const PAYMENT_PROVIDER_TOKEN = process.env.PAYMENT_PROVIDER_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_this_secret';
const DB_PATH = './db.json';

if (!BOT_TOKEN || !PAYMENT_PROVIDER_TOKEN || !BOT_USERNAME) {
  console.warn('WARNING: set BOT_TOKEN, PAYMENT_PROVIDER_TOKEN and BOT_USERNAME in .env');
}

// simple file DB helpers
function loadDB() {
  if (!fs.existsSync(DB_PATH)) fs.writeFileSync(DB_PATH, JSON.stringify({ users: {}, gifts: {}, purchases: [] }, null, 2));
  return JSON.parse(fs.readFileSync(DB_PATH));
}
function saveDB(db) { fs.writeFileSync(DB_PATH, JSON.stringify(db, null, 2)); }

app.use(bodyParser.json());
app.use(cors());
app.use(express.static('public'));

// Utils
function calculateRubles(stars) {
  return +(stars * 1.5 * 1.04).toFixed(2);
}
async function tgApi(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.json();
}

// --- Telegram Login verification for WebApp initData ---
// When Telegram Login widget redirects to /auth we verify server-side (we also allow WebApp approach by passing init data)
function verifyTelegramLogin(query) {
  // query is object from URL params
  const hash = query.hash;
  if (!hash) return false;
  const data = { ...query };
  delete data.hash;
  const keys = Object.keys(data).sort();
  const data_check_arr = keys.map(k => `${k}=${data[k]}`);
  const data_check_string = data_check_arr.join('\n');

  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secret).update(data_check_string).digest('hex');
  return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(hash, 'hex'));
}

// --- ROUTES ---

// Auth redirect (Telegram Login Widget uses this as data-auth-url)
app.get('/auth', (req, res) => {
  if (!verifyTelegramLogin(req.query)) return res.status(403).send('Invalid Telegram login');
  const db = loadDB();
  const data = req.query; // contains id, first_name, username, photo_url, auth_date, hash
  const id = String(data.id);
  db.users[id] = db.users[id] || { id, username: data.username || data.first_name || `tg${id}`, avatar: data.photo_url || '', stars: db.users[id]?.stars || 0, gifts: db.users[id]?.gifts || [] };
  saveDB(db);
  // redirect to frontend with userId
  return res.redirect(`/index.html?userId=${encodeURIComponent(id)}`);
});

// Endpoint used by frontend to get current user (supports two modes):
// 1) ?userId=... (after redirect) OR
// 2) x-telegram-initdata header contains initData — if so, server verifies and returns user
app.get('/api/user', (req, res) => {
  const db = loadDB();

  // prefer explicit query param
  const explicitId = req.query.userId;
  if (explicitId) {
    const user = db.users[explicitId];
    if (!user) return res.status(404).json({ error: 'User not found' });
    return res.json(user);
  }

  // else try WebApp init data header (frontend must forward it)
  const initData = req.headers['x-telegram-initdata'];
  if (!initData) return res.status(400).json({ error: 'No userId or initData' });

  // parse initData into map
  try {
    const params = new URLSearchParams(initData);
    const hash = params.get('hash');
    if (!hash) return res.status(400).json({ error: 'Invalid initData' });

    // verify using same algorithm as Telegram
    const dataObj = {};
    for (const [k, v] of params) dataObj[k] = v;
    if (!verifyTelegramLogin(dataObj)) return res.status(403).json({ error: 'Invalid initData signature' });

    const userJson = JSON.parse(dataObj.user);
    const id = String(userJson.id);
    db.users[id] = db.users[id] || { id, username: userJson.username || userJson.first_name, avatar: userJson.photo_url || '', stars: db.users[id]?.stars || 0, gifts: db.users[id]?.gifts || [] };
    saveDB(db);
    return res.json(db.users[id]);
  } catch (e) {
    return res.status(400).json({ error: 'Bad initData' });
  }
});

// get public gifts for shop
app.get('/api/gifts', (req, res) => {
  const db = loadDB();
  const gifts = Object.values(db.gifts).filter(g => g.for_sale && !g.sold);
  res.json(gifts);
});

// get user's gifts (frontend will call with ?userId=... or x-telegram-initdata header)
app.get('/api/my_gifts', (req, res) => {
  const db = loadDB();
  const explicitId = req.query.userId;
  if (explicitId) {
    const ids = db.users[explicitId]?.gifts || [];
    return res.json(ids.map(id => db.gifts[id]).filter(Boolean));
  }

  const initData = req.headers['x-telegram-initdata'];
  if (!initData) return res.status(400).json({ error: 'No initData or userId' });
  const params = new URLSearchParams(initData);
  const dataObj = {};
  for (const [k, v] of params) dataObj[k] = v;
  if (!verifyTelegramLogin(dataObj)) return res.status(403).json({ error: 'Invalid initData signature' });
  const userJson = JSON.parse(dataObj.user);
  const id = String(userJson.id);
  db.users[id] = db.users[id] || { id, username: userJson.username || userJson.first_name, avatar: userJson.photo_url || '', stars: db.users[id]?.stars || 0, gifts: db.users[id]?.gifts || [] };
  saveDB(db);
  const ids = db.users[id].gifts || [];
  res.json(ids.map(i => db.gifts[i]).filter(Boolean));
});

// Endpoint to add a gift to user's local inventory (e.g., create a gift in db not for sale)
app.post('/api/create_gift', (req, res) => {
  const { ownerId, name, description, stars } = req.body;
  if (!ownerId || !name) return res.status(400).json({ error: 'ownerId and name required' });
  const db = loadDB();
  const id = `gift-${Date.now()}`;
  const gift = { id, ownerId, name, description: description || '', stars: Number(stars) || 1, for_sale: false, sold: false };
  db.gifts[id] = gift;
  db.users[ownerId] = db.users[ownerId] || { id: ownerId, username: ownerId, avatar: '', stars: 0, gifts: [] };
  db.users[ownerId].gifts = db.users[ownerId].gifts || [];
  db.users[ownerId].gifts.push(id);
  saveDB(db);
  return res.json({ ok: true, gift });
});

// endpoint to put a user's gift up for sale
app.post('/api/sell_gift', (req, res) => {
  const { id, priceStars } = req.body;
  const db = loadDB();
  const gift = db.gifts[id];
  if (!gift) return res.status(404).json({ error: 'gift not found' });
  gift.for_sale = true;
  if (priceStars) gift.stars = Number(priceStars);
  saveDB(db);
  return res.json({ ok: true, gift });
});

// Initiate purchase: server will call sendInvoice via Telegram API
// Body: { buyerId, giftId }
// Returns invoice result or error
app.post('/api/purchase', async (req, res) => {
  try {
    const { buyerId, giftId } = req.body;
    const db = loadDB();
    const gift = db.gifts[giftId];
    if (!gift || gift.sold || !gift.for_sale) return res.status(400).json({ error: 'Gift not available' });

    // compute price (rubles)
    const rub = calculateRubles(gift.stars); // e.g. 1 star = 1.5 * 1.04
    // Telegram requires prices in integer of smallest unit (kopecks)
    const amountKopecks = Math.round(rub * 100);

    // payload: giftId:buyerId
    const payload = `${giftId}:${buyerId}`;

    // Build invoice
    const invoice = {
      chat_id: buyerId,
      title: gift.name,
      description: gift.description || 'Покупка подарка',
      payload,
      provider_token: PAYMENT_PROVIDER_TOKEN,
      currency: 'RUB',
      prices: [{ label: gift.name, amount: amountKopecks }],
      start_parameter: `buy-${giftId}`
    };

    const result = await tgApi('sendInvoice', invoice);
    return res.json({ ok: true, result });
  } catch (err) {
    console.error('purchase error', err);
    return res.status(500).json({ error: 'internal' });
  }
});

// Telegram webhook to receive updates (including successful_payment)
// Set via setWebhook to https://yourdomain.com/webhook
app.post('/webhook', async (req, res) => {
  try {
    const update = req.body;

    // handle successful payment in message
    if (update && update.message && update.message.successful_payment) {
      const sp = update.message.successful_payment;
      const payload = sp.invoice_payload; // our payload giftId:buyerId
      const chatId = update.message.chat.id;
      const [giftId, buyerId] = payload.split(':');

      const db = loadDB();
      const gift = db.gifts[giftId];
      if (!gift || gift.sold) {
        return res.sendStatus(200);
      }

      // mark as sold
      gift.sold = true;
      gift.for_sale = false;

      // credit stars to seller
      const seller = db.users[gift.ownerId];
      if (seller) {
        seller.stars = (seller.stars || 0) + gift.stars;
      }

      // record purchase
      db.purchases.push({ giftId, buyerId, sellerId: gift.ownerId, amountRUB: calculateRubles(gift.stars), date: new Date().toISOString() });
      saveDB(db);

      // send a message to buyer (deliver gift)
      await tgApi('sendMessage', { chat_id: chatId, text: `Поздравляем! Вы получили подарок: ${gift.name} 🎁` });

      // optionally notify seller (if we can): send seller a message if we have seller.id and it's a real chat id
      if (seller && seller.id) {
        try {
          await tgApi('sendMessage', { chat_id: seller.id, text: `Ваш подарок "${gift.name}" был продан — на ваш баланс зачислено ${gift.stars} ⭐` });
        } catch (e) { console.warn('notify seller failed', e.message); }
      }

      return res.sendStatus(200);
    }

    // ignore other updates
    return res.sendStatus(200);
  } catch (err) {
    console.error('webhook error', err);
    return res.sendStatus(500);
  }
});

// simple health
app.get('/health', (req, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log(`✅ Server running on http://localhost:${PORT}`);
});
