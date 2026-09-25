const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('Method Not Allowed');

  try {
    const { items, couponCode, userId } = req.body;

    const productIds = items.map(i => i.id);
    const { data: dbProducts, error } = await supabase.from('products').select('*').in('id', productIds);

    if (error || !dbProducts) throw new Error('Błąd pobierania produktów.');

    let totalAmount = 0;
    const finalItems = [];

    dbProducts.forEach(prod => {
      totalAmount += parseFloat(prod.price);
      finalItems.push({ id: prod.id, title: prod.title, price: prod.price, file_url: prod.file_url, file_type: prod.file_type });
    });

    if (couponCode) {
      const { data: coupon } = await supabase.from('coupons').select('*').eq('code', couponCode).single();
      if (coupon) {
        if (coupon.discount_type === 'percent') {
          totalAmount -= (totalAmount * (coupon.discount_value / 100));
        } else if (coupon.discount_type === 'fixed') {
          totalAmount -= coupon.discount_value;
        }
      }
    }

    totalAmount = Math.max(totalAmount, 1); 

    const paymentIntent = await stripe.paymentIntents.create({
      amount: Math.round(totalAmount * 100), 
      currency: 'pln',
      payment_method_types: ['card', 'blik'],
      metadata: {
        userId: userId,
        items: JSON.stringify(finalItems)
      }
    });

    res.status(200).json({ clientSecret: paymentIntent.client_secret, totalAmount });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
};
