const DEFAULT_SETTINGS = {
  lockEnabled: false,
  lockSeconds: 15,
  sessionLimitMinutes: 10,
  cooldownEnabled: true,
  cooldownMinutes: 5
};
const DEFAULT_POMODORO_MINUTES = 20;
const MIN_SECONDS = 5;
const MAX_SECONDS = 300;
const MIN_SESSION_MINUTES = 1;
const MAX_SESSION_MINUTES = 240;
const MIN_COOLDOWN_MINUTES = 1;
const MAX_COOLDOWN_MINUTES = 120;

const $ = (id) => document.getElementById(id);

const viewSites = $("view-sites");
const viewSettings = $("view-settings");
const nameInput = $("name");
const fromInput = $("from");
const toInput = $("to");
const addBtn = $("add-btn");
const errorEl = $("error");
const listEl = $("list");
const emptyEl = $("empty");
const settingsBtn = $("settings-btn");
const backBtn = $("back-btn");
const pomodoroBtn = $("pomodoro-btn");
const pomodoroStatusEl = $("pomodoro-status");
const lockEnabledInput = $("lock-enabled");
const lockSecondsInput = $("lock-seconds");
const lockSecondsRow = $("lock-seconds-row");
const sessionLimitInput = $("session-limit-minutes");
const cooldownEnabledInput = $("cooldown-enabled");
const cooldownMinutesInput = $("cooldown-minutes");
const cooldownMinutesRow = $("cooldown-minutes-row");
const settingsErrorEl = $("settings-error");
const overlay = $("overlay");
const overlayTitle = $("overlay-title");
const countEl = $("count");
const cancelBtn = $("overlay-cancel");
const confirmBtn = $("overlay-confirm");

// Sitio que está en modo edición (solo vive mientras el popup está abierto)
let editingId = null;
let refreshTimer = null;

/* ---------- Utilidades de tiempo de sesión ---------- */

function toMinutes(value) {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value || "");
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function isAllowedNow(site, now = new Date()) {
  const from = toMinutes(site.from);
  const to = toMinutes(site.to);
  if (from === null || to === null || from === to) return false;
  const current = now.getHours() * 60 + now.getMinutes();
  return from < to ? current >= from && current < to : current >= from || current < to;
}

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

function limitMs(site, settings) {
  const merged = effectiveSettings(settings);
  const minutes = Number(site.sessionMinutes ?? merged.sessionLimitMinutes);
  return Number.isFinite(minutes) && minutes > 0 ? minutes * 60 * 1000 : 0;
}

function formatMinutesFromMs(ms) {
  const total = Math.max(0, Math.ceil(ms / 60000));
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h > 0) return h + "h " + String(m).padStart(2, "0") + "m";
  return total + "m";
}

function formatClockFromMs(ms) {
  const totalSeconds = Math.max(0, Math.ceil(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return String(minutes).padStart(2, "0") + ":" + String(seconds).padStart(2, "0");
}

function getPomodoroState(rawPomodoro, nowMs = Date.now()) {
  const until = Number(rawPomodoro?.until || 0);
  if (!Number.isFinite(until) || until <= nowMs) {
    return { active: false, remainingMs: 0 };
  }
  return {
    active: true,
    remainingMs: until - nowMs
  };
}

function renderPomodoro(rawPomodoro, nowMs = Date.now()) {
  const state = getPomodoroState(rawPomodoro, nowMs);
  if (state.active) {
    pomodoroBtn.textContent = "Detener Pomodoro";
    pomodoroBtn.className = "btn-secondary";
    pomodoroStatusEl.textContent =
      "Pomodoro activo: todos los sitios bloqueados. Tiempo restante " +
      formatClockFromMs(state.remainingMs) +
      ".";
    return;
  }

  pomodoroBtn.textContent = "Iniciar Pomodoro (" + DEFAULT_POMODORO_MINUTES + " min)";
  pomodoroBtn.className = "btn-primary";
  pomodoroStatusEl.textContent =
    "Bloquea todos los sitios por " + DEFAULT_POMODORO_MINUTES + " minutos para enfocarte.";
}

function getSiteStatus(site, sessions, cooldowns, settings, nowMs) {
  if (site.enabled === false || !isAllowedNow(site, new Date(nowMs))) return null;

  const cooldownUntil = Number(cooldowns?.[site.id] || 0);
  if (cooldownUntil > nowMs) {
    const totalCooldown = Number(settings.cooldownMinutes) * 60 * 1000;
    const remaining = cooldownUntil - nowMs;
    const progress = totalCooldown > 0 ? Math.min(100, Math.max(0, ((totalCooldown - remaining) / totalCooldown) * 100)) : 0;
    return {
      type: "cooldown",
      progress,
      left: formatMinutesFromMs(remaining)
    };
  }

  const limit = limitMs(site, settings);
  if (!limit) return null;

  const rawSession = sessions?.[site.id];
  const startMs = windowStartMs(site, new Date(nowMs));
  let elapsed = 0;

  if (rawSession && typeof rawSession === "object") {
    const recordStart = Number(rawSession.windowStart);
    if (recordStart !== startMs) return null;
    const baseElapsed = Math.max(0, Number(rawSession.elapsedMs) || 0);
    const runningSince = Number(rawSession.runningSince);
    const runningElapsed = Number.isFinite(runningSince) && runningSince > 0
      ? Math.max(0, nowMs - runningSince)
      : 0;
    elapsed = baseElapsed + runningElapsed;
  } else {
    const startedAt = Number(rawSession || 0);
    if (!startedAt || startedAt < startMs) return null;
    elapsed = Math.max(0, nowMs - startedAt);
  }

  const remaining = Math.max(0, limit - elapsed);
  return {
    type: "active",
    progress: Math.min(100, Math.max(0, (elapsed / limit) * 100)),
    elapsed: formatMinutesFromMs(elapsed),
    left: formatMinutesFromMs(remaining)
  };
}

/* ---------- Almacenamiento ---------- */

async function getSites() {
  const { sites = [] } = await chrome.storage.local.get("sites");
  return sites;
}

async function saveSites(sites) {
  await chrome.storage.local.set({ sites });
}

async function getSettings() {
  const { settings } = await chrome.storage.local.get("settings");
  return { ...DEFAULT_SETTINGS, ...settings };
}

async function saveSettings(settings) {
  await chrome.storage.local.set({ settings });
}

/* ---------- Pantalla de espera ---------- */

// Devuelve true si el cambio puede continuar, false si se canceló.
// Si el bloqueo por tiempo está desactivado, deja pasar de inmediato.
async function requestUnlock(title) {
  const settings = await getSettings();
  if (!settings.lockEnabled) return true;

  return new Promise((resolve) => {
    const seconds = settings.lockSeconds;
    const endsAt = performance.now() + seconds * 1000;
    let finished = false;

    overlayTitle.textContent = title;
    countEl.textContent = seconds;
    confirmBtn.disabled = true;
    overlay.classList.remove("running", "done");
    overlay.style.setProperty("--duration", seconds + "s");
    overlay.hidden = false;
    void overlay.offsetWidth; // reinicia la animación del anillo
    overlay.classList.add("running");
    cancelBtn.focus();

    const timer = setInterval(() => {
      const remaining = Math.ceil((endsAt - performance.now()) / 1000);
      if (remaining > 0) {
        countEl.textContent = remaining;
        return;
      }
      clearInterval(timer);
      finished = true;
      overlay.classList.remove("running");
      overlay.classList.add("done");
      countEl.textContent = "✓";
      confirmBtn.disabled = false;
      confirmBtn.focus();
    }, 100);

    function close(result) {
      clearInterval(timer);
      overlay.hidden = true;
      overlay.classList.remove("running", "done");
      confirmBtn.removeEventListener("click", onConfirm);
      cancelBtn.removeEventListener("click", onCancel);
      resolve(result);
    }
    function onConfirm() {
      if (finished) close(true);
    }
    function onCancel() {
      close(false);
    }

    confirmBtn.addEventListener("click", onConfirm);
    cancelBtn.addEventListener("click", onCancel);
  });
}

/* ---------- Lista de sitios ---------- */

function showError(message) {
  errorEl.textContent = message;
}

function validTimes(from, to) {
  if (!from || !to) return "Elige la hora de inicio y la de fin.";
  if (from === to) return "La hora de inicio y la de fin no pueden ser iguales.";
  return "";
}

// Agregar es libre: te restringe más, no menos
async function addSite() {
  const name = nameInput.value.trim();
  const from = fromInput.value;
  const to = toInput.value;

  if (!name) return showError("Escribe el nombre del sitio.");
  const timeError = validTimes(from, to);
  if (timeError) return showError(timeError);

  const sites = await getSites();
  const exists = sites.some((s) => s.name.toLowerCase() === name.toLowerCase());
  if (exists) return showError("Ese sitio ya está en la lista.");

  sites.push({ id: Date.now().toString(), name, from, to, enabled: true });
  await saveSites(sites);
  nameInput.value = "";
  showError("");
  render();
}

async function updateSite(id, changes) {
  const sites = await getSites();
  const site = sites.find((s) => s.id === id);
  if (!site) return;
  Object.assign(site, changes);
  await saveSites(sites);
}

async function deleteSite(id) {
  const sites = await getSites();
  await saveSites(sites.filter((s) => s.id !== id));
}

function makeTimeField(site, key, label, value) {
  const field = document.createElement("div");
  field.className = "field";

  const labelEl = document.createElement("label");
  labelEl.textContent = label;
  labelEl.htmlFor = "edit-" + key + "-" + site.id;

  const input = document.createElement("input");
  input.type = "time";
  input.id = labelEl.htmlFor;
  input.value = value;

  field.append(labelEl, input);
  return { field, input };
}

function makeIconButton(symbol, title, extraClass) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "icon-btn" + (extraClass ? " " + extraClass : "");
  button.textContent = symbol;
  button.title = title;
  button.setAttribute("aria-label", title);
  return button;
}

async function render() {
  const { sites = [], sessions = {}, cooldowns = {}, settings = {}, pomodoro = null } =
    await chrome.storage.local.get(["sites", "sessions", "cooldowns", "settings", "pomodoro"]);
  const mergedSettings = effectiveSettings(settings);
  const nowMs = Date.now();

  renderPomodoro(pomodoro, nowMs);

  listEl.textContent = "";
  emptyEl.hidden = sites.length > 0;

  for (const site of sites) {
    const isEditing = editingId === site.id;
    const item = document.createElement("li");
    item.className = "item" + (site.enabled === false ? " disabled" : "");

    // Cabecera: nombre + interruptor + editar + eliminar
    const head = document.createElement("div");
    head.className = "item-head";

    const nameEl = document.createElement("span");
    nameEl.className = "item-name";
    nameEl.textContent = site.name;

    const actions = document.createElement("div");
    actions.className = "item-actions";

    const toggle = document.createElement("input");
    toggle.type = "checkbox";
    toggle.className = "toggle";
    toggle.checked = site.enabled !== false;
    toggle.title = "Activar o desactivar el bloqueo de este sitio";
    toggle.addEventListener("change", async () => {
      if (toggle.checked) {
        // Reactivar el bloqueo es libre
        await updateSite(site.id, { enabled: true });
      } else {
        // Desactivarlo pasa por la espera
        toggle.checked = true;
        const ok = await requestUnlock("Desactivar " + site.name);
        if (ok) await updateSite(site.id, { enabled: false });
      }
      render();
    });

    actions.append(toggle);

    if (!isEditing) {
      const editBtn = makeIconButton("✎", "Editar horario");
      editBtn.addEventListener("click", async () => {
        const ok = await requestUnlock("Editar " + site.name);
        if (ok) editingId = site.id;
        render();
      });
      actions.append(editBtn);
    }

    const delBtn = makeIconButton("✕", "Eliminar", "danger");
    delBtn.addEventListener("click", async () => {
      const ok = await requestUnlock("Eliminar " + site.name);
      if (ok) {
        if (editingId === site.id) editingId = null;
        await deleteSite(site.id);
      }
      render();
    });
    actions.append(delBtn);

    head.append(nameEl, actions);
    item.append(head);

    if (isEditing) {
      // Modo edición: horas editables + guardar / cancelar
      const times = document.createElement("div");
      times.className = "item-times";
      const fromField = makeTimeField(site, "from", "Desde", site.from);
      const toField = makeTimeField(site, "to", "Hasta", site.to);
      times.append(fromField.field, toField.field);

      const editActions = document.createElement("div");
      editActions.className = "edit-actions";

      const cancel = document.createElement("button");
      cancel.type = "button";
      cancel.className = "btn-secondary";
      cancel.textContent = "Cancelar";
      cancel.addEventListener("click", () => {
        editingId = null;
        showError("");
        render();
      });

      const save = document.createElement("button");
      save.type = "button";
      save.className = "btn-primary";
      save.textContent = "Guardar";
      save.addEventListener("click", async () => {
        const from = fromField.input.value;
        const to = toField.input.value;
        const timeError = validTimes(from, to);
        if (timeError) return showError(timeError);
        await updateSite(site.id, { from, to });
        editingId = null;
        showError("");
        render();
      });

      editActions.append(cancel, save);
      item.append(times, editActions);
    } else {
      const status = getSiteStatus(site, sessions, cooldowns, mergedSettings, nowMs);
      if (status) {
        const box = document.createElement("div");
        box.className = "session-box" + (status.type === "cooldown" ? " cooldown" : "");

        const meta = document.createElement("div");
        meta.className = "session-meta";

        const left = document.createElement("span");
        if (status.type === "active") {
          left.innerHTML = "Llevas <strong>" + status.elapsed + "</strong>";
        } else {
          left.innerHTML = "Espera activa";
        }

        const right = document.createElement("span");
        right.innerHTML = "Te queda <strong>" + status.left + "</strong>";

        const track = document.createElement("div");
        track.className = "progress-track";
        const fill = document.createElement("div");
        fill.className = "progress-fill";
        fill.style.width = status.progress.toFixed(1) + "%";
        track.append(fill);

        meta.append(left, right);
        box.append(meta, track);
        item.append(box);
      }

      const schedule = document.createElement("span");
      schedule.className = "item-schedule";
      schedule.textContent = "Permitido: " + site.from + " – " + site.to;
      item.append(schedule);
    }

    listEl.append(item);
  }
}

/* ---------- Configuración ---------- */

async function loadSettingsUI() {
  const settings = await getSettings();
  lockEnabledInput.checked = settings.lockEnabled;
  lockSecondsInput.value = settings.lockSeconds;
  lockSecondsRow.style.opacity = settings.lockEnabled ? "1" : "0.55";
  sessionLimitInput.value = settings.sessionLimitMinutes;
  cooldownEnabledInput.checked = settings.cooldownEnabled;
  cooldownMinutesInput.value = settings.cooldownMinutes;
  cooldownMinutesRow.style.opacity = settings.cooldownEnabled ? "1" : "0.55";
  settingsErrorEl.textContent = "";
}

// Activar el bloqueo es libre; desactivarlo pasa por la espera
lockEnabledInput.addEventListener("change", async () => {
  const settings = await getSettings();

  if (lockEnabledInput.checked) {
    await saveSettings({ ...settings, lockEnabled: true });
  } else {
    lockEnabledInput.checked = true; // sigue activo hasta terminar la espera
    const ok = await requestUnlock("Desactivar el bloqueo por tiempo");
    if (ok) await saveSettings({ ...settings, lockEnabled: false });
  }
  loadSettingsUI();
});

// Subir los segundos es libre; bajarlos pasa por la espera
lockSecondsInput.addEventListener("change", async () => {
  const settings = await getSettings();
  const value = Number(lockSecondsInput.value);

  if (!Number.isInteger(value) || value < MIN_SECONDS || value > MAX_SECONDS) {
    settingsErrorEl.textContent =
      "Elige un número entero entre " + MIN_SECONDS + " y " + MAX_SECONDS + ".";
    lockSecondsInput.value = settings.lockSeconds;
    return;
  }
  settingsErrorEl.textContent = "";
  if (value === settings.lockSeconds) return;

  if (settings.lockEnabled && value < settings.lockSeconds) {
    lockSecondsInput.value = settings.lockSeconds;
    const ok = await requestUnlock("Reducir el tiempo de espera");
    if (!ok) return;
  }

  await saveSettings({ ...settings, lockSeconds: value });
  loadSettingsUI();
});

sessionLimitInput.addEventListener("change", async () => {
  const settings = await getSettings();
  const value = Number(sessionLimitInput.value);

  if (
    !Number.isInteger(value) ||
    value < MIN_SESSION_MINUTES ||
    value > MAX_SESSION_MINUTES
  ) {
    settingsErrorEl.textContent =
      "El límite por sesión debe ser un entero entre " +
      MIN_SESSION_MINUTES +
      " y " +
      MAX_SESSION_MINUTES +
      " minutos.";
    sessionLimitInput.value = settings.sessionLimitMinutes;
    return;
  }

  settingsErrorEl.textContent = "";
  if (value === settings.sessionLimitMinutes) return;
  await saveSettings({ ...settings, sessionLimitMinutes: value });
  loadSettingsUI();
});

cooldownEnabledInput.addEventListener("change", async () => {
  const settings = await getSettings();
  await saveSettings({ ...settings, cooldownEnabled: cooldownEnabledInput.checked });
  loadSettingsUI();
});

cooldownMinutesInput.addEventListener("change", async () => {
  const settings = await getSettings();
  const value = Number(cooldownMinutesInput.value);

  if (
    !Number.isInteger(value) ||
    value < MIN_COOLDOWN_MINUTES ||
    value > MAX_COOLDOWN_MINUTES
  ) {
    settingsErrorEl.textContent =
      "La espera tras límite debe ser un entero entre " +
      MIN_COOLDOWN_MINUTES +
      " y " +
      MAX_COOLDOWN_MINUTES +
      " minutos.";
    cooldownMinutesInput.value = settings.cooldownMinutes;
    return;
  }

  settingsErrorEl.textContent = "";
  if (value === settings.cooldownMinutes) return;
  await saveSettings({ ...settings, cooldownMinutes: value });
  loadSettingsUI();
});

settingsBtn.addEventListener("click", () => {
  viewSites.hidden = true;
  viewSettings.hidden = false;
  loadSettingsUI();
});

backBtn.addEventListener("click", () => {
  viewSettings.hidden = true;
  viewSites.hidden = false;
});

pomodoroBtn.addEventListener("click", async () => {
  const { pomodoro = null } = await chrome.storage.local.get("pomodoro");
  const state = getPomodoroState(pomodoro);

  if (state.active) {
    await chrome.storage.local.remove("pomodoro");
    render();
    return;
  }

  const now = Date.now();
  const durationMs = DEFAULT_POMODORO_MINUTES * 60 * 1000;
  await chrome.storage.local.set({
    pomodoro: {
      startedAt: now,
      durationMinutes: DEFAULT_POMODORO_MINUTES,
      until: now + durationMs
    }
  });
  render();
});

/* ---------- Inicio ---------- */

addBtn.addEventListener("click", addSite);
nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addSite();
});

render();

if (refreshTimer) clearInterval(refreshTimer);
refreshTimer = setInterval(() => {
  if (!viewSites.hidden) render();
}, 1000);