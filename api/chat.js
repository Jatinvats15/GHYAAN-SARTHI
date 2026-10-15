// GyaanSathi backend: a small serverless function that keeps your Gemini API key secret.
// Deploy on Vercel (the "api" folder is picked up automatically).
// Required environment variable: GEMINI_API_KEY
// Optional: GEMINI_MODEL (default gemini-2.5-flash)

const MODEL = process.env.GEMINI_MODEL || "gemini-2.5-flash";
const MAX_TURNS = 14;        // how much chat history is sent each time
const MAX_CHARS = 2000;      // longest single message accepted
const LIMIT_PER_MIN = 20;    // best-effort limit per visitor (per server instance)
const hits = new Map();

function systemPrompt(cls, lang) {
  return `You are GyaanSathi, a friendly one-on-one AI tutor for a school student in India. The student is in Class ${cls} (NCERT or state board level). You help with Maths, Science and English.

How to answer:
- Answer the student's doubt step by step. Use short, simple sentences and one idea per step.
- Use everyday Indian examples (roti, cricket, bus, rupees, school) to make ideas concrete.
- Reply in the language the student wrote in: English, Hindi in Devanagari, or a Hindi and English mix. If the student has not written yet, use ${lang === "hi" ? "Hindi" : "English"}. When replying in Hindi, keep key technical terms in English with the Hindi meaning in brackets.
- For homework or practice problems, first give a hint or the first step and let the student try. If the student says they are stuck or asks to see the full solution, show the complete worked solution.
- End most answers with one short question or a tiny practice problem to check understanding. When the student answers, say clearly whether it is right, praise effort, and gently correct any mistake.
- Keep replies under about 120 words unless a full worked solution is needed. Write in plain text only: no markdown symbols, no asterisks, no tables, no headings. Use lines like "1." for steps. Write maths in simple text such as x^2, 3/4, sqrt(2).
- Be warm, patient and encouraging. Never make the student feel bad for not knowing. If the student seems upset, respond kindly in one or two lines, then suggest talking to a teacher or parent.
- Stay on school learning. If asked for something unrelated or unsafe, politely steer back to studies. If a student mentions being harmed or in danger, tell them to talk to a trusted adult or teacher right away.
- If you are not sure of an answer, say so and suggest asking the teacher. Never invent facts.`;
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method === "GET") return res.status(200).json({ ok: true }); // lets the page check the tutor is online
  if (req.method !== "POST") return res.status(405).json({ error: "method_not_allowed" });

  const key = process.env.GEMINI_API_KEY;
  if (!key) return res.status(500).json({ error: "not_configured" });

  // simple per-visitor rate limit
  const ip = String(req.headers["x-forwarded-for"] || "unknown").split(",")[0].trim();
  const now = Date.now();
  const h = hits.get(ip) || { n: 0, t: now };
  if (now - h.t > 60000) { h.n = 0; h.t = now; }
  h.n += 1; hits.set(ip, h);
  if (h.n > LIMIT_PER_MIN) return res.status(429).json({ error: "rate_limited" });

  // validate input (the browser is never trusted)
  const body = req.body || {};
  const cls = ["6", "7", "8", "9", "10"].includes(String(body.cls)) ? String(body.cls) : "8";
  const lang = body.lang === "hi" ? "hi" : "en";
  let messages = Array.isArray(body.messages) ? body.messages : [];
  messages = messages
    .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string" && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
    .slice(-MAX_TURNS);
  while (messages.length && messages[0].role !== "user") messages.shift();
  if (!messages.length || messages[messages.length - 1].role !== "user") {
    return res.status(400).json({ error: "bad_request" });
  }
   // Convert Anthropic-style roles to Gemini roles.
  const contents = messages.map((m) => ({
    role: m.role === "assistant" ? "model" : "user",
    parts: [{ text: m.content }],
  }));


  try {
    const url =
      `https://generativelanguage.googleapis.com/v1beta/models/` +
      `${encodeURIComponent(MODEL)}:generateContent`;

    const r = await fetch(url, {
      method: "POST",
      headers: {
        "x-goog-api-key": key,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        systemInstruction: {
          parts: [
            {
              text: systemPrompt(cls, lang),
            },
          ],
        },
        contents,
        generationConfig: {
          // Gemini 2.5 "thinking" tokens count toward this limit. With 700 the model could spend it all
          // thinking and return no text, which the page showed as "Something went wrong".
          maxOutputTokens: 2048,
          temperature: 0.7,
          ...(/2\.5-flash/.test(MODEL) ? { thinkingConfig: { thinkingBudget: 0 } } : {}),
        },
      }),
    });
    if (!r.ok) {
      // Log the reason to Vercel Logs only (never sent to the browser).
      console.error("Gemini error", r.status, (await r.text()).slice(0, 300));
      const code = r.status === 429 ? 429 : 502;

      return res.status(code).json({
        error: code === 429
          ? "rate_limited"
          : "upstream_error",
      });
    }

    const data = await r.json();

    const text = (data.candidates?.[0]?.content?.parts || [])
      .filter((part) => typeof part.text === "string")
      .map((part) => part.text)
      .join("\n")
      .trim();

    if (!text) {
      console.error("Gemini empty reply", data.candidates?.[0]?.finishReason, data.promptFeedback);
      return res.status(502).json({ error: "empty" });
    }

    return res.status(200).json({ text });
  } catch (e) {
    return res.status(502).json({ error: "upstream_error" });
  }
};

