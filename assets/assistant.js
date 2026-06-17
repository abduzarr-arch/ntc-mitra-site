const assistantForm = document.querySelector("#normativeAssistantForm");
const assistantResult = document.querySelector("#normativeAssistantResult");

function setAssistantResult(html, className = "") {
  if (!assistantResult) return;
  assistantResult.className = `assistant-result ${className}`.trim();
  assistantResult.innerHTML = html;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

if (assistantForm) {
  assistantForm.addEventListener("submit", async (event) => {
    event.preventDefault();

    const data = new FormData(assistantForm);
    const message = String(data.get("message") || "").trim();
    const scenario = String(data.get("scenario") || "defect_smr");

    if (!message) {
      setAssistantResult("<p class=\"assistant-error\">Опишите ситуацию перед отправкой.</p>", "assistant-error");
      return;
    }

    const button = assistantForm.querySelector("button");
    button.disabled = true;
    setAssistantResult("<p class=\"assistant-status\">Готовлю нормативный алгоритм и запускаю проверку ссылок...</p>");

    try {
      const response = await fetch("/api/normative-assistant", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ scenario, message })
      });

      const payload = await response.json().catch(() => ({}));

      if (!response.ok) {
        throw new Error(payload.error || "Сервер помощника пока не подключен.");
      }

      const answer = escapeHtml(payload.final_answer || "Ответ пуст.");
      const meta = payload.meta
        ? `<div class="assistant-meta">Модель черновика: ${escapeHtml(payload.meta.draft_provider || "n/a")} · Проверка: ${escapeHtml(payload.meta.verifier_provider || "n/a")}</div>`
        : "";

      setAssistantResult(`${meta}<div>${answer}</div>`);
    } catch (error) {
      setAssistantResult(
        `<p class="assistant-error">Помощник пока не ответил.</p><p>${escapeHtml(error.message)}</p><p class="assistant-placeholder">Если сайт еще работает в static-режиме Amvera, нужно переключить проект на Node.js и добавить API-ключи в переменные окружения.</p>`,
        "assistant-error"
      );
    } finally {
      button.disabled = false;
    }
  });
}
