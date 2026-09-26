export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message } = req.body;
  const lowerMsg = message.toLowerCase();

  // Sprawdzamy czy wiadomość zawiera e-mail (@) oraz dotyczy problemu/zamówienia/pomocy technicznej
  const hasEmail = message.includes('@');
  const isSupportRequest = lowerMsg.includes('problem') || lowerMsg.includes('zamówienie') || lowerMsg.includes('płatność') || lowerMsg.includes('sklep') || lowerMsg.includes('brak') || lowerMsg.includes('reklamacja') || lowerMsg.includes('konsultant') || lowerMsg.includes('pomoc techniczna') || lowerMsg.includes('dostępu');

  // 1. Jeśli użytkownik podaje e-mail i zgłasza sprawę -> wyślij na Discorda
  if (hasEmail && (isSupportRequest || message.length > 10)) {
    const discordWebhookUrl = process.env.WEBHOOK_DISCORD_ZGLOSZENIA;
    
    if (discordWebhookUrl) {
      try {
        await fetch(discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🚨 **Nowe zgłoszenie do BOK / Pomocy (6WDzienniku)**:\n\`\`\`${message}\`\`\``
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

  // 2. Jeśli użytkownik prosi o pomoc techniczną lub konsultanta, ale nie podał e-maila
  if (isSupportRequest || lowerMsg.includes('konsultant') || lowerMsg.includes('agent') || lowerMsg.includes('techniczn')) {
    return res.status(200).json({
      reply: "W tej sprawie konieczny jest kontakt z Biurem Obsługi Klienta. Podaj w kolejnej wiadomości swój adres e-mail oraz opis problemu, a przekażę sprawę do zespołu."
    });
  }

  // 3. Prawdziwe zapytanie do Google Gemini API dla normalnych pytań i rozmowy
  const geminiApiKey = process.env.API_GEMINI;
  if (!geminiApiKey) {
    return res.status(500).json({ reply: "Błąd konfiguracyjny serwera (brak klucza Gemini)." });
  }

  try {
    const geminiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`;
    
    const response = await fetch(geminiUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `Jesteś miłym i pomocnym wirtualnym asystentem platformy edukacyjnej 6WDzienniku. Pomagasz uczniom w nauce oraz obsłudze serwisu. Odpowiadaj naturalnie, wyczerpująco i po polsku na pytania użytkownika. Jeśli pytanie dotyczy spraw indywidualnych lub technicznych, przypomnij o możliwości podania e-maila. Wiadomość użytkownika: "${message}"` }
            ]
          }
        ]
      })
    });

    const data = await response.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Przepraszam, mam chwilowy problem z odpowiedzią. W czym mogę pomóc?";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    console.error('Błąd Gemini API:', error);
    return res.status(500).json({ reply: "Wystąpił błąd podczas komunikacji z asystentem AI." });
  }
}
