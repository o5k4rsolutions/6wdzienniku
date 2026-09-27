import { createClient } from '@supabase/supabase-js';

// Inicjalizacja klienta Supabase z użyciem Service Role Key, 
// aby móc bezpiecznie zapisać zamówienie i nadać uprawnienia omijając Row Level Security (RLS)
const supabaseAdmin = createClient(
    process.env.SUPABASE_URL || 'https://fxksikgdberwgttvglko.supabase.co',
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        res.setHeader('Allow', 'POST');
        return res.status(405).json({ error: `Method ${req.method} Not Allowed` });
    }

    try {
        const { items, userId, couponCode } = req.body;

        if (!userId || !items || !Array.isArray(items) || items.length === 0) {
            return res.status(400).json({ error: 'Brak wymaganych danych zamówienia.' });
        }

        // 1. Pobieramy profil użytkownika, aby znać jego e-mail
        const { data: profileData, error: profileError } = await supabaseAdmin
            .from('profiles')
            .select('email')
            .eq('id', userId)
            .maybeSingle();

        const userEmail = profileData ? profileData.email : null;

        // 2. Bezpieczne przeliczenie kwoty po stronie serwera
        let subtotal = 0;
        const verifiedProducts = [];

        for (const item of items) {
            const { data: productData, error: prodError } = await supabaseAdmin
                .from('products')
                .select('*')
                .eq('id', item.id)
                .maybeSingle();

            if (prodError || !productData) {
                return res.status(400).json({ error: `Produkt o ID ${item.id} nie został znaleziony.` });
            }

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
        let couponToUpdate = null;

        // 3. Weryfikacja kuponu rabatowego
        if (couponCode) {
            const { data: coupon, error: couponError } = await supabaseAdmin
                .from('coupons')
                .select('*')
                .eq('code', couponCode.toUpperCase())
                .maybeSingle();

            if (couponError || !coupon) {
                return res.status(400).json({ error: 'Użyty kupon jest nieprawidłowy.' });
            }

            const now = new Date();
            const isValidDate = !coupon.valid_until || new Date(coupon.valid_until) > now;
            const hasUsageLimit = coupon.usage_limit === null || coupon.used_count < coupon.usage_limit;

            if (!isValidDate || !hasUsageLimit) {
                return res.status(400).json({ error: 'Użyty kupon wygasł lub osiągnął limit użyć.' });
            }

            appliedCouponId = coupon.id;
            couponToUpdate = coupon;

            if (coupon.discount_type === 'percentage' || coupon.discount_type === 'percent') {
                discountAmountVal = (subtotal * parseFloat(coupon.discount_value)) / 100;
            } else {
                discountAmountVal = parseFloat(coupon.discount_value) || 0;
            }

            finalAmount = Math.max(0, subtotal - discountAmountVal);
        }

        // 4. Krytyczne zabezpieczenie: upewniamy się, że ostateczna kwota wynosi 0 PLN
        if (finalAmount > 0.01) {
            return res.status(400).json({ 
                error: 'To zamówienie nie jest darmowe. Wymagana jest standardowa płatność.' 
            });
        }

        // 5. Zapisanie zamówienia w tabeli `orders`
        const { data: orderData, error: orderError } = await supabaseAdmin
            .from('orders')
            .insert({
                user_id: userId,
                user_email: userEmail,
                total_amount: finalAmount,
                discount_amount: discountAmountVal,
                items: verifiedProducts,
                status: 'paid',
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

        // 6. Aktualizacja licznika użyć kuponu (dopiero po udanym zapisie zamówienia)
        if (couponToUpdate) {
            await supabaseAdmin
                .from('coupons')
                .update({ used_count: (couponToUpdate.used_count || 0) + 1 })
                .eq('id', couponToUpdate.id);
        }

        // 7. Przypisanie dostępu do produktów w tabeli `user_accesses` (z uwzględnieniem plików cyfrowych)
        for (const prod of verifiedProducts) {
            if (prod.product_type === 'eproduct' && prod.download_files) {
                const files = typeof prod.download_files === 'string'
                    ? JSON.parse(prod.download_files)
                    : prod.download_files;

                for (const file of files) {
                    await supabaseAdmin.from('user_accesses').insert({
                        user_id: userId,
                        order_id: orderId,
                        product_id: prod.id,
                        title: file.name || prod.title,
                        file_type: file.type || 'zip',
                        download_url: file.url,
                        created_at: new Date().toISOString()
                    });
                }
            } else {
                // Awaryjny zapis, jeśli produkt nie korzysta z tablicy download_files
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
        }

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
