import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

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

  // NASŁUCHUJEMY NA ZDARZENIE SUKCESU DLA PAYMENT INTENT
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const orderId = paymentIntent.metadata?.orderId;

    if (orderId) {
      // Aktualizujemy status istniejącego zamówienia 'pending' na 'paid'
      const { error } = await supabase
        .from('orders')
        .update({ status: 'paid' })
        .eq('id', orderId);

      if (error) {
        console.error('Błąd aktualizacji zamówienia w bazie:', error);
        return res.status(500).json({ error: 'Database update failed' });
      }

      console.log(`Zamówienie o ID ${orderId} zostało pomyślnie opłacone.`);
      
      // Tutaj możesz też dodać logikę przyznawania dostępu użytkownikowi do produktów,
      // jeśli nie robisz tego po stronie frontendu lub triggerów Supabase.
    }
  }

  return res.status(200).json({ received: true });
}
