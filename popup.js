const DEFAULT_SETTINGS = { lockEnabled: false, lockSeconds: 15 };
const MIN_SECONDS = 5;
const MAX_SECONDS = 300;

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
const lockEnabledInput = $("lock-enabled");
const lockSecondsInput = $("lock-seconds");
const lockSecondsRow = $("lock-seconds-row");
const settingsErrorEl = $("settings-error");
const overlay = $("overlay");
const overlayTitle = $("overlay-title");
const countEl = $("count");
const cancelBtn = $("overlay-cancel");
const confirmBtn = $("overlay-confirm");

// Sitio que está en modo edición (solo vive mientras el popup está abierto)
let editingId = null;

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
  const sites = await getSites();
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

settingsBtn.addEventListener("click", () => {
  viewSites.hidden = true;
  viewSettings.hidden = false;
  loadSettingsUI();
});

backBtn.addEventListener("click", () => {
  viewSettings.hidden = true;
  viewSites.hidden = false;
});

/* ---------- Inicio ---------- */

addBtn.addEventListener("click", addSite);
nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addSite();
});

render();