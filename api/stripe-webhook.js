import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';
import pricingLib from './_pricing.js';

const { grantAccess } = pricingLib;

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export const config = {
  api: { bodyParser: false },
};

async function buffer(readable) {
  const chunks = [];
  for await (const chunk of readable) {
    chunks.push(typeof chunk === 'string' ? Buffer.from(chunk) : chunk);
  }
  return Buffer.concat(chunks);
}

// Nadaje dostęp do plików tylko jeśli zamówienie nie ma jeszcze wpisów w user_accesses
// (chroni przed dublami, także gdybyś miał w Supabase trigger robiący to samo)
async function ensureAccess(order) {
  const { count, error } = await supabase
    .from('user_accesses').select('order_id', { count: 'exact', head: true }).eq('order_id', order.id);
  if (error) throw error;
  if (count > 0) return;
  const items = typeof order.items === 'string' ? JSON.parse(order.items) : (order.items || []);
  await grantAccess(supabase, order.user_id, order.id, items);
}

// Tworzy zamówienie z danych zapisanych w PaymentIntent (idempotentnie – po payment_intent_id)
async function createPaidOrder(pi) {
  const m = pi.metadata || {};

  const { data: existing } = await supabase
    .from('orders').select('id,status,items,user_id').eq('payment_intent_id', pi.id).maybeSingle();
  if (existing) {
    if (existing.status !== 'paid') {
      const { error } = await supabase.from('orders').update({ status: 'paid', updated_at: new Date().toISOString() }).eq('id', existing.id);
      if (error) throw error;
    }
    await ensureAccess(existing);
    return;
  }

  // Odtworzenie pozycji z metadanych: "id:ilość:cena,id:ilość:cena"
  const raw = Object.keys(m)
    .filter(k => /^items_\d+$/.test(k))
    .sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))
    .map(k => m[k])
    .join('');
  const parsed = raw.split(',').filter(Boolean).map(s => {
    const [id, quantity, price] = s.split(':');
    return { id, quantity: Number(quantity), price: Number(price) };
  });
  if (!parsed.length) throw new Error(`PaymentIntent ${pi.id} nie zawiera pozycji zamówienia.`);

  const { data: prods, error: prodErr } = await supabase.from('products').select('*').in('id', parsed.map(p => p.id));
  if (prodErr) throw prodErr;

  // Kształt zgodny z create-free-order: pełny produkt + quantity + applied_price (cena z chwili zakupu)
  const items = parsed.map(p => {
    const prod = (prods || []).find(x => String(x.id) === p.id) || { id: p.id, title: 'Produkt' };
    return { ...prod, price: p.price, applied_price: p.price, quantity: p.quantity };
  });

  let coupon = null;
  if (m.couponCode) {
    const { data } = await supabase.from('coupons').select('id,used_count').eq('code', m.couponCode).maybeSingle();
    coupon = data;
  }

  const now = new Date().toISOString();
  const { data: order, error } = await supabase
    .from('orders')
    .insert({
      user_id: m.userId,
      user_email: pi.receipt_email || null,
      total_amount: pi.amount / 100, // kwota faktycznie pobrana przez Stripe
      discount_amount: Number(m.discountAmount) || 0,
      items,
      status: 'paid',
      coupon_code: m.couponCode || null,
      coupon_id: coupon ? coupon.id : null,
      payment_intent_id: pi.id,
      created_at: now,
      updated_at: now,
    })
    .select('id,items,user_id')
    .single();

  if (error) {
    if (error.code === '23505') return; // równoległe wywołanie webhooka – zamówienie już istnieje
    throw error;
  }

  await ensureAccess(order);

  if (coupon) {
    await supabase.from('coupons').update({ used_count: (coupon.used_count || 0) + 1 }).eq('id', coupon.id);
  }
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  const buf = await buffer(req);
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Błąd weryfikacji podpisu webhooka: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const pi = event.data.object;
    const m = pi.metadata || {};
    try {
      if (m.orderId) {
        // zgodność wstecz ze starymi zamówieniami 'pending'
        const { data: order, error } = await supabase
          .from('orders').update({ status: 'paid', updated_at: new Date().toISOString() })
          .eq('id', m.orderId).select('id,items,user_id').maybeSingle();
        if (error) throw error;
        if (order) await ensureAccess(order);
      } else if (m.userId) {
        await createPaidOrder(pi);
      } else {
        console.error(`PaymentIntent ${pi.id} bez userId/orderId w metadanych – zamówienie nie powstało.`);
      }
    } catch (err) {
      console.error('Błąd zapisu zamówienia:', err);
      return res.status(500).json({ error: 'Database update failed' }); // Stripe ponowi wysyłkę
    }
  }

  return res.status(200).json({ received: true });
}
