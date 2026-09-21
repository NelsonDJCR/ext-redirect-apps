// Segundos niveles comunes que se ignoran al buscar el nombre del sitio
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu"]);

// "facebook.com", "https://m.facebook.com/x" o "Facebook" -> "facebook"
function toKeyword(input) {
  let host = String(input || "").trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  host = host.replace(/^www\./, "");
  const labels = host.split(".").filter(Boolean);
  if (labels.length <= 1) return labels[0] || "";
  labels.pop(); // quita la extensión (.com, .net, .uk...)
  while (labels.length > 1 && SECOND_LEVEL.has(labels[labels.length - 1])) {
    labels.pop(); // quita .co de .co.uk, .com de .com.co, etc.
  }
  return labels[labels.length - 1];
}

function escapeRegex(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// Patrón de URL que coincide con el sitio sin importar subdominio ni extensión
function urlPattern(keyword) {
  return "^https?://([^/]*\\.)?" + escapeRegex(keyword) + "\\.";
}

// "10:00" -> 600 (minutos desde medianoche)
function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

// ¿Estamos dentro del horario en el que SÍ se puede usar el sitio?
function isAllowedNow(site, now = new Date()) {
  const from = toMinutes(site.from);
  const to = toMinutes(site.to);
  // Sin horario válido: el sitio queda bloqueado todo el día
  if (from === null || to === null || from === to) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to
    ? current >= from && current < to
    : current >= from || current < to; // horario que cruza medianoche
}

// Momento (ms) en que empezó el horario permitido actual.
// Solo tiene sentido si isAllowedNow() es true.
function windowStartMs(site, now) {
  const from = toMinutes(site.from);
  const start = new Date(now);
  start.setHours(Math.floor(from / 60), from % 60, 0, 0);
  if (start.getTime() > now.getTime()) start.setDate(start.getDate() - 1);
  return start.getTime();
}

// Duración máxima de la sesión en ms (0 = sin límite)
function limitMs(site) {
  const minutes = Number(site.sessionMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
}

// Estado de la sesión en el horario actual: "none", "active" u "over"
function sessionState(site, sessions, nowMs) {
  const limit = limitMs(site);
  const startedAt = sessions[site.id];
  if (!limit || !startedAt) return "none";
  if (startedAt < windowStartMs(site, new Date(nowMs))) return "none"; // sesión de un horario anterior
  return nowMs >= startedAt + limit ? "over" : "active";
}

// Cola: evita que dos sincronizaciones corran al mismo tiempo
let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((error) => console.error("ext-redirect-apps:", error));
  return queue;
}

function syncRules() {
  return enqueue(doSync);
}

// Recalcula las reglas de bloqueo según la hora y las sesiones
async function doSync() {
  const { sites = [], sessions = {} } = await chrome.storage.local.get(["sites", "sessions"]);
  const now = Date.now();
  const rules = [];

  for (const site of sites) {
    if (site.enabled === false) continue;
    const keyword = toKeyword(site.name);
    if (!keyword) continue;

    let reason = "";
    if (!isAllowedNow(site)) {
      reason = "schedule";
    } else {
      const state = sessionState(site, sessions, now);
      if (state === "over") {
        reason = "session";
      } else if (state === "active") {
        // Despierta justo cuando termina la sesión
        chrome.alarms.create("session-end:" + site.id, {
          when: sessions[site.id] + limitMs(site)
        });
      }
    }
    if (!reason) continue;

    const params = new URLSearchParams({ site: keyword, reason });
    if (site.from && site.to) {
      params.set("from", site.from);
      params.set("to", site.to);
    }
    if (reason === "session") params.set("minutes", String(site.sessionMinutes));

    rules.push({
      id: rules.length + 1,
      priority: 1,
      action: {
        type: "redirect",
        redirect: { extensionPath: "/blocked.html?" + params.toString() }
      },
      condition: {
        regexFilter: urlPattern(keyword),
        resourceTypes: ["main_frame"]
      }
    });
  }

  const existing = await chrome.declarativeNetRequest.getDynamicRules();
  await chrome.declarativeNetRequest.updateDynamicRules({
    removeRuleIds: existing.map((rule) => rule.id),
    addRules: rules
  });

  // Limpia sesiones de sitios que ya no existen
  const ids = new Set(sites.map((site) => site.id));
  const kept = Object.fromEntries(Object.entries(sessions).filter(([id]) => ids.has(id)));
  if (Object.keys(kept).length !== Object.keys(sessions).length) {
    await chrome.storage.local.set({ sessions: kept });
  }

  await redirectOpenTabs(rules);
}

// Las reglas solo afectan navegaciones nuevas, así que
// también sacamos las pestañas que ya estaban abiertas en un sitio bloqueado
async function redirectOpenTabs(rules) {
  if (!rules.length) return;
  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.url || !/^https?:\/\//.test(tab.url)) continue;
    for (const rule of rules) {
      if (new RegExp(rule.condition.regexFilter, "i").test(tab.url)) {
        chrome.tabs.update(tab.id, {
          url: chrome.runtime.getURL(rule.action.redirect.extensionPath)
        });
        break;
      }
    }
  }
}

// Al abrir un sitio con límite de sesión, inicia la sesión si aún no hay una
async function handleNavigation(url) {
  if (!/^https?:\/\//.test(url)) return;
  const { sites = [], sessions = {} } = await chrome.storage.local.get(["sites", "sessions"]);
  let changed = false;

  for (const site of sites) {
    if (site.enabled === false || !limitMs(site) || !isAllowedNow(site)) continue;
    const keyword = toKeyword(site.name);
    if (!keyword || !new RegExp(urlPattern(keyword), "i").test(url)) continue;

    if (sessionState(site, sessions, Date.now()) === "none") {
      sessions[site.id] = Date.now();
      changed = true;
    }
  }

  if (changed) await chrome.storage.local.set({ sessions });
  await doSync();
}

function startTimer() {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { sites, sessions } = await chrome.storage.local.get(["sites", "sessions"]);
  if (!sites) await chrome.storage.local.set({ sites: [] });
  if (!sessions) await chrome.storage.local.set({ sessions: {} });
  startTimer();
  syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  startTimer();
  syncRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick" || alarm.name.startsWith("session-end:")) syncRules();
});

// Cuando cambias la lista desde el popup, se aplica al instante
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sites) syncRules();
});

// Detecta cuándo abres un sitio (solo la página principal, no iframes)
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  enqueue(() => handleNavigation(details.url));
});