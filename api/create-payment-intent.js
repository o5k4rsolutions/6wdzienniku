import { createClient } from '@supabase/supabase-js';
import Stripe from 'stripe';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
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

    // 1. Obliczenie wartości produktów po stronie serwera (bezpieczeństwo)
    let subtotal = 0;
    for (const item of items) {
      // Pobieramy aktualną cenę z bazy danych dla pewności
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

    // 2. Obsługa i weryfikacja kuponu rabatowego
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
    const amountInCents = Math.round(finalAmount * 100); // Stripe przyjmuje kwoty w groszach/centach

    // 3. Utworzenie rekordu zamówienia w bazie Supabase ze statusem 'pending'
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: userId,
        total_amount: finalAmount,
        subtotal: subtotal,
        discount_amount: discountAmount,
        coupon_id: appliedCouponId,
        status: 'pending',
        items: JSON.stringify(items)
      })
      .select()
      .single();

    if (orderError) {
      throw new Error(`Błąd zapisu zamówienia: ${orderError.message}`);
    }

    // 4. Utworzenie PaymentIntent w Stripe
    const paymentIntent = await stripe.paymentIntents.create({
      amount: amountInCents,
      currency: 'pln',
      automatic_payment_methods: { enabled: true },
      metadata: {
        orderId: order.id,
        userId: userId
      }
    });

    // Zaktualizowanie zamówienia o ID płatności Stripe
    await supabase
      .from('orders')
      .update({ stripe_payment_intent_id: paymentIntent.id })
      .eq('id', order.id);

    // 5. Zwrócenie klienta secret do frontendu
    return res.status(200).json({
      clientSecret: paymentIntent.client_secret,
      orderId: order.id
    });

  } catch (error) {
    console.error('Błąd w create-payment-intent:', error);
    return res.status(500).json({ message: error.message || 'Błąd serwera' });
  }
}
