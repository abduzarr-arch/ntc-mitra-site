# НТЦ Митра - первый прототип сайта

Это статический MVP сайта. Его можно открыть локально через `index.html`, а позже развернуть на Amvera как статический сайт или завернуть в простой Node/Docker-проект.

## Что внутри

- `index.html` - главная страница.
- `assets/styles.css` - стили и адаптивность.
- `assets/app.js` - первичная форма через `mailto`.
- `assets/hero-engineering.png` - временный инженерный визуал.
- `robots.txt` и `sitemap.xml` - базовые SEO-файлы.

## Следующие шаги

1. Заменить временный визуал на реальные расчетные модели/объекты.
2. Добавить отдельные SEO-страницы под проблемы на стройке.
3. Подключить серверную отправку формы после выбора способа деплоя.
4. Подготовить проект к публикации на Amvera.

## Прототип нормативного AI-помощника

В проект добавлен Node-прототип:

- `server.js` - раздает статические страницы и endpoint `POST /api/normative-assistant`.
- `assets/assistant.js` - клиентская логика формы на `ai-normative-assistant.html`.
- `prompts/agent1_normative_consultant.md` - системный промпт первого агента.
- `prompts/agent2_reference_verifier.md` - системный промпт агента-верификатора.
- `amvera-node.example.yml` - пример конфигурации Amvera для Node.js.

Для запуска помощника на сервере нужны переменные окружения:

- `DEEPSEEK_API_KEY` - ключ DeepSeek для чернового ответа.
- `OPENAI_API_KEY` - ключ OpenAI для проверки и финального ответа.
- `DEEPSEEK_MODEL` - опционально, по умолчанию `deepseek-chat`.
- `OPENAI_MODEL`, `OPENAI_DRAFT_MODEL`, `OPENAI_VERIFIER_MODEL` - опционально.

Пока проект работает в Amvera как `static_web`, интерфейс помощника будет открываться, но endpoint API отвечать не будет. Для включения API нужно переключить проект на Node.js и использовать `npm start`.
