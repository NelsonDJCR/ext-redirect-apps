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

// Recalcula las reglas de bloqueo según la hora actual
async function syncRules() {
  try {
    const { sites = [] } = await chrome.storage.local.get("sites");
    const rules = [];

    for (const site of sites) {
      if (site.enabled === false) continue;
      const keyword = toKeyword(site.name);
      if (!keyword || isAllowedNow(site)) continue;

      const params = new URLSearchParams({ site: keyword });
      if (site.from && site.to) {
        params.set("from", site.from);
        params.set("to", site.to);
      }

      rules.push({
        id: rules.length + 1,
        priority: 1,
        action: {
          type: "redirect",
          redirect: { extensionPath: "/blocked.html?" + params.toString() }
        },
        condition: {
          regexFilter: "^https?://([^/]*\\.)?" + escapeRegex(keyword) + "\\.",
          resourceTypes: ["main_frame"]
        }
      });
    }

    const existing = await chrome.declarativeNetRequest.getDynamicRules();
    await chrome.declarativeNetRequest.updateDynamicRules({
      removeRuleIds: existing.map((rule) => rule.id),
      addRules: rules
    });

    await redirectOpenTabs(rules);
  } catch (error) {
    console.error("ext-redirect-apps: error al sincronizar reglas", error);
  }
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

function startTimer() {
  chrome.alarms.create("tick", { periodInMinutes: 1 });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { sites } = await chrome.storage.local.get("sites");
  if (!sites) await chrome.storage.local.set({ sites: [] });
  startTimer();
  syncRules();
});

chrome.runtime.onStartup.addListener(() => {
  startTimer();
  syncRules();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "tick") syncRules();
});

// Cuando cambias la lista desde el popup, se aplica al instante
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && changes.sites) syncRules();
});