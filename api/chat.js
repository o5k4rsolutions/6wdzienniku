export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const { message } = req.body;
  const lowerMsg = message.toLowerCase();

  if (lowerMsg.includes('konsultant') || lowerMsg.includes('agent') || lowerMsg.includes('człowiek') || lowerMsg.includes('obsługa') || lowerMsg.includes('pracownik')) {
    return res.status(200).json({
      reply: "Nie mam możliwości połączenia Cię z konsultantem na żywo. Mogę jednak przekazać Twoją prośbę o kontakt do Biura Obsługi Klienta. Podaj swój adres e-mail oraz treść zapytania, a odpowiemy Ci mailowo w przeciągu 5 dni roboczych."
    });
  }

  if (message.includes('@') && (lowerMsg.includes('kontakt') || lowerMsg.includes('zgłoszenie') || lowerMsg.includes('problem') || lowerMsg.includes('pytanie') || message.length > 10)) {
    const discordWebhookUrl = process.env.WEBHOOK_DISCORD_ZGLOSZENIA;
    
    if (discordWebhookUrl) {
      try {
        await fetch(discordWebhookUrl, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            content: `🚨 **Nowe zgłoszenie z Centrum Pomocy 6WDzienniku**:\n\`\`\`${message}\`\`\``
          })
        });
      } catch (e) {
        console.error('Błąd wysyłania webhooka Discord:', e);
      }
    }

    return res.status(200).json({
      reply: "Dziękuję! Twoje zgłoszenie zostało automatycznie przekazane do Biura Obsługi Klienta. Odpowiemy na podany adres e-mail w przeciągu 5 dni roboczych."
    });
  }

  const geminiApiKey = process.env.API_GEMINI;
  if (!geminiApiKey) {
    return res.status(500).json({ reply: "Błąd konfiguracyjny serwera." });
  }

  try {
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${geminiApiKey}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [
          {
            parts: [
              { text: `Jesteś pomocnym wirtualnym asystentem platformy edukacyjnej 6WDzienniku. Zajmuję się ona sprzedażą testów, które są takie same jak w szkole. Pomagasz uczniom w kwestiach związanych z nauką i korzystaniem z serwisu. Jeśli czegoś nie wiesz, dotyczy to indywidualnego zamówienia lub użytkownik prosi o pomoc techniczno-finansową, poinformuj go, aby podał swój adres e-mail oraz opis sprawy, aby Biuro Obsługi Klienta mogło odpowiedzieć w ciągu 5 dni roboczych. Wiadomość użytkownika: "${message}"` }
            ]
          }
        ]
      })
    });

    const data = await geminiRes.json();
    const replyText = data.candidates?.[0]?.content?.parts?.[0]?.text || "Nie mam wystarczających informacji na ten temat. Podaj swój e-mail oraz treść zapytania, a przekażę sprawę do Biura Obsługi Klienta.";

    return res.status(200).json({ reply: replyText });
  } catch (error) {
    return res.status(500).json({ reply: "Wystąpił błąd podczas przetwarzania wiadomości przez asystenta." });
  }
}
