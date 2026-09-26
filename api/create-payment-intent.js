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

    // 2. Obliczenie wartości produktów (subtotal)
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

    // 3. Weryfikacja i obsługa kuponu rabatowego
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

    // 4. Utworzenie zamówienia w bazie z pełnymi danymi kuponu i e-maila
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: userId,
        user_email: profile.email,
        subtotal: subtotal,
        discount_amount: discountAmount,
        coupon_id: appliedCouponId,
        total_amount: finalAmount,
        status: 'pending',
        items: JSON.stringify(items)
      })
      .select()
      .single();

    if (orderError) {
      throw new Error(`Błąd zapisu zamówienia: ${orderError.message}`);
    }

    // 5. Utworzenie PaymentIntent w Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'pln',
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: order.id,
        userId: userId
      }
    });

    await supabase
      .from('orders')
      .update({ stripe_payment_intent_id: paymentIntent.id })
      .eq('id', order.id);

    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      orderId: order.id
    });

  } catch (error) {
    console.error('Błąd w create-payment-intent:', error);
    return res.status(500).json({ message: error.message || 'Błąd serwera' });
  }
};
