import Stripe from 'stripe';

// Pobiera tajny klucz z ustawień środowiskowych Vercela (Environment Variables)
// Nigdy nie wpisuj tu klucza "sk_test_..." na sztywno!
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

export default async function handler(req, res) {
    if (req.method !== 'POST') {
        return res.status(405).json({ error: 'Metoda niedozwolona' });
    }

    try {
        const { productIds } = req.body;

        if (!productIds || productIds.length === 0) {
            return res.status(400).json({ error: 'Koszyk jest pusty' });
        }
        
        const amountToCharge = productIds.length * 2900; // Stripe operuje na groszach (2900 = 29.00 PLN)

        // Utworzenie intencji płatności w Stripe
        const paymentIntent = await stripe.paymentIntents.create({
            amount: amountToCharge,
            currency: 'pln',
            automatic_payment_methods: {
                enabled: true, // Włącza Blik, Karty, Apple Pay automatycznie
            },
        });

        // Odsyłamy wygenerowany sekretny klucz klienta do HTML-a
        res.status(200).json({
            clientSecret: paymentIntent.client_secret,
        });

    } catch (error) {
        console.error("Błąd generowania płatności:", error);
        res.status(500).json({ error: 'Błąd serwera podczas generowania płatności' });
    }
}
