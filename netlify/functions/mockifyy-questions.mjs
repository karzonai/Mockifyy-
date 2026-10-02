WINDOW_MS = 60_000;
const MAX_REQUESTS = 10;
const rateMap = new Map();

function json(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Coconstntent-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" }
  });
}

function parseJsonContent(content) {
  const cleaned = String(content || "").trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
  const parsed = JSON.parse(cleaned);
  const questions = Array.isArray(parsed) ? parsed : parsed.questions;
  if (!Array.isArray(questions)) throw new Error("Model returned no question list");
  return questions.filter(q => q && typeof q.question === "string" && Array.isArray(q.options) && q.options.length === 4 && Number.isInteger(Number(q.correctIndex)) && Number(q.correctIndex) >= 0 && Number(q.correctIndex) <= 3)
    .map(q => ({
      question: q.question.trim(),
      options: q.options.map(x => String(x).trim()),
      correctIndex: Number(q.correctIndex),
      explanation: String(q.explanation || ""),
      chapter: String(q.chapter || "General"),
      type: "AI Practice"
    })).filter(q => q.question && q.options.every(Boolean));
}

export default async (request) => {
  if (request.method !== "POST") return json(405, { error: "Use POST" });
  const origin = request.headers.get("origin");
  const host = request.headers.get("host");
  if (origin && host) {
    try { if (new URL(origin).host !== host) return json(403, { error: "Origin not allowed" }); }
    catch { return json(403, { error: "Invalid origin" }); }
  }
  const ip = request.headers.get("x-nf-client-connection-ip") || request.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
  const now = Date.now();
  const entry = rateMap.get(ip) || { count: 0, start: now };
  if (now - entry.start > WINDOW_MS) { entry.count = 0; entry.start = now; }
  entry.count++;
  rateMap.set(ip, entry);
  if (entry.count > MAX_REQUESTS) return json(429, { error: "Too many requests. Please wait a minute and try again." });

  let body;
  try { body = await request.json(); } catch { return json(400, { error: "Invalid JSON request" }); }
  const board = String(body.board || "BSEB").toUpperCase();
  const klass = String(body.class || "10").replace(/class\s*/i, "").trim();
  const subject = String(body.subject || "Science").slice(0, 80);
  const chapter = String(body.chapter || "General").slice(0, 120);
  const medium = board === "CBSE" ? "English" : (String(body.medium || "English").toLowerCase().startsWith("hi") ? "Hindi" : "English");
  const count = Math.max(1, Math.min(Number(body.count) || 10, 50));
  if (!["BSEB", "CBSE"].includes(board)) return json(400, { error: "Board must be BSEB or CBSE" });
  if (!["10", "12"].includes(klass)) return json(400, { error: "Class must be 10 or 12" });
  if (!subject.trim()) return json(400, { error: "Subject is required" });

  const apiKey = process.env.GROQ_API_KEY;
  if (!apiKey) return json(503, { error: "GROQ_API_KEY is not configured in Netlify environment variables" });

  const prompt = `Create ${count} original multiple-choice PRACTICE questions for Mockifyy.\nBoard: ${board}. Class: ${klass}. Subject: ${subject}. Chapter: ${chapter}. Medium: ${medium}.\nFollow the current ${board} Class ${klass} curriculum and typical board difficulty for this subject. Keep every question, all four options, and explanation in ${medium}. Use age-appropriate educational content. Do not mix boards or use concepts outside the selected class/subject/chapter unless chapter is General. Exactly four plausible options per question and exactly one correct answer. correctIndex must be zero-based (A=0, B=1, C=2, D=3). Explain briefly why the answer is correct.\nIMPORTANT: These are AI-generated practice questions, NOT verified official past-year questions. Never invent a year or claim that a question appeared in an actual PYQ paper. Return ONLY valid JSON with shape: {"questions":[{"question":"...","options":["A","B","C","D"],"correctIndex":0,"explanation":"...","chapter":"..."}]}.`;

  try {
    const upstream = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: "llama-3.3-70b-versatile",
        temperature: 0.25,
        max_tokens: Math.min(7000, 250 + count * 240),
        response_format: { type: "json_object" },
        messages: [
          { role: "system", content: "You are a careful Indian school-board exam question writer. Do not fabricate official past-paper provenance. Output valid JSON only." },
          { role: "user", content: prompt }
        ]
      })
    });
    const data = await upstream.json().catch(() => ({}));
    if (!upstream.ok) return json(502, { error: data.error?.message || `AI provider returned ${upstream.status}` });
    const content = data.choices?.[0]?.message?.content;
    const questions = parseJsonContent(content).slice(0, count);
    if (!questions.length) return json(502, { error: "AI response did not contain valid MCQs. Try again." });
    return json(200, { questions, source: "AI Practice", verifiedOfficialPYQ: false });
  } catch (error) {
    return json(502, { error: error?.message || "AI question generation failed" });
  }
};
    
