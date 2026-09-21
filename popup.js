const nameInput = document.getElementById("name");
const fromInput = document.getElementById("from");
const toInput = document.getElementById("to");
const addBtn = document.getElementById("add-btn");
const errorEl = document.getElementById("error");
const listEl = document.getElementById("list");
const emptyEl = document.getElementById("empty");

async function getSites() {
  const { sites = [] } = await chrome.storage.local.get("sites");
  return sites;
}

async function saveSites(sites) {
  await chrome.storage.local.set({ sites });
}

function showError(message) {
  errorEl.textContent = message;
}

function validTimes(from, to) {
  if (!from || !to) return "Elige la hora de inicio y la de fin.";
  if (from === to) return "La hora de inicio y la de fin no pueden ser iguales.";
  return "";
}

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

  sites.push({
    id: Date.now().toString(),
    name,
    from,
    to,
    enabled: true
  });

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
  render();
}

function timeField(label, value, onChange) {
  const wrapper = document.createElement("div");
  wrapper.className = "field";

  const labelEl = document.createElement("label");
  labelEl.textContent = label;

  const input = document.createElement("input");
  input.type = "time";
  input.value = value;
  input.addEventListener("change", () => onChange(input.value));

  wrapper.append(labelEl, input);
  return wrapper;
}

async function render() {
  const sites = await getSites();
  listEl.textContent = "";
  emptyEl.hidden = sites.length > 0;

  for (const site of sites) {
    const item = document.createElement("li");
    item.className = "item" + (site.enabled === false ? " disabled" : "");

    // Cabecera: nombre + activar/desactivar + borrar
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
      await updateSite(site.id, { enabled: toggle.checked });
      render();
    });

    const del = document.createElement("button");
    del.type = "button";
    del.className = "delete-btn";
    del.textContent = "✕";
    del.title = "Eliminar";
    del.addEventListener("click", () => deleteSite(site.id));

    actions.append(toggle, del);
    head.append(nameEl, actions);

    // Horario editable
    const times = document.createElement("div");
    times.className = "item-times";

    const saveTimes = async (changes) => {
      const from = changes.from ?? site.from;
      const to = changes.to ?? site.to;
      const timeError = validTimes(from, to);
      if (timeError) {
        showError(timeError);
        render(); // vuelve al valor anterior
        return;
      }
      showError("");
      await updateSite(site.id, changes);
    };

    times.append(
      timeField("Desde", site.from, (value) => saveTimes({ from: value })),
      timeField("Hasta", site.to, (value) => saveTimes({ to: value }))
    );

    item.append(head, times);
    listEl.append(item);
  }
}

addBtn.addEventListener("click", addSite);
nameInput.addEventListener("keydown", (event) => {
  if (event.key === "Enter") addSite();
});

render();