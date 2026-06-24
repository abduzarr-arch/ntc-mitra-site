(function (m, e, t, r, i, k, a) {
  m[i] = m[i] || function () {
    (m[i].a = m[i].a || []).push(arguments);
  };
  m[i].l = 1 * new Date();
  for (let j = 0; j < e.scripts.length; j += 1) {
    if (e.scripts[j].src === r) return;
  }
  k = e.createElement(t);
  a = e.getElementsByTagName(t)[0];
  k.async = 1;
  k.src = r;
  a.parentNode.insertBefore(k, a);
})(window, document, "script", "https://mc.yandex.ru/metrika/tag.js", "ym");

const METRIKA_ID = 110111752;

window.ym(METRIKA_ID, "init", {
  clickmap: true,
  trackLinks: true,
  accurateTrackBounce: true,
  webvisor: false
});

function reachGoal(name, params = {}) {
  if (typeof window.ym !== "function") return;
  window.ym(METRIKA_ID, "reachGoal", name, params);
}

window.mitraAnalytics = {
  goal: reachGoal
};

document.addEventListener("click", (event) => {
  const link = event.target.closest("a");
  if (!link) return;

  const href = link.getAttribute("href") || "";
  if (href.startsWith("tel:")) {
    reachGoal("phone_click", { url: window.location.pathname });
  } else if (href.startsWith("mailto:")) {
    reachGoal("email_click", { url: window.location.pathname });
  } else if (href.includes("#contacts")) {
    reachGoal("contacts_open", { url: window.location.pathname });
  }
});
