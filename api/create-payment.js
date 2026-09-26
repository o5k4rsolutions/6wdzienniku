const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') return res.status(405).end();
    const { productIds, discountCode } = req.body; 

    const { data: products } = await supabase.from('products').select('id, price').in('id', productIds);
    
    let totalAmount = products.reduce((sum, p) => sum + p.price, 0);


    const paymentIntent = await stripe.paymentIntents.create({
        amount: Math.round(totalAmount * 100), 
        currency: 'pln',
        automatic_payment_methods: { enabled: true }, 
    });

    res.send({ clientSecret: paymentIntent.client_secret });
}
