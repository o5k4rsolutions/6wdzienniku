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
    const { userId, items, couponCode } = req.body;

    if (!userId || !items || items.length === 0) {
      return res.status(400).json({ error: 'Brak danych zamówienia.' });
    }

    // 1. Obliczenie ceny i weryfikacja produktów po stronie serwera
    let subtotal = 0;
    const verifiedItems = [];

    for (const item of items) {
      const { data: product } = await supabase
        .from('products')
        .select('*')
        .eq('id', item.id)
        .single();

      if (!product) continue;

      const price = (product.is_discounted && product.discount_price !== null) 
        ? parseFloat(product.discount_price) 
        : parseFloat(product.price);

      subtotal += price * (item.quantity || 1);
      verifiedItems.push({
        id: product.id,
        title: product.title,
        price: price,
        quantity: item.quantity || 1
      });
    }

    // 2. Utworzenie zamówienia w bazie ze statusem 'pending' (oczekujące)
    // Dopiero gdy płatność przejdzie, Twój webhook zmieni status na 'paid'!
    const { data: order, error: orderError } = await supabase
      .from('orders')
      .insert({
        user_id: userId,
        total_amount: subtotal,
        items: verifiedItems,
        status: 'pending', // <--- Kluczowe: na początku jest pending, nie tworzymy dostępu dopóki nie zapłaci
        coupon_code: couponCode || null
      })
      .select()
      .single();

    if (orderError) throw orderError;

    // 3. Utworzenie sesji płatności Stripe z przekazaniem orderId i userId w metadata
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card', 'blik'],
      line_items: verifiedItems.map(item => ({
        price_data: {
          currency: 'pln',
          product_data: { name: item.title },
          unit_amount: Math.round(item.price * 100), // Stripe wymaga groszy
        },
        quantity: item.quantity,
      })),
      mode: 'payment',
      success_url: `https://6wdzienniku.vercel.app/sukces?order_id=${order.id}`,
      cancel_url: `https://6wdzienniku.vercel.app/koszyk`,
      metadata: {
        orderId: order.id,
        userId: userId
      }
    });

    return.status(200).json({ url: session.url });

  } catch (err) {
    console.error('Błąd tworzenia sesji płatności:', err);
    return.status(500).json({ error: 'Internal Server Error' });
  }
}
