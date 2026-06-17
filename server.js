import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PORT = Number(process.env.PORT || 8080);
const MAX_BODY_BYTES = 24_000;

const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml"
};

const agent1Prompt = await readFile(path.join(__dirname, "prompts", "agent1_normative_consultant.md"), "utf8");
const agent2Prompt = await readFile(path.join(__dirname, "prompts", "agent2_reference_verifier.md"), "utf8");

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

async function readJsonBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      throw new Error("Слишком большой запрос. Сократите описание ситуации.");
    }
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function cleanUserInput(value) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, 6000);
}

async function callChatCompletions({ provider, apiKey, baseUrl, model, messages, temperature = 0.2 }) {
  const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "Authorization": `Bearer ${apiKey}`
    },
    body: JSON.stringify({ model, messages, temperature })
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const message = payload?.error?.message || `${provider} API error ${response.status}`;
    throw new Error(message);
  }

  return payload?.choices?.[0]?.message?.content || "";
}

async function runDraftAgent({ scenario, message }) {
  const userMessage = [
    `Тип ситуации: ${scenario}`,
    `Описание пользователя: ${message}`,
    "",
    "Сформируй черновой нормативно-организационный ответ и список claims для верификатора.",
    "Не выдавай технический расчет. Не подтверждай нормы без проверки."
  ].join("\n");

  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      text: await callChatCompletions({
        provider: "DeepSeek",
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
        model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
        messages: [
          { role: "system", content: agent1Prompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.2
      })
    };
  }

  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      text: await callChatCompletions({
        provider: "OpenAI",
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        model: process.env.OPENAI_DRAFT_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: agent1Prompt },
          { role: "user", content: userMessage }
        ],
        temperature: 0.2
      })
    };
  }

  throw new Error("Не задан DEEPSEEK_API_KEY или OPENAI_API_KEY.");
}

async function runVerifierAgent({ scenario, message, draft }) {
  const verifierInput = [
    "Проверь черновик. В этой версии прототипа retrieval-база нормативных документов еще не подключена.",
    "Поэтому все неподтвержденные точные ссылки должны быть помечены как требующие ручной проверки, а категоричные выводы смягчены.",
    "",
    `Тип ситуации: ${scenario}`,
    `Исходное описание: ${message}`,
    "",
    "Черновик агента 1:",
    draft
  ].join("\n");

  if (process.env.OPENAI_API_KEY) {
    return {
      provider: "openai",
      text: await callChatCompletions({
        provider: "OpenAI",
        apiKey: process.env.OPENAI_API_KEY,
        baseUrl: process.env.OPENAI_BASE_URL || "https://api.openai.com/v1",
        model: process.env.OPENAI_VERIFIER_MODEL || process.env.OPENAI_MODEL || "gpt-4.1-mini",
        messages: [
          { role: "system", content: agent2Prompt },
          { role: "user", content: verifierInput }
        ],
        temperature: 0
      })
    };
  }

  if (process.env.DEEPSEEK_API_KEY) {
    return {
      provider: "deepseek",
      text: await callChatCompletions({
        provider: "DeepSeek",
        apiKey: process.env.DEEPSEEK_API_KEY,
        baseUrl: process.env.DEEPSEEK_BASE_URL || "https://api.deepseek.com",
        model: process.env.DEEPSEEK_VERIFIER_MODEL || process.env.DEEPSEEK_MODEL || "deepseek-chat",
        messages: [
          { role: "system", content: agent2Prompt },
          { role: "user", content: verifierInput }
        ],
        temperature: 0
      })
    };
  }

  throw new Error("Для проверки ответа нужен OPENAI_API_KEY или DEEPSEEK_API_KEY.");
}

async function handleAssistant(req, res) {
  try {
    const body = await readJsonBody(req);
    const scenario = cleanUserInput(body.scenario || "defect_smr");
    const message = cleanUserInput(body.message);

    if (message.length < 20) {
      return sendJson(res, 400, { error: "Опишите ситуацию подробнее: тип конструкции, дефект, стадия работ и что нужно решить." });
    }

    const draft = await runDraftAgent({ scenario, message });
    const verified = await runVerifierAgent({ scenario, message, draft: draft.text });

    return sendJson(res, 200, {
      final_answer: verified.text,
      meta: {
        draft_provider: draft.provider,
        verifier_provider: verified.provider
      }
    });
  } catch (error) {
    return sendJson(res, 500, { error: error.message || "Ошибка помощника." });
  }
}

async function serveStatic(req, res) {
  const url = new URL(req.url, `http://${req.headers.host}`);
  let pathname = decodeURIComponent(url.pathname);
  if (pathname === "/") pathname = "/index.html";
  const safePath = path.normalize(pathname).replace(/^(\.\.[/\\])+/, "");
  const filePath = path.join(__dirname, safePath);

  if (!filePath.startsWith(__dirname) || !existsSync(filePath)) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("Not found");
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const content = await readFile(filePath);
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-cache" : "public, max-age=604800"
  });
  res.end(content);
}

createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/api/normative-assistant") {
    await handleAssistant(req, res);
    return;
  }

  if (req.method === "GET" || req.method === "HEAD") {
    await serveStatic(req, res);
    return;
  }

  res.writeHead(405, { "Content-Type": "text/plain; charset=utf-8" });
  res.end("Method not allowed");
}).listen(PORT, () => {
  console.log(`NTC Mitra site listening on ${PORT}`);
});
