export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message } = req.body;
  const lowerMsg = message.toLowerCase();

  // Sprawdzamy czy wiadomość zawiera "@" (potencjalny e-mail) oraz dotyczy problemu/zamówienia/pomocy
  const hasEmail = message.includes('@');
  const isSupportRequest = lowerMsg.includes('problem') || lowerMsg.includes('zamówienie') || lowerMsg.includes('płatność') || lowerMsg.includes('sklep') || lowerMsg.includes('brak') || lowerMsg.includes('reklamacja') || lowerMsg.includes('konsultant') || lowerMsg.includes('pomoc techniczna');

  // 1. Jeśli użytkownik podaje e-mail i zgłasza sprawę do BOK -> wysyłamy powiadomienie na webhook Discorda
  if (hasEmail && (isSupportRequest || message.length > 10)) {
    const discordWebhookUrl = process.env.WEBHOOK_DISCORD_ZGLOSZENIA;
    
    if (discordWebhookUrl) {
      try {
        await fetch(discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🚨 **Nowe zgłoszenie do BOK / Pomocy technicznej (6WDzienniku)**:\n\`\`\`${message}\`\`\``
          })
        });
      } catch (e) {
        console.error('Błąd wysyłania webhooka Discord:', e);
      }
    }

    return res.status(200).json({
      reply: "Dziękuję! Twoje zgłoszenie wraz z adresem e-mail zostało przekazane do Biura Obsługi Klienta. Odpowiemy na nie w przeciągu 5 dni roboczych."
    });
  }

  // 2. Jeśli użytkownik prosi o pomoc techniczną, konsultanta lub ma problem z zamówieniem, ale nie podał jeszcze e-maila
  if (isSupportRequest || lowerMsg.includes('konsultant') || lowerMsg.includes('agent') || lowerMsg.includes('techniczn')) {
    return res.status(200).json({
      reply: "W tej sprawie konieczny jest kontakt z Biurem Obsługi Klienta (nie mogę tego rozstrzygnąć bezpośrednio na czacie). Podaj w kolejnej wiadomości swój adres e-mail oraz opis problemu/zamówienia, a przekażę sprawę do zespołu."
    });
  }

  // 3. Standardowa rozmowa z Gemini dla pytań ogólnych / powitań
  const geminiApiKey = process.env.API_GEMINI;
  if (!geminiApiKey) {
    return res.status(500).json({ reply: "Błąd konfiguracyjny serwera (brak klucza Gemini)." });
  }

  try {
    const geminiRes = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
    const response = await fetch(geminiRes, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `Jesteś miłym, pomocnym asystentem platformy edukacyjnej 6WDzienniku. Odpowiadaj krótko i przyjaźnie na codzienne zwroty (np. "witam", "cześć"). Pomagaj w nauce i obsłudze serwisu. Jeśli użytkownik pyta o sprawy wymagające ingerencji człowieka (płatności, błędy techniczne, indywidualne konta, dostęp do materiałów), przypomnij mu, że może podać swój e-mail i opis sprawy, aby zgłosić ją do BOK. Wiadomość użytkownika: "${message}"` }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Cześć! W czym mogę Ci dzisiaj pomóc?";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    return res.status(500).json({ reply: "Wystąpił błąd podczas przetwarzania wiadomości przez asystenta." });
  }
}
