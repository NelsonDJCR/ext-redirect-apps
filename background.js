// Segundos niveles comunes que se ignoran al buscar el nombre del sitio
const SECOND_LEVEL = new Set(["com", "co", "org", "net", "gov", "edu"]);

const DEFAULT_SETTINGS = {
  sessionLimitMinutes: 10,
  cooldownEnabled: true,
  cooldownMinutes: 5
};

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

function toHostLike(input) {
  let host = String(input || "").trim().toLowerCase();
  host = host.replace(/^[a-z]+:\/\//, "").split(/[/?#]/)[0];
  host = host.replace(/^www\./, "");
  return host;
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

function effectiveSettings(settings) {
  return { ...DEFAULT_SETTINGS, ...settings };
}

// Duración máxima de la sesión en ms (0 = sin límite)
function limitMs(site, settings) {
  const merged = effectiveSettings(settings);
  const minutes = Number(site.sessionMinutes ?? merged.sessionLimitMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
}

// Duración de la espera tras llegar al límite (0 = sin espera)
function cooldownMs(settings) {
  const merged = effectiveSettings(settings);
  if (!merged.cooldownEnabled) return 0;
  const minutes = Number(merged.cooldownMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
}

// Estado de la sesión en el horario actual: "none", "active" u "over"
function sessionState(site, sessions, settings, nowMs) {
  const limit = limitMs(site, settings);
  const startedAt = sessions[site.id];
  if (!limit || !startedAt) return "none";
  if (startedAt < windowStartMs(site, new Date(nowMs))) return "none"; // sesión de un horario anterior
  return nowMs >= startedAt + limit ? "over" : "active";
}

function isInCooldown(site, cooldowns, nowMs) {
  const until = Number(cooldowns[site.id] || 0);
  return Number.isFinite(until) && until > nowMs;
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

// Recalcula las reglas de bloqueo según la hora, sesiones y cooldowns
async function doSync() {
  const {
    sites = [],
    sessions = {},
    cooldowns = {},
    settings = {}
  } = await chrome.storage.local.get(["sites", "sessions", "cooldowns", "settings"]);

  const now = Date.now();
  const merged = effectiveSettings(settings);
  const rules = [];
  const cleanSessions = { ...sessions };
  const cleanCooldowns = { ...cooldowns };
  const overLimitSites = [];
  let storageChanged = false;

  for (const site of sites) {
    if (site.enabled === false) continue;
    const keyword = toKeyword(site.name);
    if (!keyword) continue;

    const cooldownUntil = Number(cleanCooldowns[site.id] || 0);
    if (cooldownUntil && cooldownUntil <= now) {
      delete cleanCooldowns[site.id];
      storageChanged = true;
    }

    let reason = "";
    if (!isAllowedNow(site)) {
      reason = "schedule";
    } else if (isInCooldown(site, cleanCooldowns, now)) {
      reason = "cooldown";
    } else {
      const state = sessionState(site, cleanSessions, merged, now);
      if (state === "over") {
        overLimitSites.push(site);
        delete cleanSessions[site.id];
        storageChanged = true;

        const waitMs = cooldownMs(merged);
        if (waitMs > 0) {
          const until = now + waitMs;
          cleanCooldowns[site.id] = until;
          storageChanged = true;
          reason = "cooldown";
          // Despierta al terminar la espera
          chrome.alarms.create("cooldown-end:" + site.id, { when: until });
        }
      } else if (state === "active") {
        // Despierta justo cuando termina la sesión
        chrome.alarms.create("session-end:" + site.id, {
          when: cleanSessions[site.id] + limitMs(site, merged)
        });
      }
    }

    if (!reason) continue;

    const params = new URLSearchParams({ site: keyword, reason });
    const hostLike = toHostLike(site.name);
    if (hostLike) params.set("host", hostLike);
    if (site.from && site.to) {
      params.set("from", site.from);
      params.set("to", site.to);
    }

    if (reason === "cooldown") {
      const until = Number(cleanCooldowns[site.id] || 0);
      const remainingMinutes = Math.max(1, Math.ceil((until - now) / 60000));
      params.set("minutes", String(remainingMinutes));
      if (until > now) params.set("until", String(until));
    }

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

  // Limpia sesiones/cooldowns de sitios que ya no existen
  const ids = new Set(sites.map((site) => site.id));
  const keptSessions = Object.fromEntries(Object.entries(cleanSessions).filter(([id]) => ids.has(id)));
  const keptCooldowns = Object.fromEntries(Object.entries(cleanCooldowns).filter(([id]) => ids.has(id)));
  if (Object.keys(keptSessions).length !== Object.keys(cleanSessions).length) storageChanged = true;
  if (Object.keys(keptCooldowns).length !== Object.keys(cleanCooldowns).length) storageChanged = true;

  if (storageChanged) {
    await chrome.storage.local.set({ sessions: keptSessions, cooldowns: keptCooldowns });
  }

  await redirectOpenTabs(rules);
  await closeOverLimitTabs(overLimitSites);
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

async function closeOverLimitTabs(sites) {
  if (!sites.length) return;

  const regexes = sites
    .map((site) => {
      const keyword = toKeyword(site.name);
      return keyword ? new RegExp(urlPattern(keyword), "i") : null;
    })
    .filter(Boolean);

  if (!regexes.length) return;

  const tabs = await chrome.tabs.query({});
  const toClose = [];
  for (const tab of tabs) {
    if (!tab.url || !/^https?:\/\//.test(tab.url)) continue;
    if (regexes.some((regex) => regex.test(tab.url)) && typeof tab.id === "number") {
      toClose.push(tab.id);
    }
  }

  if (toClose.length) {
    await chrome.tabs.remove(toClose);
  }
}

// Al abrir un sitio con límite de sesión, inicia la sesión si aún no hay una
async function handleNavigation(url) {
  if (!/^https?:\/\//.test(url)) return;

  const {
    sites = [],
    sessions = {},
    cooldowns = {},
    settings = {}
  } = await chrome.storage.local.get(["sites", "sessions", "cooldowns", "settings"]);

  const now = Date.now();
  const merged = effectiveSettings(settings);
  let changed = false;

  for (const site of sites) {
    if (site.enabled === false || !limitMs(site, merged) || !isAllowedNow(site)) continue;
    if (isInCooldown(site, cooldowns, now)) continue;

    const keyword = toKeyword(site.name);
    if (!keyword || !new RegExp(urlPattern(keyword), "i").test(url)) continue;

    if (sessionState(site, sessions, merged, now) === "none") {
      sessions[site.id] = now;
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
  const { sites, sessions, cooldowns, settings } = await chrome.storage.local.get([
    "sites",
    "sessions",
    "cooldowns",
    "settings"
  ]);

  if (!sites) await chrome.storage.local.set({ sites: [] });
  if (!sessions) await chrome.storage.local.set({ sessions: {} });
  if (!cooldowns) await chrome.storage.local.set({ cooldowns: {} });
  if (!settings) {
    await chrome.storage.local.set({
      settings: {
        lockEnabled: false,
        lockSeconds: 15,
        sessionLimitMinutes: 10,
        cooldownEnabled: true,
        cooldownMinutes: 5
      }
    });
  }

  startTimer();
  syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  startTimer();
  syncRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (
    alarm.name === "tick" ||
    alarm.name.startsWith("session-end:") ||
    alarm.name.startsWith("cooldown-end:")
  ) {
    syncRules();
  }
});

// Cuando cambias la lista o configuración desde el popup, se aplica al instante
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local") return;
  if (changes.sites || changes.settings) syncRules();
});

// Detecta cuándo abres un sitio (solo la página principal, no iframes)
chrome.webNavigation.onCommitted.addListener((details) => {
  if (details.frameId !== 0) return;
  enqueue(() => handleNavigation(details.url));
});
