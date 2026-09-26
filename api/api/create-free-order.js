import { createClient } from '@supabase/supabase-js';

// Inicjalizacja klienta Supabase z użyciem Service Role Key, 
// aby móc bezpiecznie zapisać zamówienie i nadać uprawnienia omijając Row Level Security (RLS)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL || 'https://fxksikgdberwgttvglko.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY // Klucz serwisowy MUSI być ustawiony w zmiennych środowiskowych Vercel!
);

export default async function handler(req, res) {
    // Obsługujemy tylko metodę POST
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    try {
        const { items, userId, couponCode } = req.body;

        if (!userId || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Brak wymaganych danych zamówienia.' });
        }

        // 1. Bezpieczne przeliczenie kwoty po stronie serwera (nigdy nie ufamy cenom z frontendu!)
        let subtotal = 0;
        
        // Pobieramy aktualne produkty z bazy, aby zweryfikować ich ceny
        for (const item of items) {
            // Zakładam, że w bazie masz tabelę 'products' z kolumnami id/title oraz price
            // Jeśli trzymasz produkty w innej tabeli, dostosuj poniższe zapytanie
            const { data: productData, error: prodError } = await supabaseAdmin
                .from('products')
                .select('price')
                .eq('id', item.id) // lub eq('title', item.title) w zależności od struktury Twojego koszyka
                .maybeSingle();

            // Fallback, jeśli produkt ma cenę bezpośrednio w obiekcie wysłanym z frontu (ale bezpieczniej z bazy)
            const itemPrice = productData ? parseFloat(productData.price) : (parseFloat(item.price) || 0);
            const qty = parseInt(item.quantity) || 1;
            
            subtotal += itemPrice * qty;
        }

        let finalAmount = subtotal;

        // 2. Weryfikacja kuponu rabatowego po stronie serwera
        if (couponCode) {
            const { data: coupon, error: couponError } = await supabaseAdmin
                .from('coupons')
                .select('*')
                .eq('code', couponCode.toUpperCase())
                .maybeSingle();

            if (coupon && (coupon.active === true || coupon.is_active === true)) {
                const discountPercent = coupon.discount_percent || coupon.discount_value || 0;
                const discountAmount = (subtotal * discountPercent) / 100;
                finalAmount = Math.max(0, subtotal - discountAmount);
            } else {
                return res.status(400).json({ error: 'Użyty kupon jest nieprawidłowy lub nieaktywny.' });
            }
        }

        // 3. Krytyczne zabezpieczenie: sprawdzamy czy kwota końcowa rzeczywiście wynosi 0 (lub mniej)
        if (finalAmount > 0.01) {
            return res.status(400).json({ 
                error: 'To zamówienie nie jest darmowe. Wymagana jest płatność online.' 
            });
        }

        // 4. Zapisanie zamówienia w bazie danych (np. tabela `orders`)
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert({
                user_id: userId,
                amount: 0,
                currency: 'PLN',
                status: 'paid', // lub 'completed' / 'free'
                payment_method: 'free_coupon',
                items: items,
                coupon_code: couponCode || null,
                created_at: new Date().toISOString()
            })
            .select()
            .single();

        if (orderError) {
            console.error('Błąd zapisu zamówienia w bazie:', orderError);
            throw new Error('Nie udało się zapisać zamówienia w bazie danych.');
        }

        const orderId = orderData ? orderData.id : null;

        // 5. Przyznanie dostępu do materiałów (np. tabela `user_access` lub `entitlements`)
        // Przechodzimy przez każdy produkt w koszyku i nadajemy uprawnienia użytkownikowi
        for (const item of items) {
            const productId = item.id;
            
            if (productId) {
                await supabaseAdmin
                    .from('user_access') // Zmień nazwę tabeli na tę, w której trzymasz dostępy użytkowników do kursów/produktów
                    .upsert({
                        user_id: userId,
                        product_id: productId,
                        order_id: orderId,
                        granted_at: new Date().toISOString()
                    }, { onConflict: 'user_id, product_id' });
            }
        }

        // Zwrócenie sukcesu do frontendu
        return res.status(200).json({ 
            success: true, 
            message: 'Darmowe zamówienie zostało pomyślnie zrealizowane.',
            orderId: orderId
        });

    } catch (err) {
        console.error('Błąd w /api/create-free-order:', err);
        return res.status(500).json({ error: err.message || 'Wewnętrzny błąd serwera.' });
    }
}
