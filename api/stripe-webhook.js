import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Ważne: Webhook w Next.js/Vercel wymaga wyłączenia domyślnego bodyParser, aby zweryfikować podpis Stripe!
export const config = {
  api: {
    bodyParser: false,
  },
};

// Pomocnicza funkcja do odczytu surowego ciała żądania (raw body)
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
    // Weryfikacja, czy żądanie na pewno pochodzi ze Stripe
    event = stripe.webhooks.constructEvent(buf, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error(`Błąd weryfikacji podpisu Webhooka: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // Obsługa zdarzenia zakończenia płatności
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    const orderId = session.metadata?.orderId;

    if (orderId) {
      // Aktualizacja statusu zamówienia w bazie Supabase na 'paid'
      const { error } = await supabase
        .from('orders')
        .update({ status: 'paid' })
        .eq('id', orderId);

      if (error) {
        console.error('Błąd aktualizacji statusu zamówienia w bazie:', error);
        return res.status(500).json({ error: 'Database update failed' });
      }

      console.log(`Zamówienie ${orderId} zostało opłacone i zaktualizowane.`);
    }
  }

  return res.status(200).json({ received: true });
}
