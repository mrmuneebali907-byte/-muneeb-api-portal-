const express = require('express');
const Groq = require('groq-sdk');
const path = require('path');

const app = express();
const port = process.env.PORT || 3000;

// YAHAN AAPNI GROQ KEY DIRECT DAAL DEIN (Kyunki yeh aapka apna private project hai)
const groq = new Groq({ apiKey: 'Gsk_UEN88VlHyYBvYcHZMDe3WGdyb3FYO7oSTMtuGf7tLwc6hjcfIgqB' });

app.use(express.static(__dirname));

app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'index.html'));
});

// Aapka private endpoint
app.get('/api/grok', async (req, res) => {
    const query = req.query.text;
    if (!query) return res.status(400).json({ error: "Text is required" });

    try {
        const completion = await groq.chat.completions.create({
            messages: [
                {
                    role: "system",
                    content: "Aap ek savage WhatsApp bot ho jo Roman Urdu mein short, funny aur dosti yaari wale teekhe jawab deta hai. Emojis use karo 😂💀🔥."
                },
                { role: "user", content: query }
            ],
            model: "llama3-8b-8192",
            temperature: 0.85
        });

        res.json({
            status: true,
            owner: "Mr. Muneeb Ali",
            result: completion.choices[0].message.content
        });
    } catch (err) {
        res.status(500).json({ error: "API Side Error" });
    }
});

app.listen(port, () => console.log(`Server running on port ${port}`));
