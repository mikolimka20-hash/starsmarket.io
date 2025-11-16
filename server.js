require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const crypto = require('crypto');
const fetch = require('node-fetch');
const { createClient } = require('@supabase/supabase-js');

const app = express();
const PORT = process.env.PORT || 3000;

const BOT_TOKEN = process.env.BOT_TOKEN;
const PAYMENT_PROVIDER_TOKEN = process.env.PAYMENT_PROVIDER_TOKEN;
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

app.use(bodyParser.json());
app.use(express.static('public'));

async function tgApi(method, body) {
  const url = `https://api.telegram.org/bot${BOT_TOKEN}/${method}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
  return res.json();
}

function calculateRubles(stars) {
  return +(stars * 1.5 * 1.04).toFixed(2);
}

function verifyTelegramLogin(query) {
  const hash = query.hash;
  if (!hash) return false;

  const dataCopy = { ...query };
  delete dataCopy.hash;

  const keys = Object.keys(dataCopy).sort();
  const dataString = keys.map(k => `${k}=${dataCopy[k]}`).join('\n');

  const secret = crypto.createHash('sha256').update(BOT_TOKEN).digest();
  const hmac = crypto.createHmac('sha256', secret).update(dataString).digest('hex');

  return crypto.timingSafeEqual(Buffer.from(hmac, 'hex'), Buffer.from(hash, 'hex'));
}

// --------------------- AUTH ---------------------
app.get('/auth', async (req, res) => {
  if (!verifyTelegramLogin(req.query))
    return res.status(403).send("Invalid Telegram Login");

  const id = String(req.query.id);
  const username = req.query.username || req.query.first_name;
  const avatar = req.query.photo_url || '';

  await supabase.from('users').upsert({
    id,
    username,
    avatar
  });

  res.redirect(`/index.html?userId=${encodeURIComponent(id)}`);
});

// ---------------------- USER API ----------------------
app.get('/api/user', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "No userId" });

  const { data } = await supabase.from('users').select('*').eq('id', userId).single();
  res.json(data || {});
});

// ---------------------- GIFTS LIST ----------------------
app.get('/api/gifts', async (req, res) => {
  const { data } = await supabase
    .from('gifts')
    .select('*')
    .eq('for_sale', true)
    .eq('sold', false);

  res.json(data || []);
});

// ---------------------- MY GIFTS ----------------------
app.get('/api/my_gifts', async (req, res) => {
  const userId = req.query.userId;
  if (!userId) return res.status(400).json({ error: "No userId" });

  const { data } = await supabase
    .from('gifts')
    .select('*')
    .eq('owner_id', userId);

  res.json(data || []);
});

// ---------------------- CREATE GIFT ----------------------
app.post('/api/create_gift', async (req, res) => {
  const { ownerId, name, description, stars } = req.body;

  if (!ownerId || !name)
    return res.status(400).json({ error: "ownerId and name required" });

  const id = `gift-${Date.now()}`;

  await supabase.from('gifts').insert({
    id,
    owner_id: ownerId,
    name,
    description: description || '',
    stars: Number(stars) || 1,
    for_sale: false,
    sold: false
  });

  res.json({ ok: true });
});

// ---------------------- SELL GIFT ----------------------
app.post('/api/sell_gift', async (req, res) => {
  const { id, priceStars } = req.body;

  await supabase.from('gifts').update({
    for_sale: true,
    stars: Number(priceStars)
  }).eq('id', id);

  res.json({ ok: true });
});

// ---------------------- PURCHASE ----------------------
app.post('/api/purchase', async (req, res) => {
  const { buyerId, giftId } = req.body;

  const { data: gift } = await supabase
    .from('gifts')
    .select('*')
    .eq('id', giftId)
    .single();

  if (!gift || gift.sold || !gift.for_sale)
    return res.status(400).json({ error: "Gift not available" });

  const rub = calculateRubles(gift.stars);

  const invoice = {
    chat_id: buyerId,
    title: gift.name,
    description: gift.description,
    payload: `${giftId}:${buyerId}`,
    provider_token: PAYMENT_PROVIDER_TOKEN,
    currency: "RUB",
    prices: [{ label: gift.name, amount: Math.round(rub * 100) }]
  };

  const result = await tgApi("sendInvoice", invoice);
  res.json({ ok: true, result });
});

// ---------------------- WEBHOOK ----------------------
app.post('/webhook', async (req, res) => {
  const update = req.body;

  if (update?.message?.successful_payment) {
    const sp = update.message.successful_payment;
    const [giftId, buyerId] = sp.invoice_payload.split(':');

    const { data: gift } = await supabase
      .from('gifts')
      .select('*')
      .eq('id', giftId)
      .single();

    if (!gift || gift.sold) return res.sendStatus(200);

    await supabase
      .from('gifts')
      .update({ sold: true, for_sale: false })
      .eq('id', giftId);

    await supabase.rpc("increment_stars", {
      uid: gift.owner_id,
      amount: gift.stars
    });

    await supabase.from('purchases').insert({
      gift_id: giftId,
      buyer_id: buyerId,
      seller_id: gift.owner_id,
      amount_rub: calculateRubles(gift.stars)
    });

    await tgApi("sendMessage", {
      chat_id: buyerId,
      text: `🎁 Покупка успешна! Вы получили подарок: ${gift.name}`
    });

    await tgApi("sendMessage", {
      chat_id: gift.owner_id,
      text: `💰 Ваш подарок "${gift.name}" продан! +${gift.stars} ⭐`
    });
  }

  res.sendStatus(200);
});

// ---------------------- START ----------------------
app.get('/health', (req, res) => res.json({ ok: true }));
app.listen(PORT, () =>
  console.log(`🚀 Server running on http://localhost:${PORT}`)
);
