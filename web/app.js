"use strict";

const params = new URLSearchParams(location.search);
const supportedLanguages = ["de", "en"];
const defaults = {
  control: false,
  autoSwitch: true,
  showIntegratedDevices: false,
  preselect: null,
  preselectTimeout: 60,
  screenTimeout: 120,
  theme: "dark",
};

function boolParam(name, fallback) {
  const value = params.get(name);
  if (value === null) return fallback;
  if (["1", "true", "yes", "on"].includes(value.toLowerCase())) return true;
  if (["0", "false", "no", "off"].includes(value.toLowerCase())) return false;
  throw new Error(`${name} must be true or false`);
}

function secondsParam(name, fallback) {
  const value = params.get(name);
  if (value === null) return fallback;
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error(`${name} must be a non-negative number of seconds`);
  }
  return Number(value);
}

function numberList(name) {
  const value = params.get(name);
  if (value === null || value.trim() === "") return null;
  const values = value.split(",").map((part) => {
    const number = Number(part.trim());
    if (!/^[1-9]\d*$/.test(part.trim()) || !Number.isSafeInteger(number)) {
      throw new Error(`${name} must contain comma-separated positive evcc loadpoint numbers`);
    }
    return number;
  });
  return [...new Set(values)];
}

function readConfig() {
  const config = {
    ...defaults,
    control: boolParam("control", defaults.control),
    autoSwitch: boolParam("autoSwitch", defaults.autoSwitch),
    showIntegratedDevices: boolParam("showIntegratedDevices", defaults.showIntegratedDevices),
    preselect: params.has("preselect") ? Number(params.get("preselect")) : defaults.preselect,
    preselectTimeout: secondsParam("preselectTimeout", defaults.preselectTimeout),
    screenTimeout: secondsParam("screenTimeout", defaults.screenTimeout),
    theme: params.get("theme") || defaults.theme,
    allowlist: numberList("allowlist"),
    blocklist: numberList("blocklist"),
    language: params.get("lang"),
  };
  if (config.preselect !== null && (!Number.isSafeInteger(config.preselect) || config.preselect < 1)) {
    throw new Error("preselect must be a positive evcc loadpoint number");
  }
  if (!["light", "dark"].includes(config.theme)) throw new Error("theme must be light or dark");
  if (config.allowlist && config.blocklist) throw new Error("mutually-exclusive-lists");
  return config;
}

const display = document.getElementById("display");
const configError = document.getElementById("error");
const ui = {
  title: document.getElementById("loadpoint-title"),
  clock: document.getElementById("clock"),
  battery: document.getElementById("battery"),
  connection: document.getElementById("connection-icon"),
  vehicle: document.getElementById("vehicle"),
  soc: document.getElementById("soc-progress"),
  socValues: document.getElementById("soc-values"),
  socLimit: document.getElementById("soc-limit"),
  socMarker: document.querySelector(".soc-marker"),
  socGroup: document.getElementById("soc-group"),
  socValue: document.getElementById("soc-value"),
  valueDivider: document.getElementById("value-divider"),
  powerLine: document.getElementById("power-line"),
  power: document.getElementById("power"),
  unit: document.getElementById("power-unit"),
  powerIcon: document.getElementById("power-icon"),
  status: document.getElementById("status"),
  flow: document.getElementById("energy-flow"),
  bar: document.getElementById("bar-fill"),
  feedInBar: document.getElementById("bar-feed-in-fill"),
  gridBar: document.getElementById("bar-grid-fill"),
  barLeft: document.getElementById("bar-left"),
  barRight: document.getElementById("bar-right"),
  tiles: document.getElementById("tiles"),
  controls: document.getElementById("controls"),
  navigation: document.getElementById("loadpoint-navigation"),
  previousLoadpoint: document.getElementById("previous-loadpoint"),
  nextLoadpoint: document.getElementById("next-loadpoint"),
  dots: document.getElementById("dots"),
  vehicleSelector: document.getElementById("vehicle-selector"),
  vehicleSelectorBack: document.getElementById("vehicle-selector-back"),
  vehicleCards: document.getElementById("vehicle-cards"),
  vehicleSelectorEmpty: document.getElementById("vehicle-selector-empty"),
  vehicleSelectorNavigation: document.getElementById("vehicle-selector-navigation"),
  previousVehiclePage: document.getElementById("previous-vehicle-page"),
  nextVehiclePage: document.getElementById("next-vehicle-page"),
  vehiclePageDots: document.getElementById("vehicle-page-dots"),
  screenOff: document.getElementById("screen-off"),
};

let config;
let controlRequested = false;
let serverControlDisabled = false;
let translations = {};
let locale = "en";
let points = [];
let vehicles = [];
let current = 0;
let statesReady = false;
let lastSuccess = 0;
let lastUserActivity = Date.now();
let preselectActivity = Date.now();
let previousStates = new Map();
let pendingMode = null;
let screenIsOff = false;
let pointerStart = null;
let lastClock = "";
let vehicleSelectorOpen = false;
let selectorLoadpointNumber = null;
let vehicleSelectorPage = 0;
let pendingVehicle = null;
let suppressVehicleCardClick = false;

const iconPaths = {
  sun: '<circle cx="12" cy="12" r="4"></circle><path d="M12 2v2m0 16v2M4.93 4.93l1.42 1.42m11.3 11.3 1.42 1.42M2 12h2m16 0h2M4.93 19.07l1.42-1.42m11.3-11.3 1.42-1.42"></path>',
  bolt: '<path d="M13 2 4.5 13h6L10 22l9-12h-6z"></path>',
  plug: '<path d="M8 3v5m8-5v5M6 8h12v3a6 6 0 0 1-6 6v4m-3-4a6 6 0 0 1-3-5V8z"></path>',
  car: '<path d="m5 11 1.5-4h11L19 11l2 2v5h-2v-2H5v2H3v-5zM7 11h10M6 14h.01M18 14h.01"></path>',
  alert: '<path d="m12 3 10 18H2z"></path><path d="M12 9v5m0 3h.01"></path>',
  battery: '<rect x="3" y="7" width="17" height="10" rx="2"></rect><path d="M22 10v4M7 10v4m5-4v4"></path>',
};

function icon(name) {
  return `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${iconPaths[name] || ""}</svg>`;
}

function translate(key, values = {}) {
  let text = translations[key] || english[key] || key;
  for (const [name, value] of Object.entries(values)) {
    text = text.replaceAll(`{${name}}`, String(value));
  }
  return text;
}

const english = {
  smart: "Smart", slow: "Slow", fast: "Fast", off: "Off", stopCharging: "stop charging", solarOnly: "solar only",
  loadpointNavigation: "Loadpoint navigation",
  previousLoadpoint: "Previous loadpoint", nextLoadpoint: "Next loadpoint",
  alwaysCharge: "always charging", fullPower: "full power", noVehicle: "No vehicle",
  charging: "Charging", notFound: "Not found", connecting: "Connecting …",
  noData: "No data", noWifi: "No Wi-Fi", chargingPointOff: "Charging point is off – choose a mode",
  modePending: "Setting mode …", waitSolar: "Waiting for solar surplus", waitCheap: "Waiting for a cheaper time",
  connectedIdle: "Connected · not charging", chooseMode: "Choose a mode for the next charge",
  solarSurplus: "Solar surplus", enoughSolar: "Enough surplus for Smart",
  smartThreshold: "Smart starts at {value} kW surplus", startIn: "Enough solar – starts in {time}",
  stopIn: " · stops in {time}", phased: " · {count}-phase", unreachable: "evcc unreachable",
  lastUpdate: "evcc unreachable · last update {time}", notConfigured: "This number does not exist in evcc",
  now: "Now {value}% solar", gridPercent: "{value}% grid", batteryFull: "Battery full",
  batteryPaused: "Battery paused", batteryCharging: "Battery charging",
  batteryDischarging: "Battery discharging", gridImport: "Grid import", feedIn: "Feed-in",
  solar: "Solar", home: "Home", battery: "Battery", charged: "CHARGED", duration: "DURATION",
  averageSolar: "AVG. SOLAR", sessionSolar: "{value}%", configurationError: "Invalid display configuration: {reason}",
  mutuallyExclusive: "allowlist and blocklist cannot be used together.",
  invalidPreselect: "The preselected charging point is not in the displayed list.",
  evccUnavailable: "evcc is unavailable.", unknownLoadpoint: "No charging points found.",
  controlDisabled: "Charging controls are disabled by the server.",
  back: "Back", selectVehicle: "Select a vehicle", noVehiclesAvailable: "No vehicles configured",
};

const evccVehicleIconPaths = {
  bike: "M5 20q-2.125 0-3.562-1.438Q0 17.125 0 15t1.463-3.562Q2.925 10 5 10q1.925 0 3.238 1.15Q9.55 12.3 9.9 14h.65l-1.8-5H8q-.425 0-.713-.288Q7 8.425 7 8t.287-.713Q7.575 7 8 7h3q.425 0 .713.287Q12 7.575 12 8t-.287.712Q11.425 9 11 9h-.1l.35 1h4.8L14.6 6H13q-.425 0-.712-.287Q12 5.425 12 5t.288-.713Q12.575 4 13 4h1.6q.65 0 1.163.35q.512.35.737.95l1.7 4.65h.8q2.075 0 3.538 1.462Q24 12.875 24 14.95q0 2.1-1.45 3.575Q21.1 20 19 20q-1.8 0-3.162-1.125Q14.475 17.75 14.1 16H9.9q-.35 1.725-1.7 2.863Q6.85 20 5 20Zm0-2q1.025 0 1.763-.562Q7.5 16.875 7.8 16H6q-.425 0-.713-.288Q5 15.425 5 15t.287-.713Q5.575 14 6 14h1.8q-.3-.9-1.037-1.45Q6.025 12 5 12q-1.275 0-2.138.863Q2 13.725 2 15q0 1.25.862 2.125Q3.725 18 5 18Zm7.7-4h1.4q.125-.575.338-1.075q.212-.5.562-.925h-3.05Zm6.3 4q1.275 0 2.138-.875Q22 16.25 22 15q0-1.275-.862-2.137Q20.275 12 19 12h-.1l.65 1.7q.15.4-.037.762q-.188.363-.563.538q-.4.175-.775-.013q-.375-.187-.525-.587l-.6-1.7q-.5.425-.775 1T16 15q0 1.25.863 2.125Q17.725 18 19 18Z",
  bus: "M6.5 21q-.625 0-1.062-.438Q5 20.125 5 19.5v-1.55q-.45-.5-.725-1.113Q4 16.225 4 15.5V6q0-2.075 1.925-3.038Q7.85 2 12 2q4.3 0 6.15.925Q20 3.85 20 6v9.5q0 .725-.275 1.337q-.275.613-.725 1.113v1.55q0 .625-.438 1.062Q18.125 21 17.5 21t-1.062-.438Q16 20.125 16 19.5V19H8v.5q0 .625-.438 1.062Q7.125 21 6.5 21ZM6 10h12V7H6Zm2.5 6q.625 0 1.062-.438Q10 15.125 10 14.5t-.438-1.062Q9.125 13 8.5 13t-1.062.438Q7 13.875 7 14.5t.438 1.062Q7.875 16 8.5 16Zm7 0q.625 0 1.062-.438Q17 15.125 17 14.5t-.438-1.062Q16.125 13 15.5 13t-1.062.438Q14 13.875 14 14.5t.438 1.062Q14.875 16 15.5 16ZM8 17h8q.825 0 1.413-.587Q18 15.825 18 15v-3H6v3q0 .825.588 1.413Q7.175 17 8 17Z",
  van: "M6 20q-1.25 0-2.125-.875T3 17q-.825 0-1.412-.587Q1 15.825 1 15V6q0-.825.588-1.412Q2.175 4 3 4h12q.825 0 1.413.588Q17 5.175 17 6v2h2.5q.25 0 .45.1t.35.3l2.5 3.325q.1.125.15.275q.05.15.05.325V16q0 .425-.288.712Q22.425 17 22 17h-1q0 1.25-.875 2.125T18 20q-1.25 0-2.125-.875T15 17H9q0 1.25-.875 2.125T6 20ZM3 6v9h.8q.425-.45.975-.725Q5.325 14 6 14t1.225.275q.55.275.975.725H15V6H3Zm14 7h4.25L19 10h-2Z",
  taxi: "M6 19v.5q0 .625-.437 1.063T4.5 21t-1.062-.437T3 19.5v-7.15q0-.175.025-.35t.075-.325L4.975 6.35q.2-.6.725-.975T6.875 5H9V4q0-.425.288-.712T10 3h4q.425 0 .713.288T15 4v1h2.125q.65 0 1.175.375t.725.975l1.875 5.325q.05.15.075.325t.025.35v7.15q0 .625-.437 1.063T19.5 21t-1.062-.437T18 19.5V19zm-.2-9h12.4l-1.05-3H6.85zM5 17h14v-5H5z",
  motorcycle: "M5 19q-2.075 0-3.537-1.462Q0 16.075 0 14q0-2.075 1.463-3.538Q2.925 9 5 9h11.6l-2-2H12q-.425 0-.712-.287Q11 6.425 11 6t.288-.713Q11.575 5 12 5h2.975q.2 0 .388.075q.187.075.337.225l3.75 3.75q1.95.15 3.25 1.575T24 14q0 2.075-1.462 3.538Q21.075 19 19 19q-2.075 0-3.537-1.462Q14 16.075 14 14q0-.45.062-.888q.063-.437.238-.862l-2.175 2.175q-.275.275-.637.425q-.363.15-.763.15H9.9q-.35 1.75-1.725 2.875T5 19Zm14-2q1.25 0 2.125-.875T22 14q0-1.25-.875-2.125T19 11q-1.25 0-2.125.875T16 14q0 1.25.875 2.125T19 17ZM5 17q.95 0 1.713-.55Q7.475 15.9 7.8 15H6q-.425 0-.713-.288Q5 14.425 5 14t.287-.713Q5.575 13 6 13h1.8q-.325-.9-1.087-1.45Q5.95 11 5 11q-1.25 0-2.125.875T2 14q0 1.25.875 2.125T5 17Zm4.95-4h.75l2-2H8.95q.375.425.625.925T9.95 13Z",
  shuttle: "M6 19q-1.25 0-2.125-.875T3 16q-.825 0-1.412-.587T1 14V7q0-.825.588-1.412T3 5h13.175q.4 0 .763.15t.637.425l4.85 4.85q.275.275.425.638t.15.762V14q0 .825-.587 1.413T21 16q0 1.25-.875 2.125T18 19t-2.125-.875T15 16H9q0 1.25-.875 2.125T6 19m9-9h4l-3-3h-1zm-6 0h4V7H9zm-6 0h4V7H3zm3 7.25q.525 0 .888-.363T7.25 16t-.363-.888T6 14.75t-.888.363T4.75 16t.363.888t.887.362m12 0q.525 0 .888-.363T19.25 16t-.363-.888T18 14.75t-.888.363t-.362.887t.363.888t.887.362M8.2 14h7.6q.425-.45.975-.725T18 13t1.225.275t.975.725h.8v-2H3v2h.8q.425-.45.975-.725T6 13t1.225.275T8.2 14Z",
};

function formatNumber(value, digits = 1) {
  return new Intl.NumberFormat(locale, { minimumFractionDigits: digits, maximumFractionDigits: digits }).format(value);
}

function formatPower(watts) {
  return `${formatNumber(watts / 1000)} kW`;
}

function formatDuration(seconds) {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, "0")} h`;
}

function hasNumber(value) {
  return value !== null && value !== undefined && value !== "" && Number.isFinite(Number(value));
}

function formatCountdown(seconds) {
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

function showError(message) {
  configError.textContent = message;
  configError.hidden = !message;
}

function updateClock() {
  const now = new Date();
  const clock = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(now);
  if (clock !== lastClock) {
    ui.clock.textContent = clock;
    lastClock = clock;
  }
}

function configuredPoints(allPoints) {
  let selected = config.showIntegratedDevices
    ? allPoints
    : allPoints.filter((lp) => !lp.chargerFeatureIntegratedDevice);
  if (config.allowlist) selected = selected.filter((lp) => config.allowlist.includes(lp.number));
  if (config.blocklist) selected = selected.filter((lp) => !config.blocklist.includes(lp.number));
  return selected;
}

function updateNavigation() {
  ui.dots.replaceChildren(...points.map((_, index) => {
    const dot = document.createElement("span");
    dot.className = `dot${index === current ? " active" : ""}`;
    return dot;
  }));
  const multiple = points.length > 1;
  document.querySelector(".control-row").classList.toggle("has-multiple-loadpoints", multiple);
  ui.navigation.hidden = !multiple;
  ui.previousLoadpoint.hidden = !multiple;
  ui.nextLoadpoint.hidden = !multiple;
  ui.previousLoadpoint.disabled = current === 0;
  ui.nextLoadpoint.disabled = current === points.length - 1;
}

function setCurrent(index, source = "manual") {
  if (index < 0 || index >= points.length || index === current) return;
  current = index;
  if (source === "manual") {
    lastUserActivity = Date.now();
    preselectActivity = lastUserActivity;
  }
  updateNavigation();
  render();
}

function moveBy(delta, source = "manual") {
  setCurrent(current + delta, source);
}

function currentPoint() {
  return points[current];
}

function minChargePower(lp) {
  const configuredPhases = Number(lp.phasesConfigured) || 0;
  const phases = configuredPhases === 1 || configuredPhases === 3
    ? configuredPhases
    : lp.chargerPhases1p3p ? 1 : 3;
  return (Number(lp.minCurrent) || 0) * 230 * phases;
}

function solarSurplus(state) {
  const battery = hasNumber(state.bat) && Number(state.bat) >= 0 ? (Number(state.batp) || 0) : 0;
  const hasGrid = hasNumber(state.grid);
  const watts = hasGrid
    ? -(Number(state.grid) + battery)
    : (Number(state.pv) || 0) - (Number(state.home) || 0);
  return Math.max(0, watts);
}

function isHouseView(lp) {
  return lp && !lp.connected && hasNumber(lp.root.pv) && Number(lp.root.pv) >= 0;
}

function setTiles(items) {
  const tileEls = [...ui.tiles.children];
  ui.tiles.hidden = !items;
  const visibleCount = items?.filter((item) => !item.hidden).length || 0;
  ui.tiles.classList.toggle("has-two-tiles", visibleCount === 2);
  ui.tiles.classList.toggle("has-one-tile", visibleCount === 1);
  tileEls.forEach((tile, index) => {
    const item = items?.[index];
    tile.hidden = !item || item.hidden === true;
    document.getElementById(`tile-label-${index}`).textContent = item?.label || "";
    document.getElementById(`tile-value-${index}`).textContent = item?.value || "";
  });
}

function renderHouse(lp, live) {
  const state = lp.root;
  const batteryAvailable = hasNumber(state.bat) && Number(state.bat) >= 0;
  const surplus = solarSurplus(state);
  const threshold = minChargePower(lp);
  ui.vehicle.innerHTML = `${icon("plug")}<span>${translate("noVehicle")}</span>`;
  ui.vehicle.hidden = false;
  ui.power.textContent = formatNumber(surplus / 1000);
  ui.power.className = `power${live && surplus >= Math.max(threshold, 1) ? "" : " muted"}`;
  ui.unit.hidden = false;
  ui.powerIcon.innerHTML = icon("sun");
  ui.powerIcon.className = "power-icon sun";
  ui.powerIcon.hidden = false;
  if (!live) {
    const updated = lastSuccess
      ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(lastSuccess))
      : "";
    setStatus(lastSuccess ? "lastUpdate" : "connecting", "error", { time: updated });
  } else if (threshold > 0 && surplus >= threshold) setStatus("enoughSolar", "good");
  else if (threshold > 0) setStatus("smartThreshold", "", { value: formatNumber(threshold / 1000) });
  else setStatus("solarSurplus");

  const flow = hasNumber(state.pv) && hasNumber(state.grid);
  ui.flow.hidden = !flow;
  if (flow) {
    const pvPower = Math.max(0, Number(state.pv));
    const gridPower = Number(state.grid);
    const batteryPower = hasNumber(state.batp) ? Number(state.batp) : 0;
    const batteryCharging = Math.max(0, -batteryPower);
    const batteryDischarging = Math.max(0, batteryPower);
    const feedIn = Math.max(0, -gridPower);
    const gridImport = Math.max(0, gridPower);
    const solarUsed = Math.max(0, pvPower + batteryDischarging - batteryCharging - feedIn);
    const total = solarUsed + feedIn + gridImport;
    const percent = (value) => total > 0 ? `${(value / total) * 100}%` : "0%";
    ui.bar.style.width = percent(solarUsed);
    ui.feedInBar.style.width = percent(feedIn);
    ui.gridBar.style.width = percent(gridImport);
    ui.barLeft.textContent = translate("solarUsed", { value: formatPower(solarUsed) });
    ui.barRight.textContent = `${translate(gridPower > 0 ? "gridImport" : "feedIn")} ${formatPower(gridPower > 0 ? gridImport : feedIn)}`;
  }
  setTiles([
    { label: translate("solar"), value: formatPower(Number(state.pv) || 0) },
    { label: translate("home"), value: formatPower(Number(state.home) || 0) },
    { label: translate("battery"), value: batteryAvailable ? `${Math.round(Number(state.bat))} %` : "", hidden: !batteryAvailable },
  ]);
}

function renderLoadpoint(lp) {
  const state = lp.root;
  const live = Date.now() - lastSuccess < 15000;
  const house = isHouseView(lp);
  const showPower = lp.connected;
  const mode = modeFor(lp);
  const selectedVehicle = vehicles.find((vehicle) => vehicle.name === lp.vehicleName);
  ui.flow.classList.remove("feed-in");
  ui.title.textContent = lp.title || `Loadpoint ${lp.number}`;
  ui.connection.innerHTML = live ? "" : icon("alert");
  ui.battery.innerHTML = hasNumber(state.bat) && Number(state.bat) >= 0 && !house
    ? `${icon("battery")} ${Math.round(Number(state.bat))} %`
    : "";
  ui.battery.hidden = !ui.battery.textContent;
  renderSocProgress(lp, showPower && !house);

  if (house) {
    renderHouse(lp, live);
  } else {
    ui.vehicle.hidden = !showPower;
    if (showPower) {
      const vehicle = lp.vehicleTitle || translate("vehicle");
      ui.vehicle.innerHTML = `${vehicleIcon(selectedVehicle?.icon)}<span>${escapeHTML(vehicle)}</span>`;
      ui.power.textContent = formatNumber((Number(lp.chargePower) || 0) / 1000);
      ui.power.className = `power${live && lp.charging ? "" : " muted"}`;
      ui.unit.hidden = false;
      ui.powerIcon.innerHTML = icon("bolt");
      ui.powerIcon.className = "power-icon";
      ui.powerIcon.hidden = !live || !lp.charging;
      ui.flow.hidden = !(lp.charging && lp.green !== null && lp.green !== undefined
        && Number.isFinite(Number(lp.green)));
      if (!ui.flow.hidden) {
        const solar = Math.min(100, Math.max(0, Math.round(Number(lp.green) * 100)));
        ui.bar.style.width = `${solar}%`;
        ui.feedInBar.style.width = "0";
        ui.gridBar.style.width = "0";
        ui.barLeft.textContent = translate("now", { value: solar });
        ui.barRight.textContent = translate("gridPercent", { value: 100 - solar });
      }
      setTiles(lp.charging || Number(lp.chargedEnergy) > 0 ? [
        { label: translate("charged"), value: `${formatNumber((Number(lp.chargedEnergy) || 0) / 1000)} kWh` },
        { label: translate("duration"), value: formatDuration(Number(lp.chargeDuration) || 0) },
        { label: translate("averageSolar"), value: translate("sessionSolar", { value: Math.round(Number(lp.sessionSolarPercentage) || 0) }) },
      ] : null);
    } else {
      ui.vehicle.innerHTML = `${icon("plug")}<span>${translate("noVehicle")}</span>`;
      ui.vehicle.hidden = false;
      ui.power.textContent = "";
      ui.unit.hidden = true;
      ui.powerIcon.hidden = true;
      ui.flow.hidden = true;
      setTiles(null);
    }
    renderStatus(lp, live, mode);
  }
  if (live && lp.mode === "off") setStatus("chargingPointOff", "warn");

  ui.controls.querySelectorAll("button").forEach((button) => {
    button.setAttribute("aria-pressed", String(button.dataset.mode === (pendingMode || mode)));
    button.disabled = !config.control || !live;
  });
  ui.vehicle.disabled = !config.control || !live;
  ui.vehicle.classList.toggle("selectable", config.control);
}

function renderSocProgress(lp, showPower) {
  const soc = Number(lp.vehicleSoc);
  const effectiveLimit = hasNumber(lp.effectiveLimitSoc) ? Number(lp.effectiveLimitSoc) : null;
  const vehicleLimit = hasNumber(lp.vehicleLimitSoc) ? Number(lp.vehicleLimitSoc) : null;
  const validLimit = (value) => value !== null && value > 0 && value <= 100;
  const useVehicleLimit = validLimit(vehicleLimit)
    && (!validLimit(effectiveLimit) || vehicleLimit <= effectiveLimit);
  const limit = useVehicleLimit ? vehicleLimit : validLimit(effectiveLimit) ? effectiveLimit : null;
  const available = showPower && hasNumber(lp.vehicleSoc) && soc >= 0 && soc <= 100;
  ui.soc.hidden = !available;
  ui.socGroup.hidden = !available;
  ui.valueDivider.hidden = !available;
  ui.socValue.hidden = !available;
  ui.powerLine.classList.toggle("has-soc", available);
  if (!available) return;

  const currentPercent = Math.min(100, Math.max(0, soc));
  ui.soc.style.setProperty("--soc-progress", `${currentPercent}%`);
  ui.socValue.textContent = String(Math.round(currentPercent));
  ui.socValue.hidden = false;
  ui.socLimit.hidden = limit === null;
  ui.socMarker.hidden = limit === null;
  ui.socValues.hidden = false;
  if (limit !== null) {
    const limitPercent = Math.min(100, Math.max(0, limit));
    ui.soc.style.setProperty("--soc-limit", `${limitPercent}%`);
    ui.socLimit.textContent = translate(useVehicleLimit ? "vehicleSocLimit" : "socLimit", {
      value: Math.round(limitPercent),
    });
  }
  ui.soc.setAttribute("aria-label", limit === null ? "" : ui.socLimit.textContent);
}

function renderStatus(lp, live, mode) {
  if (!live) {
    const updated = lastSuccess
      ? new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" }).format(new Date(lastSuccess))
      : "";
    setStatus(lastSuccess ? "lastUpdate" : "connecting", "error", { time: updated });
    return;
  }
  if (pendingMode) return setStatus("modePending");
  if (!lp.connected) {
    if (hasNumber(lp.root.pv) && Number(lp.root.pv) >= 0) {
      const surplus = solarSurplus(lp.root);
      const threshold = minChargePower(lp);
      if (threshold > 0 && surplus >= threshold) return setStatus("enoughSolar", "good");
      if (threshold > 0) {
        return setStatus("smartThreshold", "", { value: formatNumber(threshold / 1000) });
      }
      return setStatus("solarSurplus");
    }
    return setStatus("chooseMode");
  }
  if (lp.charging) {
    let text = translate("charging");
    if (Number(lp.phasesActive) > 0) text += translate("phased", { count: Number(lp.phasesActive) });
    if (lp.pvAction === "disable" && Number(lp.pvRemaining) > 0) {
      text += translate("stopIn", { time: formatCountdown(Number(lp.pvRemaining)) });
      ui.status.textContent = text;
      ui.status.className = "status warn";
      return;
    }
    ui.status.textContent = text;
    ui.status.className = "status";
    return;
  }
  if (lp.pvAction === "enable" && Number(lp.pvRemaining) > 0) {
    return setStatus("startIn", "good", { time: formatCountdown(Number(lp.pvRemaining)) });
  }
  if (mode === "smart") return setStatus("waitSolar");
  if (lp.planActive || lp.smartCostActive) return setStatus("waitCheap");
  setStatus("connectedIdle");
}

function setStatus(key, style = "", values = {}) {
  ui.status.textContent = translate(key, values);
  ui.status.className = `status ${style}`.trim();
}

function modeFor(lp) {
  if (lp.mode === "off") return "off";
  if (lp.mode === "now") return "fast";
  if (lp.mode === "minpv") return "slow";
  if (lp.mode === "pv") return "smart";
  if (lp.mode === "smart") return ["on", "once"].includes(lp.alwaysCharge) ? "slow" : "smart";
  return "";
}

function escapeHTML(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
  })[char]);
}

function vehicleIcon(name) {
  const path = Object.prototype.hasOwnProperty.call(evccVehicleIconPaths, name)
    ? evccVehicleIconPaths[name]
    : null;
  if (!path) return icon("car");
  return `<svg class="vehicle-icon" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="${path}"></path></svg>`;
}

function openVehicleSelector() {
  if (!config.control || serverControlDisabled || !currentPoint()) return;
  vehicleSelectorOpen = true;
  selectorLoadpointNumber = currentPoint().number;
  vehicleSelectorPage = 0;
  lastUserActivity = Date.now();
  preselectActivity = lastUserActivity;
  renderVehicleSelector();
  ui.vehicleSelector.hidden = false;
}

function closeVehicleSelector() {
  if (!vehicleSelectorOpen) return;
  const targetIndex = points.findIndex((lp) => lp.number === selectorLoadpointNumber);
  if (targetIndex >= 0) current = targetIndex;
  vehicleSelectorOpen = false;
  selectorLoadpointNumber = null;
  vehicleSelectorPage = 0;
  pendingVehicle = null;
  ui.vehicleSelector.hidden = true;
  render();
}

function renderVehicleSelector() {
  const lp = points.find((point) => point.number === selectorLoadpointNumber);
  if (!lp) return;
  const pageCount = Math.ceil(vehicles.length / 6);
  vehicleSelectorPage = Math.min(vehicleSelectorPage, Math.max(pageCount - 1, 0));
  const availableVehicles = vehicles.slice(vehicleSelectorPage * 6, vehicleSelectorPage * 6 + 6);
  ui.vehicleCards.replaceChildren(...availableVehicles.map((vehicle) => {
    const card = document.createElement("button");
    card.type = "button";
    card.className = "vehicle-card";
    card.setAttribute("aria-pressed", String(vehicle.name === lp.vehicleName));
    card.disabled = pendingVehicle !== null;
    card.dataset.vehicleName = vehicle.name;
    card.innerHTML = vehicleIcon(vehicle.icon);
    const title = document.createElement("span");
    title.textContent = vehicle.title || vehicle.name;
    card.append(title);
    card.addEventListener("click", () => {
      if (!suppressVehicleCardClick) selectVehicle(vehicle.name);
    });
    return card;
  }));
  ui.vehicleSelectorEmpty.hidden = availableVehicles.length > 0;
  ui.vehicleSelectorNavigation.hidden = pageCount < 2;
  ui.previousVehiclePage.disabled = vehicleSelectorPage === 0;
  ui.nextVehiclePage.disabled = vehicleSelectorPage >= pageCount - 1;
  ui.vehiclePageDots.replaceChildren(...Array.from({ length: pageCount }, (_, index) => {
    const dot = document.createElement("span");
    dot.className = `dot${index === vehicleSelectorPage ? " active" : ""}`;
    return dot;
  }));
}

function moveVehiclePage(delta) {
  const pageCount = Math.ceil(vehicles.length / 6);
  const nextPage = vehicleSelectorPage + delta;
  if (!vehicleSelectorOpen || nextPage < 0 || nextPage >= pageCount) return;
  vehicleSelectorPage = nextPage;
  lastUserActivity = Date.now();
  preselectActivity = lastUserActivity;
  renderVehicleSelector();
}

async function selectVehicle(name) {
  if (!config.control || serverControlDisabled || !selectorLoadpointNumber || pendingVehicle !== null) return;
  const loadpointNumber = selectorLoadpointNumber;
  pendingVehicle = name;
  renderVehicleSelector();
  try {
    await requestPost(`/api/loadpoints/${loadpointNumber}/vehicle/${encodeURIComponent(name)}`);
    closeVehicleSelector();
    await poll();
  } catch (error) {
    console.error("Could not select evcc vehicle:", error);
    showError(error.message);
    pendingVehicle = null;
    renderVehicleSelector();
  }
}

function render() {
  const lp = currentPoint();
  if (!lp) return;
  renderLoadpoint(lp);
  updateNavigation();
  if (controlRequested && serverControlDisabled) setStatus("controlDisabled", "warn");
}

function renderUnavailable() {
  updateNavigation();
  ui.title.textContent = "evcc";
  ui.connection.innerHTML = icon("alert");
  ui.vehicle.hidden = true;
  ui.vehicle.disabled = true;
  ui.power.textContent = "—";
  ui.power.className = "power muted";
  ui.unit.hidden = true;
  ui.powerIcon.hidden = true;
  ui.flow.hidden = true;
  setTiles(null);
  setStatus("evccUnavailable", "error");
  ui.controls.querySelectorAll("button").forEach((button) => { button.disabled = true; });
  if (controlRequested && serverControlDisabled) setStatus("controlDisabled", "warn");
}

function loadpointFilter() {
  return `{lps:[.loadpoints|to_entries[] | {number:(.key+1),title:.value.title,mode:.value.mode,alwaysCharge:.value.alwaysCharge,chargePower:.value.chargePower,charging:.value.charging,connected:.value.connected,chargedEnergy:.value.chargedEnergy,chargeDuration:.value.chargeDuration,phasesActive:.value.phasesActive,sessionSolarPercentage:.value.sessionSolarPercentage,vehicleName:.value.vehicleName,vehicleTitle:.value.vehicleTitle,vehicleSoc:.value.vehicleSoc,effectiveLimitSoc:.value.effectiveLimitSoc,vehicleLimitSoc:.value.vehicleLimitSoc,chargerFeatureIntegratedDevice:.value.chargerFeatureIntegratedDevice,pvAction:.value.pvAction,pvRemaining:.value.pvRemaining,planActive:.value.planActive,smartCostActive:.value.smartCostActive,minCurrent:(.value.effectiveMinCurrent // .value.minCurrent),phasesConfigured:.value.phasesConfigured,chargerPhases1p3p:.value.chargerPhases1p3p}],vehicles:[(.vehicles // {})|to_entries[]|{name:.key,title:.value.title,icon:.value.icon}],green:.greenShareLoadpoints,pv:.pvPower,home:.homePower,bat:((try (if (.battery.devices|length)>0 then .battery.soc else null end) catch null)//.batterySoc),batp:((try (if (.battery.devices|length)>0 then .battery.power else null end) catch null)//.batteryPower),grid:((try .grid.power catch null)//.gridPower)}`;
}

async function poll() {
  const url = new URL("/api/state", location.origin);
  url.searchParams.set("jq", loadpointFilter());
  try {
    const response = await fetch(url, { cache: "no-store" });
    if (!response.ok) throw new Error(`evcc returned HTTP ${response.status}`);
    const data = await response.json();
    const root = data.result && typeof data.result === "object" ? data.result : data;
    if (!Array.isArray(root.lps)) throw new Error("evcc state response has no loadpoints");
    vehicles = Array.isArray(root.vehicles) ? root.vehicles : [];
    const allPoints = root.lps.map((item, index) => {
      const lp = item || {};
      const green = Array.isArray(root.green) ? root.green[index] : root.green;
      return { ...lp, number: Number(lp.number) || index + 1, root: { ...root, green }, green };
    });
    points = configuredPoints(allPoints);
    if (points.length === 0) throw new Error(translate("unknownLoadpoint"));
    if (config.preselect !== null) {
      const preselected = points.findIndex((lp) => lp.number === config.preselect);
      if (preselected < 0) throw new Error(translate("invalidPreselect"));
    }

    const now = Date.now();
    let jumpTo = -1;
    for (let index = 0; index < points.length; index += 1) {
      const lp = points[index];
      const previous = previousStates.get(lp.number);
      const connected = Boolean(lp.connected);
      const charging = Boolean(lp.charging);
      if (previous === undefined) {
        if (connected || charging) jumpTo = index;
      } else if ((!previous.connected && connected) || previous.charging !== charging) {
        if (jumpTo < 0 || (charging && !points[jumpTo].charging)) jumpTo = index;
      }
      previousStates.set(lp.number, { connected, charging });
    }
    if (!statesReady) {
      const initialPreselect = config.preselect === null ? -1 : points.findIndex((lp) => lp.number === config.preselect);
      current = initialPreselect >= 0 ? initialPreselect : current;
      statesReady = true;
      if (config.preselect !== null && current === initialPreselect) lastUserActivity = now;
      if (config.preselect === null && jumpTo >= 0 && config.autoSwitch) current = jumpTo;
    } else if (config.autoSwitch && jumpTo >= 0 && now - lastUserActivity >= 60000) {
      if (!vehicleSelectorOpen) {
        current = jumpTo;
        lastUserActivity = now;
      }
    }
    if (vehicleSelectorOpen) {
      const selectorIndex = points.findIndex((lp) => lp.number === selectorLoadpointNumber);
      if (selectorIndex >= 0) current = selectorIndex;
    }
    lastSuccess = now;
    showError("");
    render();
    if (vehicleSelectorOpen) renderVehicleSelector();
  } catch (error) {
    console.error("Could not load evcc state:", error);
    if (error.message === translate("invalidPreselect") || error.message === translate("unknownLoadpoint")) {
      showError(translate("configurationError", { reason: error.message }));
    }
    if (points.length) render();
    else renderUnavailable();
  }
}

async function postMode(mode) {
  if (!config.control) return;
  const lp = currentPoint();
  if (!lp) return;
  lastUserActivity = Date.now();
  preselectActivity = lastUserActivity;
  pendingMode = mode;
  render();
  const base = `/api/loadpoints/${lp.number}`;
  try {
    if (mode === "off") {
      await requestPost(`${base}/mode/off`);
    } else if (mode === "fast") {
      await requestPost(`${base}/mode/now`);
    } else {
      const always = mode === "slow";
      try {
        await requestPost(`${base}/alwayscharge/${always ? "on" : "off"}`);
        await requestPost(`${base}/mode/smart`);
      } catch {
        await requestPost(`${base}/mode/${always ? "minpv" : "pv"}`);
      }
    }
    await poll();
  } catch (error) {
    console.error("Could not change evcc charging mode:", error);
    showError(error.message);
  } finally {
    pendingMode = null;
    render();
  }
}

async function requestPost(path) {
  const response = await fetch(path, { method: "POST" });
  if (!response.ok) throw new Error(`evcc returned HTTP ${response.status}`);
}

function handlePointerDown(event) {
  lastUserActivity = Date.now();
  preselectActivity = lastUserActivity;
  if (screenIsOff) {
    screenIsOff = false;
    ui.screenOff.hidden = true;
    event.preventDefault();
    pointerStart = null;
    return;
  }
  if (vehicleSelectorOpen) {
    pointerStart = { x: event.clientX, y: event.clientY, vehicleSelector: true };
    return;
  }
  if (event.target.closest("button")) {
    pointerStart = null;
    return;
  }
  pointerStart = { x: event.clientX, y: event.clientY };
}

function handlePointerUp(event) {
  if (!pointerStart) {
    return;
  }
  const dx = event.clientX - pointerStart.x;
  const dy = event.clientY - pointerStart.y;
  const vehicleSelectorGesture = pointerStart.vehicleSelector;
  pointerStart = null;
  if (vehicleSelectorGesture) {
    if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) {
      suppressVehicleCardClick = true;
      moveVehiclePage(dx < 0 ? 1 : -1);
      event.preventDefault();
      window.setTimeout(() => { suppressVehicleCardClick = false; }, 0);
    }
    return;
  }
  if (points.length < 2) {
    return;
  }
  if (Math.abs(dx) >= 45 && Math.abs(dx) > Math.abs(dy)) {
    moveBy(dx < 0 ? 1 : -1);
  }
}

function runTimeouts() {
  const now = Date.now();
  if (config.preselect !== null && config.preselectTimeout > 0 && points.length) {
    const preselected = points.findIndex((lp) => lp.number === config.preselect);
    if (!vehicleSelectorOpen && preselected >= 0 && current !== preselected && now - preselectActivity >= config.preselectTimeout * 1000) {
      setCurrent(preselected, "timeout");
      lastUserActivity = now;
    }
  }

  if (!config.screenTimeout || !points.length) return;
  if (config.preselect !== null) {
    const preselected = points.find((lp) => lp.number === config.preselect);
    if (currentPoint()?.number !== config.preselect) {
      lastUserActivity = now;
      if (screenIsOff) {
        screenIsOff = false;
        ui.screenOff.hidden = true;
      }
      return;
    }
    if (preselected?.charging) lastUserActivity = now;
  } else {
    if (points.some((lp) => lp.charging)) lastUserActivity = now;
  }
  const shouldTurnOff = now - lastUserActivity >= config.screenTimeout * 1000;
  if (shouldTurnOff !== screenIsOff) {
    screenIsOff = shouldTurnOff;
    ui.screenOff.hidden = !screenIsOff;
  }
}

function chooseLanguage(requested) {
  if (requested) {
    const base = requested.toLowerCase().split("-")[0];
    return supportedLanguages.includes(base) ? base : "en";
  }
  for (const candidate of navigator.languages || [navigator.language]) {
    const base = candidate.toLowerCase().split("-")[0];
    if (supportedLanguages.includes(base)) return base;
  }
  return "en";
}

async function start() {
  try {
    locale = chooseLanguage(params.get("lang"));
    document.documentElement.lang = locale;
    const response = await fetch(`/i18n/${locale}.json`);
    if (!response.ok) throw new Error(`Could not load ${locale} translations: HTTP ${response.status}`);
    translations = await response.json();
    document.querySelectorAll("[data-i18n]").forEach((element) => {
      element.textContent = translate(element.dataset.i18n);
    });
    ui.previousLoadpoint.setAttribute("aria-label", translate("previousLoadpoint"));
    ui.nextLoadpoint.setAttribute("aria-label", translate("nextLoadpoint"));
    ui.navigation.setAttribute("aria-label", translate("loadpointNavigation"));
    ui.vehicleSelectorBack.setAttribute("aria-label", translate("back"));
    ui.previousVehiclePage.setAttribute("aria-label", translate("previousVehiclePage"));
    ui.nextVehiclePage.setAttribute("aria-label", translate("nextVehiclePage"));
    ui.vehicleSelectorNavigation.setAttribute("aria-label", translate("vehiclePageNavigation"));
    const serverConfigResponse = await fetch("/api/config", { cache: "no-store" });
    if (!serverConfigResponse.ok) throw new Error(`Could not load server configuration: HTTP ${serverConfigResponse.status}`);
    const serverConfig = await serverConfigResponse.json();
    if (typeof serverConfig.controlDisabled !== "boolean") {
      throw new Error("Server configuration response is invalid");
    }
    serverControlDisabled = serverConfig.controlDisabled;
    config = readConfig();
    controlRequested = config.control;
    if (serverControlDisabled) config.control = false;
    document.documentElement.dataset.theme = config.theme;
    updateClock();
    await poll();
    window.setInterval(poll, 3000);
    window.setInterval(() => {
      updateClock();
      runTimeouts();
    }, 1000);
  } catch (error) {
    console.error("Display configuration error:", error);
    const reason = error.message === "mutually-exclusive-lists" ? translate("mutuallyExclusive") : error.message;
    showError(translate("configurationError", { reason }));
  }
}

display.addEventListener("pointerdown", handlePointerDown);
display.addEventListener("pointerup", handlePointerUp);
display.addEventListener("pointercancel", () => { pointerStart = null; });
ui.previousLoadpoint.addEventListener("click", () => moveBy(-1));
ui.nextLoadpoint.addEventListener("click", () => moveBy(1));
ui.vehicle.addEventListener("click", openVehicleSelector);
ui.vehicleSelectorBack.addEventListener("click", closeVehicleSelector);
ui.previousVehiclePage.addEventListener("click", () => moveVehiclePage(-1));
ui.nextVehiclePage.addEventListener("click", () => moveVehiclePage(1));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && vehicleSelectorOpen) closeVehicleSelector();
});
ui.controls.addEventListener("click", (event) => {
  const button = event.target.closest("button[data-mode]");
  if (button && !button.disabled) postMode(button.dataset.mode);
});

start();
