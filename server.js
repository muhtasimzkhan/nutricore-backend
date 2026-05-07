require('dotenv').config();
const express = require('express');
const cors = require('cors');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json());

const SYSTEM_PROMPT = `
You are a strict nutrition coach.

Always:
- Estimate calories
- Provide protein, carbs, fats
- Give clear, actionable advice

If user gives food:
→ estimate calories + macros

If user asks for plan:
→ generate structured meal plan

If user asks general question:
→ respond concisely with actionable advice

Always format like:

Calories: XXX kcal
Protein: XX g
Carbs: XX g
Fats: XX g

Advice:
...
`;

const userMemory = new Map();
const cache = new Map();
const TTL = 1000 * 60 * 10;

function detectIntent(message) {
  const msg = message.toLowerCase();
  if (msg.includes("plan") || msg.includes("eat today")) return "planner";
  if (msg.includes("calories") || msg.includes("ate") || msg.includes("food")) return "calorie";
  return "general";
}

function buildPrompt(userMessage, userData) {
  let context = "";
  if (userData) {
    context += `User goal: ${userData.goal}\n`;
    context += `Target calories: ${userData.calories}\n`;
  }
  return `${SYSTEM_PROMPT}\n\n${context}\nUser: ${userMessage}\n`;
}

async function fetchWithTimeout(url, options, timeout = 2000) {
  return Promise.race([
    fetch(url, options),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Timeout")), timeout)
    )
  ]);
}

app.post("/ai", async (req, res) => {
  const { message, userId } = req.body;
  if (!message) return res.status(400).json({ reply: "No message provided." });

  const key = (userId || "anon") + ":" + message.toLowerCase();

  if (cache.has(key)) {
    const item = cache.get(key);
    if (Date.now() < item.expiry) {
      return res.json({ reply: item.data, provider: "cache" });
    }
  }

  const userData = userMemory.get(userId);
  const prompt = buildPrompt(message, userData);

  // TRY OPENROUTER
  try {
    const response = await fetchWithTimeout(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
          "HTTP-Referer": "http://localhost:3000",
          "X-Title": "NutriCore"
        },
        body: JSON.stringify({
          model: "openrouter/free",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000
        })
      }
    );

    if (!response.ok) throw new Error("OpenRouter error");
    const data = await response.json();
    const reply = data.choices[0].message.content;
    cache.set(key, { data: reply, expiry: Date.now() + TTL });
    return res.json({ reply, provider: "openrouter" });

  } catch (e) {}

  // FALLBACK GROQ
  try {
    const response = await fetch(
      "https://api.groq.com/openai/v1/chat/completions",
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${process.env.GROQ_API_KEY}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: "llama-3.3-70b-versatile",
          messages: [{ role: "user", content: prompt }],
          max_tokens: 1000
        })
      }
    );

    const data = await response.json();
    const reply = data.choices[0].message.content;
    cache.set(key, { data: reply, expiry: Date.now() + TTL });
    return res.json({ reply, provider: "groq" });

  } catch (e) {
    return res.status(500).json({ reply: "AI unavailable. Check your API keys and connection." });
  }
});

app.listen(3000, () => console.log('NutriCore AI proxy running on http://localhost:3000'));
