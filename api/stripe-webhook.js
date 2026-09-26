import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// Inicjalizacja klienta Supabase z kluczem SERVICE_ROLE (wymagany do modyfikacji bazy z pominięciem RLS)
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Wyłączenie automatycznego bodyParser w Vercel/Next.js dla weryfikacji podpisu Stripe
export const config = {
  api: {
    bodyParser: false,
  },
};

// Pomocnicza funkcja pobierająca surowy bufor danych (raw body)
async function getRawBody(readable) {
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

  const rawBody = await getRawBody(req);
  const sig = req.headers['stripe-signature'];
  let event;

  // 1. Weryfikacja podpisu webhooka od Stripe
  try {
    event = stripe.webhooks.constructEvent(
      rawBody,
      sig,
      process.env.STRIPE_WEBHOOK_SECRET
    );
  } catch (err) {
    console.error(`Błąd weryfikacji podpisu Webhooka: ${err.message}`);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 2. Obsługa udanej płatności
  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const { orderId, userId } = paymentIntent.metadata || {};

    if (!orderId || !userId) {
      console.error('Brak orderId lub userId w metadata PaymentIntent');
      return res.status(400).json({ error: 'Missing metadata' });
    }

    try {
      // A. Aktualizacja statusu zamówienia w bazie Supabase na 'paid'
      const { data: order, error: orderError } = await supabase
        .from('orders')
        .update({ status: 'paid', stripe_payment_intent_id: paymentIntent.id })
        .eq('id', orderId)
        .select()
        .single();

      if (orderError) throw orderError;

      // B. Pobranie danych profilu użytkownika
      const { data: profile, error: profileError } = await supabase
        .from('profiles')
        .select('email, full_name')
        .eq('id', userId)
        .single();

      if (profileError) throw profileError;

      const items = typeof order.items === 'string' ? JSON.parse(order.items) : order.items;
      let hasEproducts = false;

      // C. Przypisanie dostępów do plików w tabeli `user_accesses`
      for (const item of items) {
        const { data: product } = await supabase
          .from('products')
          .select('*')
          .eq('id', item.id)
          .single();

        if (product && product.product_type === 'eproduct' && product.download_files) {
          hasEproducts = true;
          const files = typeof product.download_files === 'string'
            ? JSON.parse(product.download_files)
            : product.download_files;

          for (const file of files) {
            await supabase.from('user_accesses').insert({
              user_id: userId,
              order_id: orderId,
              product_id: product.id,
              title: file.name || product.title,
              file_type: file.type || 'zip',
              download_url: file.url
            });
          }
        }
      }

      // D. Wysyłka e-maila 1: Potwierdzenie zamówienia przez Brevo API
      await fetch('https://api.brevo.com/v3/smtp/email', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'api-key': process.env.BREVO_API_KEY
        },
        body: JSON.stringify({
          to: [{ email: profile.email, name: profile.full_name }],
          templateId: parseInt(process.env.BREVO_TEMPLATE_ORDER_CONFIRMATION_ID),
          params: {
            FULL_NAME: profile.full_name,
            ORDER_NUMBER: order.order_number,
            TOTAL_AMOUNT: parseFloat(order.total_amount).toFixed(2),
            ITEMS: items
          }
        })
      });

      // E. Wysyłka e-maila 2: Dostęp do plików (jeśli zamówiono e-produkt)
      if (hasEproducts && process.env.BREVO_TEMPLATE_DIGITAL_ACCESS_ID) {
        await fetch('https://api.brevo.com/v3/smtp/email', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'api-key': process.env.BREVO_API_KEY
          },
          body: JSON.stringify({
            to: [{ email: profile.email, name: profile.full_name }],
            templateId: parseInt(process.env.BREVO_TEMPLATE_DIGITAL_ACCESS_ID),
            params: {
              FULL_NAME: profile.full_name,
              PRODUCT_TITLE: items.map(i => i.title).join(', '),
              ACCESS_LINK: 'https://6wdzienniku.vercel.app/mojekonto'
            }
          })
        });
      }

    } catch (dbError) {
      console.error('Błąd podczas przetwarzania zamówienia:', dbError);
      return res.status(500).json({ error: 'Processing order failed' });
    }
  }

  // Zwrócenie potwierdzenia odbioru do serwerów Stripe
  res.status(200).json({ received: true });
}
