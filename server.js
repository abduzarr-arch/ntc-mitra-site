import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  appendDialogEntry,
  createConversationId,
  isAdminAuthorized,
  readDialogEntries,
  renderDialogsCsv,
  renderDialogsPage,
  requestAdminAuth
} from "./dialog-log.js";

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
const analyticsHead = '<script src="/assets/analytics.js?v=20260624-1"></script>';
const analyticsFallback = '<noscript><div><img src="https://mc.yandex.ru/watch/110111752" style="position:absolute;left:-9999px" alt=""></div></noscript>';

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

function cleanUserInput(value, limit = 6000) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
}

function sanitizeAssistantAnswer(value) {
  let text = String(value || "").trim();

  text = text.replace(/```(?:json|yaml)?[\s\S]*?```/gi, (block) => {
    const lower = block.toLowerCase();
    if (
      lower.includes("checked_claims") ||
      lower.includes("original_claim") ||
      lower.includes("source_requested") ||
      lower.includes("overall_risk") ||
      lower.includes("requires_human_review")
    ) {
      return "";
    }
    return block;
  });

  const serviceMarkers = [
    "{ \"checked_claims\"",
    "{\"checked_claims\"",
    "\"checked_claims\"",
    "\"original_claim\"",
    "\"source_requested\"",
    "\"overall_risk\"",
    "\"requires_human_review\""
  ];

  const serviceIndex = serviceMarkers
    .map((marker) => text.indexOf(marker))
    .filter((index) => index >= 0)
    .sort((a, b) => a - b)[0];

  if (serviceIndex >= 0) {
    text = text.slice(0, serviceIndex).trim();
  }

  return text
    .replace(/\s*---\s*/g, "\n\n")
    .replace(/\s+(#{1,3}\s+)/g, "\n\n$1")
    .replace(/^#\s+/gm, "## ")
    .replace(/^#{3}\s+/gm, "## ")
    .replace(/\s+(\d+\.\s+[А-ЯA-ZЁ])/g, "\n\n$1")
    .replace(/\s+(\*\*[А-ЯA-ZЁ][^*]{2,80}:\*\*)/g, "\n\n$1")
    .replace(/\s+(-\s+[А-ЯA-ZЁ])/g, "\n$1")
    .replace(/\s+(Шаг\s+\d+[:.])/gi, "\n\n$1")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
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

async function runDraftAgent({ scenario, message, previousAnswer, refinement }) {
  const userMessage = [
    `Тип ситуации: ${scenario}`,
    `Описание пользователя: ${message}`,
    previousAnswer ? `Предыдущий ответ помощника: ${previousAnswer}` : "",
    refinement ? `Уточнение пользователя: ${refinement}` : "",
    "",
    refinement
      ? "Сформируй полный обновленный нормативно-организационный ответ с учетом уточнения. Не возвращай только изменения или комментарий к прежнему ответу. Перестрой алгоритм целиком, если уточнение меняет порядок действий."
      : "Сформируй черновой нормативно-организационный ответ и список claims для верификатора.",
    "Не выдавай технический расчет. Не подтверждай нормы без проверки."
  ].filter(Boolean).join("\n");

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

async function runVerifierAgent({ scenario, message, draft, previousAnswer, refinement }) {
  const verifierInput = [
    "Проверь черновик. В этой версии прототипа retrieval-база нормативных документов еще не подключена.",
    "Поэтому все неподтвержденные точные ссылки должны быть помечены как требующие ручной проверки, а категоричные выводы смягчены.",
    "Верни только финальный публичный ответ в Markdown. Не возвращай JSON, служебные claims и внутренний лог проверки.",
    "Не пиши весь ответ одной строкой. После каждого заголовка, пункта и подпункта ставь перенос строки.",
    "В каждом пункте разделов 'Что сделать прямо сейчас' и 'Пошаговый алгоритм' указывай основание в скобках: '(основание: ...)' или '(основание требует ручной проверки: ...)'",
    "Если точная статья, пункт СП или ГОСТ не подтверждены источником, не выдавай их как проверенные. Пиши: 'пункт требует ручной проверки актуальной редакции'.",
    "Проверяй не только существование документа, но и его статус: действует, заменен, утратил силу, применяется только исторически. Если статус не подтвержден официальным источником, не называй документ действующим.",
    "Не ссылайся на РД-11-02-2006 и РД-11-05-2007 как на действующие документы без прямого подтверждения актуального статуса. Для исполнительной документации и журналов работ указывай, что требуется сверка по актуальным приказам Минстроя России или иного уполномоченного органа.",
    refinement ? "Это уточнение предыдущего ответа. Верни полный обновленный ответ со всеми 8 главами, а не краткое дополнение и не только измененные пункты." : "",
    "Обязательно используй главы: 1. Краткая квалификация ситуации; 2. Что сделать прямо сейчас; 3. Пошаговый алгоритм; 4. Документы; 5. Нормативные основания; 6. Риски; 7. Когда привлекать НТЦ Митра; 8. Уточняющие вопросы.",
    "",
    `Тип ситуации: ${scenario}`,
    `Исходное описание: ${message}`,
    previousAnswer ? `Предыдущий ответ помощника: ${previousAnswer}` : "",
    refinement ? `Уточнение пользователя: ${refinement}` : "",
    "",
    "Черновик агента 1:",
    draft
  ].filter(Boolean).join("\n");

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
    const previousAnswer = cleanUserInput(body.previous_answer, 9000);
    const refinement = cleanUserInput(body.refinement, 3000);
    const consent = body.consent === true;
    const conversationId = createConversationId(body.conversation_id);

    if (message.length < 20 && refinement.length < 20) {
      return sendJson(res, 400, { error: "Опишите ситуацию подробнее: тип конструкции, дефект, стадия работ и что нужно решить." });
    }
    if (!consent) {
      return sendJson(res, 400, { error: "Для отправки запроса подтвердите согласие на сохранение диалога." });
    }

    const draft = await runDraftAgent({ scenario, message, previousAnswer, refinement });
    const verified = await runVerifierAgent({ scenario, message, draft: draft.text, previousAnswer, refinement });
    const finalAnswer = sanitizeAssistantAnswer(verified.text);

    if (finalAnswer.length < 120) {
      throw new Error("Помощник вернул неполный ответ. Попробуйте уточнить запрос или повторить отправку.");
    }

    try {
      await appendDialogEntry({
        conversation_id: conversationId,
        scenario,
        message,
        refinement,
        answer: finalAnswer,
        draft_provider: draft.provider,
        verifier_provider: verified.provider
      });
    } catch (logError) {
      console.error("Failed to write assistant dialog log:", logError);
    }

    return sendJson(res, 200, {
      final_answer: finalAnswer,
      conversation_id: conversationId,
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
  let content = await readFile(filePath);
  if (ext === ".html") {
    let html = content.toString("utf8");
    if (!html.includes("/assets/analytics.js")) {
      html = html.replace("</head>", `  ${analyticsHead}\n  </head>`);
      html = html.replace("<body>", `<body>\n    ${analyticsFallback}`);
    }
    content = Buffer.from(html, "utf8");
  }
  const cacheControl = [".html", ".js", ".css"].includes(ext)
    ? "no-cache"
    : "public, max-age=604800";
  res.writeHead(200, {
    "Content-Type": MIME[ext] || "application/octet-stream",
    "Cache-Control": cacheControl
  });
  res.end(content);
}

createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (req.method === "POST" && url.pathname === "/api/normative-assistant") {
    await handleAssistant(req, res);
    return;
  }

  if (req.method === "GET" && ["/admin/dialogs", "/admin/dialogs.csv"].includes(url.pathname)) {
    if (!process.env.ADMIN_LOG_TOKEN) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", "Cache-Control": "no-store" });
      res.end("Не задана переменная ADMIN_LOG_TOKEN.");
      return;
    }
    if (!isAdminAuthorized(req)) {
      requestAdminAuth(res);
      return;
    }

    const entries = await readDialogEntries();
    if (url.pathname.endsWith(".csv")) {
      res.writeHead(200, {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="ntc-mitra-dialogs.csv"',
        "Cache-Control": "no-store",
        "X-Robots-Tag": "noindex, nofollow"
      });
      res.end(renderDialogsCsv(entries));
      return;
    }

    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Robots-Tag": "noindex, nofollow"
    });
    res.end(renderDialogsPage(entries));
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
