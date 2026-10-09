const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { computePricing, PricingError } = require('./_pricing');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const STRIPE_MIN_CENTS = 200; // minimum Stripe dla PLN: 2,00 zł

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type, Accept');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ message: 'Method Not Allowed' });

  try {
    // 1. Użytkownik z tokenu (a nie z userId podanego przez przeglądarkę)
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ message: 'Brak autoryzacji użytkownika' });
    const { data: { user }, error: authError } = await supabase.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ message: 'Sesja wygasła. Zaloguj się ponownie.' });

    // 2. Kwota liczona wyłącznie z bazy: promocje + kod rabatowy
    const { items, couponCode, expectedTotal } = req.body || {};
    const pricing = await computePricing(supabase, items, couponCode);
    const amountInCents = Math.round(pricing.total * 100);

    if (expectedTotal != null && Math.abs(parseFloat(expectedTotal) - pricing.total) > 0.01) {
      console.warn(`Kwota z przeglądarki (${expectedTotal}) różni się od serwerowej (${pricing.total})`);
    }
    if (amountInCents <= 0) {
      return res.status(400).json({ message: 'Kwota zamówienia wynosi 0. Użyj ścieżki darmowego zamówienia.' });
    }
    if (amountInCents < STRIPE_MIN_CENTS) {
      return res.status(400).json({ message: 'Minimalna kwota płatności kartą to 2,00 PLN.' });
    }

    // 3. Pozycje w skróconej formie "id:ilość:cena" – dzielone na kawałki po 500 znaków
    //    (limit Stripe to 500 znaków na jedną wartość metadanych)
    const compact = pricing.lines.map(l => `${l.id}:${l.quantity}:${l.price.toFixed(2)}`).join(',');
    const metadata = {
      userId: user.id,
      couponCode: pricing.coupon ? pricing.coupon.code : '',
      subtotal: pricing.subtotal.toFixed(2),
      discountAmount: pricing.discount.toFixed(2),
      totalAmount: pricing.total.toFixed(2),
    };
    const chunks = compact.match(/.{1,500}/g) || [];
    if (chunks.length > 40) return res.status(400).json({ message: 'Zbyt wiele produktów w koszyku.' });
    chunks.forEach((c, i) => { metadata[`items_${i}`] = c; });

    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'pln',
      automatic_payment_methods: { enabled: true },
      receipt_email: user.email,
      metadata,
    });

    return res.status(200).json({ clientSecret: paymentIntent.client_secret });
  } catch (error) {
    if (error instanceof PricingError) return res.status(400).json({ message: error.message });
    console.error('Błąd w create-payment-intent:', error);
    return res.status(500).json({ message: 'Błąd serwera. Spróbuj ponownie.' });
  }
};
