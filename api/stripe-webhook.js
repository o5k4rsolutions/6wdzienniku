const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const { createClient } = require('@supabase/supabase-js');
const SibApiV3Sdk = require('sib-api-v3-sdk');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

const defaultClient = SibApiV3Sdk.ApiClient.instance;
const apiKey = defaultClient.authentications['api-key'];
apiKey.apiKey = process.env.BREVO_API_KEY;

module.exports = async (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;

  try {
    event = stripe.webhooks.constructEvent(req.rawBody, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  if (event.type === 'payment_intent.succeeded') {
    const paymentIntent = event.data.object;
    const userId = paymentIntent.metadata.userId;
    const items = JSON.parse(paymentIntent.metadata.items);
    const orderNumber = `#6WD-${Math.floor(100000 + Math.random() * 900000)}`;

    const { data: order } = await supabase.from('orders').insert({
      order_number: orderNumber,
      user_id: userId,
      total_amount: paymentIntent.amount / 100,
      status: 'completed',
      items: items
    }).select().single();

    for (const item of items) {
      if (item.file_url) {
        await supabase.from('user_access').insert({
          user_id: userId,
          product_id: item.id,
          order_id: order.id,
          file_title: item.title,
          file_url: item.file_url,
          file_type: item.file_type || 'folder'
        });
      }
    }

    const { data: profile } = await supabase.from('profiles').select('email').eq('id', userId).single();
    
    if (profile) {
      const apiInstance = new SibApiV3Sdk.TransactionalEmailsApi();
      await apiInstance.sendTransacEmail({
        templateId: parseInt(process.env.BREVO_CONFIRMATION_TEMPLATE_ID),
        to: [{ email: profile.email }],
        params: {
          ORDER_NUMBER: orderNumber,
          ITEMS: items,
          TOTAL_AMOUNT: (paymentIntent.amount / 100).toFixed(2)
        }
      });
    }
  }

  res.status(200).json({ received: true });
};
