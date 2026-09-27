const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

module.exports = async (req, res) => {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  if (req.method !== 'POST') {
    return res.status(405).json({ message: 'Method Not Allowed' });
  }

  try {
    const { items, userId, couponCode } = req.body;

    if (!items || !Array.isArray(items) || items.length === 0) {
      return res.status(400).json({ message: 'Koszyk jest pusty' });
    }

    if (!userId) {
      return res.status(401).json({ message: 'Brak autoryzacji użytkownika' });
    }

    // 1. Pobranie e-maila użytkownika z tabeli profiles
    const { data: profile, error: profileError } = await supabase
      .from('profiles')
      .select('email')
      .eq('id', userId)
      .single();

    if (profileError || !profile) {
      throw new Error('Nie udało się pobrać danych profilu użytkownika.');
    }

    // 2. Obliczenie subtotal (weryfikacja cen z bazą danych)
    let subtotal = 0;
    for (const item of items) {
      const { data: product } = await supabase
        .from('products')
        .select('price')
        .eq('id', item.id)
        .single();

      const price = product ? parseFloat(product.price) : (parseFloat(item.price) || 0);
      const qty = parseInt(item.quantity) || 1;
      subtotal += price * qty;
    }

    let discountPercent = 0;
    let appliedCouponId = null;

    if (couponCode) {
      const { data: coupon } = await supabase
        .from('coupons')
        .select('*')
        .eq('code', couponCode)
        .maybeSingle();

      if (coupon && coupon.active !== false && coupon.is_active !== false) {
        discountPercent = coupon.discount_percent || 0;
        appliedCouponId = coupon.id;
      }
    }

    const discountAmount = (subtotal * discountPercent) / 100;
    const finalAmount = Math.max(0, subtotal - discountAmount);
    const amountInCents = Math.round(finalAmount * 100);

    // Zabezpieczenie przed płatnością Stripe, jeśli kwota wyszła 0 (od tego jest darmowy endpoint)
    if (amountInCents <= 0) {
      return res.status(400).json({ message: 'Kwota zamówienia wynosi 0. Użyj ścieżki darmowego zamówienia.' });
    }

    // 3. Utworzenie PaymentIntent w Stripe BEZ zapisywania zamówienia w bazie.
    // Przekazujemy wszystkie dane w metadanych, aby webhook mógł później utworzyć zamówienie.
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'pln',
      automatic_payment_methods: { enabled: true },
      receipt_email: profile.email,
      metadata: {
        userId: userId,
        userEmail: profile.email,
        subtotal: subtotal.toString(),
        discountAmount: discountAmount.toString(),
        couponId: appliedCouponId || '',
        totalAmount: finalAmount.toString(),
        items: JSON.stringify(items) // Przechowujemy koszyk jako string JSON w metadanych
      }
    });

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret
    });

  } catch (error) {
    console.error('Błąd w create-payment-intent:', error);
    return res.status(500).json({ message: error.message || 'Błąd serwera' });
  }
};
