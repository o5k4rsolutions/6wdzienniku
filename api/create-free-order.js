import { createClient } from '@supabase/supabase-js';
import pricingLib from './_pricing.js';

const { computePricing, PricingError, grantAccess, orderItems } = pricingLib;

// Service Role Key – omija RLS, dlatego użytkownika weryfikujemy po tokenie, a nie po userId z przeglądarki
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL || process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://fxksikgdberwgttvglko.supabase.co',
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
  }

  let orderId = null;
  try {
    // 1. Użytkownik z tokenu
    const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
    if (!token) return res.status(401).json({ error: 'Brak autoryzacji użytkownika.' });
    const { data: { user }, error: authError } = await supabaseAdmin.auth.getUser(token);
    if (authError || !user) return res.status(401).json({ error: 'Sesja wygasła. Zaloguj się ponownie.' });

    // 2. Kwota liczona z bazy tym samym kodem co przy płatności kartą
    const { items, couponCode } = req.body || {};
    const pricing = await computePricing(supabaseAdmin, items, couponCode);

    // 3. Zamówienie musi być naprawdę darmowe
    if (pricing.total > 0.01) {
      return res.status(400).json({ error: 'To zamówienie nie jest darmowe. Wymagana jest standardowa płatność.' });
    }

    // 4. Zapis zamówienia
    const now = new Date().toISOString();
    const { data: order, error: orderError } = await supabaseAdmin
      .from('orders')
      .insert({
        user_id: user.id,
        user_email: user.email,
        total_amount: 0,
        discount_amount: pricing.discount,
        items: orderItems(pricing.lines),
        status: 'paid',
        coupon_code: pricing.coupon ? pricing.coupon.code : null,
        coupon_id: pricing.coupon ? pricing.coupon.id : null,
        created_at: now,
        updated_at: now,
      })
      .select()
      .single();

    if (orderError) {
      console.error('Błąd zapisu zamówienia w bazie:', orderError);
      throw new Error('Nie udało się zapisać zamówienia w bazie danych.');
    }
    orderId = order.id;

    // 5. Dostęp do plików (jeśli się nie uda – cofamy zamówienie, żeby klient mógł spróbować ponownie)
    await grantAccess(supabaseAdmin, user.id, orderId, pricing.lines.map(l => l.product));

    // 6. Licznik użyć kodu – dopiero po udanym zamówieniu
    if (pricing.coupon) {
      await supabaseAdmin
        .from('coupons')
        .update({ used_count: (pricing.coupon.used_count || 0) + 1 })
        .eq('id', pricing.coupon.id);
    }

    return res.status(200).json({
      success: true,
      message: 'Darmowe zamówienie zostało pomyślnie zrealizowane, a dostępy zostały przyznane.',
      orderId,
    });
  } catch (err) {
    if (orderId) {
      await supabaseAdmin.from('user_accesses').delete().eq('order_id', orderId);
      await supabaseAdmin.from('orders').delete().eq('id', orderId);
    }
    if (err instanceof PricingError) return res.status(400).json({ error: err.message });
    console.error('Błąd w /api/create-free-order:', err);
    return res.status(500).json({ error: 'Wewnętrzny błąd serwera. Spróbuj ponownie.' });
  }
}
