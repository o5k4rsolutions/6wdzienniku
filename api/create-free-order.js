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

        // 1. Pobieramy profil użytkownika, aby znać jego e-mail (kolumna user_email w tabeli orders)
        const { data: profileData, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .maybeSingle();

        const userEmail = profileData ? profileData.email : null;

        // 2. Bezpieczne przeliczenie kwoty po stronie serwera na podstawie tabeli products
        let subtotal = 0;
        const verifiedProducts = [];

        for (const item of items) {
            const { data: productData, error: prodError } = await supabaseAdmin
                .from('products')
                .select('id, title, price, discount_price, is_discounted, download_files, file_type, download_url')
                .eq('id', item.id)
                .maybeSingle();

            if (prodError || !productData) {
                return res.status(400).json({ error: `Produkt o ID ${item.id} nie został znaleziony.` });
            }

            // Sprawdzamy czy produkt ma aktywną cenę promocyjną lub standardową
            const unitPrice = (productData.is_discounted && productData.discount_price !== null) 
                ? parseFloat(productData.discount_price) 
                : parseFloat(productData.price);

            const qty = parseInt(item.quantity) || 1;
            subtotal += unitPrice * qty;

            verifiedProducts.push({
                ...productData,
                quantity: qty,
                applied_price: unitPrice
            });
        }

        let finalAmount = subtotal;
        let appliedCouponId = null;
        let discountAmountVal = 0;

        // 3. Weryfikacja kuponu rabatowego w tabeli coupons
        if (couponCode) {
            const { data: coupon, error: couponError } = await supabaseAdmin
                .from('coupons')
                .select('*')
                .eq('code', couponCode.toUpperCase())
                .maybeSingle();

            if (coupon) {
                // Sprawdzamy czy kupon nie wygasł (valid_until) oraz czy ma dostępne użycia
                const now = new Date();
                const isValidDate = !coupon.valid_until || new Date(coupon.valid_until) > now;
                const hasUsageLimit = coupon.usage_limit === null || coupon.used_count < coupon.usage_limit;

                if (isValidDate && hasUsageLimit) {
                    appliedCouponId = coupon.id;
                    
                    // Obsługujemy typ rabatu (procentowy 'percentage' lub kwotowy 'fixed' w zależności od struktury discount_type)
                    if (coupon.discount_type === 'percentage' || coupon.discount_type === 'percent') {
                        discountAmountVal = (subtotal * parseFloat(coupon.discount_value)) / 100;
                    } else {
                        // Jeśli typ to kwotowy (fixed)
                        discountAmountVal = parseFloat(coupon.discount_value) || 0;
                    }

                    finalAmount = Math.max(0, subtotal - discountAmountVal);

                    // Zwiększamy licznik użyć kuponu (used_count)
                    await supabaseAdmin
                        .from('coupons')
                        .update({ used_count: (coupon.used_count || 0) + 1 })
                        .eq('id', coupon.id);
                } else {
                    return res.status(400).json({ error: 'Użyty kupon wygasł lub osiągnął limit użyć.' });
                }
            } else {
                return res.status(400).json({ error: 'Użyty kupon jest nieprawidłowy.' });
            }
        }

        // 4. Krytyczne zabezpieczenie: upewniamy się, że ostateczna kwota wynosi 0 PLN (lub mniej)
        if (finalAmount > 0.01) {
            return res.status(400).json({ 
                error: 'To zamówienie nie jest darmowe. Wymagana jest standardowa płatność.' 
            });
        }

        // 5. Zapisanie zamówienia w tabeli `orders` zgodnie z Twoim schematem
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert({
                user_id: userId,
                user_email: userEmail,
                total_amount: 0,
                discount_amount: discountAmountVal,
                items: verifiedProducts,
                status: 'paid', // lub 'completed'
                coupon_code: couponCode ? couponCode.toUpperCase() : null,
                coupon_id: appliedCouponId,
                created_at: new Date().toISOString(),
                updated_at: new Date().toISOString()
            })
            .select()
            .single();

        if (orderError) {
            console.error('Błąd zapisu zamówienia w bazie:', orderError);
            throw new Error('Nie udało się zapisać zamówienia w bazie danych.');
        }

        const orderId = orderData.id;

        // 6. Przypisanie dostępu do produktów w tabeli `user_accesses`
        for (const prod of verifiedProducts) {
            // Jeśli produkt ma zdefiniowane pliki do pobrania w JSONB (download_files), możemy je przepisać lub zapisać pojedynczo
            await supabaseAdmin
                .from('user_accesses')
                .insert({
                    user_id: userId,
                    order_id: orderId,
                    product_id: prod.id,
                    title: prod.title,
                    file_type: prod.file_type || null,
                    download_url: prod.download_url || null,
                    created_at: new Date().toISOString()
                });
        }

        // Zwrócenie odpowiedzi o sukcesie
        return res.status(200).json({ 
            success: true, 
            message: 'Darmowe zamówienie zostało pomyślnie zrealizowane, a dostępy zostały przyznane.',
            orderId: orderId
        });

    } catch (err) {
        console.error('Błąd w /api/create-free-order:', err);
        return res.status(500).json({ error: err.message || 'Wewnętrzny błąd serwera.' });
    }
}
