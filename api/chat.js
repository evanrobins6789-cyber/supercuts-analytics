// Vercel serverless function — Node.js runtime (auto-detected, no config needed).
// Receives a question + a text summary of the site's current data from the
// browser, calls the Anthropic API with the site's own key (kept server-side,
// never exposed to visitors), and returns the answer.

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'Method not allowed' });
    return;
  }

  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    res.status(500).json({ error: 'AI is not configured yet — the ANTHROPIC_API_KEY environment variable is missing on this deployment.' });
    return;
  }

  const { message, context } = req.body || {};
  if (!message || typeof message !== 'string') {
    res.status(400).json({ error: 'No question was provided.' });
    return;
  }

  const systemPrompt = `You are Tilly, a helpful analytics assistant embedded in a Supercuts franchise scoreboard site (your icon is a robin in a nest — a friendly little mascot for the site). Answer questions about store, employee, DL, and company performance using ONLY the data provided below — never invent numbers that aren't present. Be concise and specific: cite real figures and store/employee names from the data. If the data provided doesn't contain what's needed to answer a question, say so plainly rather than guessing or estimating. If asked your name, you're Tilly.

CURRENT SITE DATA:
${context || 'No data is currently loaded on the site.'}`;

  try {
    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-5',
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: 'user', content: message }],
      }),
    });

    if (!response.ok) {
      const errText = await response.text();
      res.status(502).json({ error: `The AI service returned an error: ${errText.slice(0, 300)}` });
      return;
    }

    const data = await response.json();
    const answer = (data.content || []).map(block => block.text || '').join('\n').trim() || 'No response was generated.';
    res.status(200).json({ answer });
  } catch (err) {
    res.status(500).json({ error: `Could not reach the AI service: ${err.message}` });
  }
}
