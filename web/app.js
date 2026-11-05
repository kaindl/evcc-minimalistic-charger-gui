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
  generic: "M18 15v-2h2q.425 0 .712.287q.288.288.288.713t-.288.712Q20.425 15 20 15Zm0 4v-2h2q.425 0 .712.288q.288.287.288.712t-.288.712Q20.425 20 20 20Zm-4 1q-.825 0-1.412-.587Q12 18.825 12 18h-2v-4h2q0-.825.588-1.413Q13.175 12 14 12h2q.425 0 .712.287q.288.288.288.713v6q0 .425-.288.712Q16.425 20 16 20Zm-7-3q-1.65 0-2.825-1.175Q3 14.65 3 13q0-1.65 1.175-2.825Q5.35 9 7 9h1.5q.625 0 1.062-.438Q10 8.125 10 7.5t-.438-1.062Q9.125 6 8.5 6H5q-.425 0-.713-.287Q4 5.425 4 5t.287-.713Q4.575 4 5 4h3.5q1.45 0 2.475 1.025Q12 6.05 12 7.5q0 1.45-1.025 2.475Q9.95 11 8.5 11H7q-.825 0-1.412.587Q5 12.175 5 13q0 .825.588 1.412Q6.175 15 7 15h2v2Z",
  heater: "M12 22q-3.35 0-5.675-2.325Q4 17.35 4 14q0-2.825 1.675-5.425q1.675-2.6 4.6-4.55q.55-.375 1.138-.038Q12 4.325 12 5v1.3q0 .85.588 1.425q.587.575 1.437.575q.425 0 .813-.187q.387-.188.687-.538q.2-.25.513-.313q.312-.062.587.138Q18.2 8.525 19.1 10.275q.9 1.75.9 3.725q0 3.35-2.325 5.675Q15.35 22 12 22Zm-6-8q0 1.3.525 2.462q.525 1.163 1.5 2.038Q8 18.375 8 18.275v-.225q0-.8.3-1.5t.875-1.275L12 12.5l2.825 2.775q.575.575.875 1.275q.3.7.3 1.5v.225q0 .1-.025.225q.975-.875 1.5-2.038Q18 15.3 18 14q0-1.25-.462-2.363q-.463-1.112-1.338-1.987q-.5.325-1.05.487q-.55.163-1.125.163q-1.55 0-2.687-1.025Q10.2 8.25 10.025 6.75q-1.95 1.65-2.987 3.512Q6 12.125 6 14Zm6 1.3l-1.425 1.4q-.275.275-.425.625q-.15.35-.15.725q0 .8.588 1.375Q11.175 20 12 20t1.413-.575Q14 18.85 14 18.05q0-.4-.15-.738q-.15-.337-.425-.612Z",
  cooler: "m11 17.85l-2.575 2.525q-.275.275-.687.275q-.413 0-.688-.3q-.3-.275-.3-.687q0-.413.3-.713L11 15v-2H9l-3.975 3.975q-.275.275-.687.275q-.413 0-.713-.3q-.275-.275-.275-.688q0-.412.275-.687L6.15 13H2.975q-.425 0-.7-.288Q2 12.425 2 12t.288-.713Q2.575 11 3 11h3.15L3.625 8.45q-.275-.275-.275-.688q0-.412.3-.712q.275-.275.688-.275q.412 0 .712.275L9 11h2V9L7.025 5.05q-.275-.275-.275-.688q0-.412.3-.712q.275-.275.688-.275q.412 0 .687.275L11 6.15V3q0-.425.288-.713Q11.575 2 12 2t.713.287Q13 2.575 13 3v3.15l2.55-2.5q.275-.275.688-.275q.412 0 .712.275q.275.3.275.712q0 .413-.275.688L13 9v2h2l3.95-3.95q.275-.275.688-.275q.412 0 .712.3q.275.275.275.687q0 .413-.275.688L17.85 11H21q.425 0 .712.287q.288.288.288.713t-.288.712Q21.425 13 21 13h-3.15l2.5 2.575q.275.275.275.687q0 .413-.275.688q-.3.3-.712.3q-.413 0-.688-.3L15 13h-2v2l3.95 3.975q.275.275.275.688q0 .412-.3.712q-.275.275-.687.275q-.413 0-.688-.275L13 17.85v3.175q0 .425-.287.7Q12.425 22 12 22t-.712-.288Q11 21.425 11 21Z",
  waterheater: "M6 22q-.825 0-1.412-.587Q4 20.825 4 20V6q0-1.65 1.175-2.825Q6.35 2 8 2h8q1.65 0 2.825 1.175Q20 4.35 20 6v14q0 .825-.587 1.413Q18.825 22 18 22Zm0-4v2h12v-2q-.75 0-1.2.5q-.45.5-1.8.5t-1.762-.5Q12.825 18 12 18t-1.237.5Q10.35 19 9 19q-1.35 0-1.762-.5Q6.825 18 6 18Zm3-1q.825 0 1.238-.5Q10.65 16 12 16t1.8.5q.45.5 1.2.5t1.2-.5q.45-.5 1.8-.5V6q0-.825-.587-1.412Q16.825 4 16 4H8q-.825 0-1.412.588Q6 5.175 6 6v10q1.35 0 1.763.5q.412.5 1.237.5Zm3.125-2.05q-1.65 0-2.875-1.088q-1.225-1.087-1.225-2.787q0-.575.163-1.188q.162-.612.587-1.212q.075-.125.213-.2q.137-.075.312-.075q.1 0 .15.062q.05.063.05.138q-.025.15-.037.287q-.013.138-.013.263q0 .75.313 1.312q.312.563.562.563q.15 0 .213-.1q.062-.1.062-.225t-.05-.288L10.425 10q-.05-.2-.1-.488q-.05-.287-.05-.662q0-1.35.612-2.313q.613-.962 1.738-1.462q.1-.05.138-.063Q12.8 5 12.875 5q.075 0 .113.05q.037.05.012.125q-.1.275-.137.487q-.038.213-.038.488q0 .8.438 1.425q.437.625 1.162 1.125q.775.525 1.125 1.288q.35.762.35 1.562q0 1.275-1 2.337q-1 1.063-2.775 1.063Zm.125-1.675q.7 0 1.175-.5q.475-.5.475-1.175q0-.4-.212-.713q-.213-.312-.513-.562q-.3-.25-.5-.5t-.3-.525q-.25.225-.3.512q-.05.288.025.688q.05.275.075.512q.025.238.025.438q0 .5-.325.9t-.775.475q.2.2.538.325q.337.125.612.125ZM12 12Z",
  bike: "M5 20q-2.125 0-3.562-1.438Q0 17.125 0 15t1.463-3.562Q2.925 10 5 10q1.925 0 3.238 1.15Q9.55 12.3 9.9 14h.65l-1.8-5H8q-.425 0-.713-.288Q7 8.425 7 8t.287-.713Q7.575 7 8 7h3q.425 0 .713.287Q12 7.575 12 8t-.287.712Q11.425 9 11 9h-.1l.35 1h4.8L14.6 6H13q-.425 0-.712-.287Q12 5.425 12 5t.288-.713Q12.575 4 13 4h1.6q.65 0 1.163.35q.512.35.737.95l1.7 4.65h.8q2.075 0 3.538 1.462Q24 12.875 24 14.95q0 2.1-1.45 3.575Q21.1 20 19 20q-1.8 0-3.162-1.125Q14.475 17.75 14.1 16H9.9q-.35 1.725-1.7 2.863Q6.85 20 5 20Zm0-2q1.025 0 1.763-.562Q7.5 16.875 7.8 16H6q-.425 0-.713-.288Q5 15.425 5 15t.287-.713Q5.575 14 6 14h1.8q-.3-.9-1.037-1.45Q6.025 12 5 12q-1.275 0-2.138.863Q2 13.725 2 15q0 1.25.862 2.125Q3.725 18 5 18Zm7.7-4h1.4q.125-.575.338-1.075q.212-.5.562-.925h-3.05Zm6.3 4q1.275 0 2.138-.875Q22 16.25 22 15q0-1.275-.862-2.137Q20.275 12 19 12h-.1l.65 1.7q.15.4-.037.762q-.188.363-.563.538q-.4.175-.775-.013q-.375-.187-.525-.587l-.6-1.7q-.5.425-.775 1T16 15q0 1.25.863 2.125Q17.725 18 19 18Z",
  bus: "M6.5 21q-.625 0-1.062-.438Q5 20.125 5 19.5v-1.55q-.45-.5-.725-1.113Q4 16.225 4 15.5V6q0-2.075 1.925-3.038Q7.85 2 12 2q4.3 0 6.15.925Q20 3.85 20 6v9.5q0 .725-.275 1.337q-.275.613-.725 1.113v1.55q0 .625-.438 1.062Q18.125 21 17.5 21t-1.062-.438Q16 20.125 16 19.5V19H8v.5q0 .625-.438 1.062Q7.125 21 6.5 21ZM6 10h12V7H6Zm2.5 6q.625 0 1.062-.438Q10 15.125 10 14.5t-.438-1.062Q9.125 13 8.5 13t-1.062.438Q7 13.875 7 14.5t.438 1.062Q7.875 16 8.5 16Zm7 0q.625 0 1.062-.438Q17 15.125 17 14.5t-.438-1.062Q16.125 13 15.5 13t-1.062.438Q14 13.875 14 14.5t.438 1.062Q14.875 16 15.5 16ZM8 17h8q.825 0 1.413-.587Q18 15.825 18 15v-3H6v3q0 .825.588 1.413Q7.175 17 8 17Z",
  van: "M6 20q-1.25 0-2.125-.875T3 17q-.825 0-1.412-.587Q1 15.825 1 15V6q0-.825.588-1.412Q2.175 4 3 4h12q.825 0 1.413.588Q17 5.175 17 6v2h2.5q.25 0 .45.1t.35.3l2.5 3.325q.1.125.15.275q.05.15.05.325V16q0 .425-.288.712Q22.425 17 22 17h-1q0 1.25-.875 2.125T18 20q-1.25 0-2.125-.875T15 17H9q0 1.25-.875 2.125T6 20ZM3 6v9h.8q.425-.45.975-.725Q5.325 14 6 14t1.225.275q.55.275.975.725H15V6H3Zm14 7h4.25L19 10h-2Z",
  taxi: "M6 19v.5q0 .625-.437 1.063T4.5 21t-1.062-.437T3 19.5v-7.15q0-.175.025-.35t.075-.325L4.975 6.35q.2-.6.725-.975T6.875 5H9V4q0-.425.288-.712T10 3h4q.425 0 .713.288T15 4v1h2.125q.65 0 1.175.375t.725.975l1.875 5.325q.05.15.075.325t.025.35v7.15q0 .625-.437 1.063T19.5 21t-1.062-.437T18 19.5V19zm-.2-9h12.4l-1.05-3H6.85zM5 17h14v-5H5z",
  motorcycle: "M5 19q-2.075 0-3.537-1.462Q0 16.075 0 14q0-2.075 1.463-3.538Q2.925 9 5 9h11.6l-2-2H12q-.425 0-.712-.287Q11 6.425 11 6t.288-.713Q11.575 5 12 5h2.975q.2 0 .388.075q.187.075.337.225l3.75 3.75q1.95.15 3.25 1.575T24 14q0 2.075-1.462 3.538Q21.075 19 19 19q-2.075 0-3.537-1.462Q14 16.075 14 14q0-.45.062-.888q.063-.437.238-.862l-2.175 2.175q-.275.275-.637.425q-.363.15-.763.15H9.9q-.35 1.75-1.725 2.875T5 19Zm14-2q1.25 0 2.125-.875T22 14q0-1.25-.875-2.125T19 11q-1.25 0-2.125.875T16 14q0 1.25.875 2.125T19 17ZM5 17q.95 0 1.713-.55Q7.475 15.9 7.8 15H6q-.425 0-.713-.288Q5 14.425 5 14t.287-.713Q5.575 13 6 13h1.8q-.325-.9-1.087-1.45Q5.95 11 5 11q-1.25 0-2.125.875T2 14q0 1.25.875 2.125T5 17Zm4.95-4h.75l2-2H8.95q.375.425.625.925T9.95 13Z",
  moped: "M7 17q-1.25 0-2.125-.875T4 14H3q-.425 0-.712-.288Q2 13.425 2 13v-2q0-1.65 1.175-2.825Q4.35 7 6 7h3q.425 0 .713.287Q10 7.575 10 8v4h3.5L17 7.65V5h-2q-.425 0-.712-.288Q14 4.425 14 4t.288-.713Q14.575 3 15 3h2q.825 0 1.413.587Q19 4.175 19 5v2.65q0 .35-.112.662q-.113.313-.313.588L15.1 13.25q-.275.35-.7.55q-.425.2-.875.2H10q0 1.25-.875 2.125T7 17Zm1-5Zm-1 3q.425 0 .713-.288Q8 14.425 8 14H6q0 .425.287.712Q6.575 15 7 15ZM6 6q-.425 0-.713-.287Q5 5.425 5 5t.287-.713Q5.575 4 6 4h3q.425 0 .713.287Q10 4.575 10 5t-.287.713Q9.425 6 9 6Zm13 11q-1.25 0-2.125-.875T16 14q0-1.25.875-2.125T19 11q1.25 0 2.125.875T22 14q0 1.25-.875 2.125T19 17Zm0-2q.425 0 .712-.288Q20 14.425 20 14t-.288-.713Q19.425 13 19 13t-.712.287Q18 13.575 18 14t.288.712Q18.575 15 19 15Zm-6 8l-6-3h4v-2l6 3h-4ZM4 12h4V9H6q-.825 0-1.412.587Q4 10.175 4 11Z",
  scooter: "M5 18q-1.25 0-2.125-.875T2 15q0-1.25.875-2.125T5 12q.975 0 1.738.562Q7.5 13.125 7.8 14h5.3q.275-1.7 1.412-2.975Q15.65 9.75 17.3 9.25L15.9 3H13q-.425 0-.712-.288Q12 2.425 12 2t.288-.713Q12.575 1 13 1h2.9q.675 0 1.237.438q.563.437.713 1.112l1.9 8.45H19q-1.65 0-2.825 1.175Q15 13.35 15 15v1H7.8q-.3.875-1.062 1.438Q5.975 18 5 18Zm0-2q.425 0 .713-.288Q6 15.425 6 15t-.287-.713Q5.425 14 5 14t-.713.287Q4 14.575 4 15t.287.712Q4.575 16 5 16Zm14 2q-1.25 0-2.125-.875T16 15q0-1.25.875-2.125T19 12q1.25 0 2.125.875T23 15q0 1.25-.875 2.125T19 18Zm0-2q.425 0 .712-.288Q20 15.425 20 15t-.288-.713Q19.425 14 19 14t-.712.287Q18 14.575 18 15t.288.712Q18.575 16 19 16Zm-6 7l-6-3h4v-2l6 3h-4Z",
  tractor: "M4 9q-.425 0-.712-.288Q3 8.425 3 8t.288-.713Q3.575 7 4 7h3q.825 0 1.412.587Q9 8.175 9 9Zm2 9q1.25 0 2.125-.875T10 15q0-1.25-.875-2.125T7 12q-1.25 0-2.125.875T4 15q0 1.25.875 2.125T6 18Zm13.5 0q.625 0 1.062-.438Q21 17.125 21 16.5t-.438-1.062Q20.125 15 19.5 15t-1.062.438Q18 15.875 18 16.5t.438 1.062Q18.875 18 19.5 18ZM6 16.5q-.625 0-1.062-.438Q4.5 15.625 4.5 15t.438-1.062Q5.375 13.5 6 13.5t1.062.438Q7.5 14.375 7.5 15t-.438 1.062Q6.625 16.5 6 16.5Zm14-3.475q.65.125 1.075.337q.425.213.925.688V8q0-.825-.587-1.412Q20.825 6 20 6h-6.3l-1.05-1.1l1.05-1.05q.15-.15.15-.35q0-.2-.15-.35q-.15-.15-.35-.15q-.2 0-.35.15l-2.825 2.825q-.15.15-.15.363q0 .212.175.362q.15.15.35.15q.2 0 .35-.15l1.05-1.05L13 6.7V9q0 .825-.587 1.412Q11.825 11 11 11H8.975q.575.425.925.875q.35.45.7 1.125h.4q1.65 0 2.825-1.175Q15 10.65 15 9V8h5ZM16.025 16q.15-.675.363-1.088q.212-.412.662-.912H10.9q.1.575.1 1q0 .425-.1 1Zm3.475 4q-1.45 0-2.475-1.025Q16 17.95 16 16.5q0-1.45 1.025-2.475Q18.05 13 19.5 13q1.45 0 2.475 1.025Q23 15.05 23 16.5q0 1.45-1.025 2.475Q20.95 20 19.5 20ZM6 20q-2.075 0-3.537-1.462Q1 17.075 1 15q0-2.075 1.463-3.538Q3.925 10 6 10t3.538 1.462Q11 12.925 11 15q0 2.075-1.462 3.538Q8.075 20 6 20Zm9.825-9Z",
  shuttle: "M6 19q-1.25 0-2.125-.875T3 16q-.825 0-1.412-.587T1 14V7q0-.825.588-1.412T3 5h13.175q.4 0 .763.15t.637.425l4.85 4.85q.275.275.425.638t.15.762V14q0 .825-.587 1.413T21 16q0 1.25-.875 2.125T18 19t-2.125-.875T15 16H9q0 1.25-.875 2.125T6 19m9-9h4l-3-3h-1zm-6 0h4V7H9zm-6 0h4V7H3zm3 7.25q.525 0 .888-.363T7.25 16t-.363-.888T6 14.75t-.888.363T4.75 16t.363.888t.887.362m12 0q.525 0 .888-.363T19.25 16t-.363-.888T18 14.75t-.888.363t-.362.887t.363.888t.887.362M8.2 14h7.6q.425-.45.975-.725T18 13t1.225.275t.975.725h.8v-2H3v2h.8q.425-.45.975-.725T6 13t1.225.275T8.2 14Z",
  airpurifier: "M3 21V6q0-1.25.875-2.125T6 3h4q1.25 0 2.125.875T13 6v15zm7-6h1v-5h-1zm-5 4h6v-2h-1q-.825 0-1.412-.587T8 15v-5q0-.825.588-1.412T10 8h1V6q0-.425-.288-.712T10 5H6q-.425 0-.712.288T5 6zm12.2-5.425q-.65 0-1.275-.175t-1.225-.45l.625-1.9q.5.225.988.375t.912.15q.3 0 .6-.1t.625-.3q.6-.425 1.2-.575t1.15-.15q.625 0 1.288.163t1.237.437l-.625 1.9q-.575-.2-1.062-.35t-.838-.15q-.3 0-.662.113t-.763.387q-.525.35-1.062.488t-1.113.137m.025-3.9q-.65 0-1.3-.175T14.7 9.05l.625-1.9q.65.275 1.1.4t.8.125q.3 0 .6-.087t.625-.313q.625-.425 1.213-.575t1.137-.15q.625 0 1.25.163t1.275.437l-.625 1.9q-.65-.225-1.1-.363t-.8-.137q-.325 0-.663.1t-.762.4q-.45.325-1.012.475t-1.138.15m0 7.8q-.65 0-1.287-.175t-1.238-.45l.625-1.9q.55.25 1.025.388t.875.137q.3 0 .6-.088t.625-.312q.575-.4 1.225-.562t1.15-.163q.625 0 1.275.175t1.225.425l-.625 1.9q-.65-.225-1.112-.363t-.788-.137q-.35 0-.712.113t-.713.387q-.425.3-.987.463t-1.163.162M11 19V5.788V6v-.212z",
  battery: "M8 22q-.425 0-.712-.288T7 21V5q0-.425.288-.712T8 4h2V3q0-.425.288-.712T11 2h2q.425 0 .713.288T14 3v1h2q.425 0 .713.288T17 5v16q0 .425-.288.713T16 22zm1-2h6V6H9zm0 0h6zm1-5.275q0 .575.213 1.088t.612.912l.225.225q.275.275.688.275t.712-.275q.3-.3.3-.712t-.3-.713l-.225-.225q-.125-.125-.175-.262T12 14.75q0-.175.05-.312t.175-.263l.95-.95q.4-.4.613-.9t.212-1.05q0-.575-.212-1.087t-.613-.913l-.25-.25q-.3-.3-.7-.288t-.7.313q-.275.3-.288.7t.288.7l.225.225q.125.125.188.262t.062.313q0 .15-.062.288t-.188.262l-.925.95q-.4.4-.612.9T10 14.725",
  bulb: "M11 21v-1q0-.425.288-.712T12 19t.713.288T13 20v1q0 .425-.288.713T12 22t-.712-.288T11 21M3 11h1q.425 0 .713.288T5 12t-.288.713T4 13H3q-.425 0-.712-.288T2 12t.288-.712T3 11m17 0h1q.425 0 .713.288T22 12t-.288.713T21 13h-1q-.425 0-.712-.288T19 12t.288-.712T20 11m-2.7 8.2l-.7-.7q-.275-.275-.275-.7t.275-.7t.7-.275t.7.275l.7.7q.275.275.275.7t-.275.7t-.7.275t-.7-.275m-12-1.4l.7-.7q.275-.275.7-.275t.7.275t.275.7t-.275.7l-.7.7q-.275.275-.7.275t-.7-.275t-.275-.7t.275-.7M12 17q-2.075 0-3.537-1.462T7 12q0-1.2.538-2.238T9 8V5q0-.825.588-1.412T11 3h2q.825 0 1.413.588T15 5v3q.925.725 1.463 1.763T17 12q0 2.075-1.463 3.538T12 17m-1-9.9q.25-.05.5-.075T12 7t.5.025t.5.075V5h-2zm1 7.9q1.25 0 2.125-.875T15 12t-.875-2.125T12 9t-2.125.875T9 12t.875 2.125T12 15m0-3",
  climate: "M20 12H4q-.825 0-1.412-.587T2 10V4q0-.825.588-1.412T4 2h16q.825 0 1.413.588T22 4v6q0 .825-.587 1.413T20 12M4 19v-2q1.25 0 2.125-.875T7 14h2q0 2.075-1.463 3.538T4 19m16 0q-2.075 0-3.537-1.463T15 14h2q0 1.25.875 2.125T20 17zm-9 1v-6h2v6zm9-10H4zM6 10V8q0-.825.588-1.412T8 6h8q.825 0 1.413.588T18 8v2h-2V8H8v2zm-2 0h16V4H4z",
  coffeemaker: "M6 22q-.825 0-1.412-.587T4 20V4q0-.825.588-1.412T6 2h13q.425 0 .713.288T20 3t-.288.713T19 4h-1v2q0 .425-.288.713T17 7H9q-.425 0-.712-.288T8 6V4H6v16h4.05q-.95-.675-1.5-1.713T8 16v-3q0-.825.588-1.412T10 11h6q.825 0 1.413.588T18 13v3q0 1.25-.55 2.288T15.95 20H19q.425 0 .713.288T20 21t-.288.713T19 22zm7-3q1.25 0 2.125-.875T16 16v-3h-6v3q0 1.25.875 2.125T13 19m0-9q.425 0 .713-.288T14 9t-.288-.712T13 8t-.712.288T12 9t.288.713T13 10m0 3",
  compute: "M8.075 20q-.275 0-.513-.137q-.237-.138-.362-.388L5.25 16H6.7l1 2H10v-1H8.3l-1-2H4.7l-1.425-2.5q-.05-.125-.087-.25q-.038-.125-.038-.25t.038-.25q.037-.125.087-.25L4.7 9h2.6l1-2H10V6H7.7l-1 2H5.25L7.2 4.525q.125-.25.362-.388Q7.8 4 8.075 4H10.5q.425 0 .713.287q.287.288.287.713v4H10l-1 1h2.5v3H9.3l-1-2H6l-1 1h2.7l1 2h2.8v5q0 .425-.287.712q-.288.288-.713.288Zm5.425 0q-.425 0-.712-.288q-.288-.287-.288-.712v-5h2.8l1-2H19l-1-1h-2.3l-1 2h-2.2v-3H15l-1-1h-1.5V5q0-.425.288-.713Q13.075 4 13.5 4h2.425q.275 0 .513.137q.237.138.362.388L18.75 8H17.3l-1-2H14v1h1.7l1 2h2.6l1.425 2.5q.05.125.087.25q.038.125.038.25t-.038.25q-.037.125-.087.25L19.3 15h-2.6l-1 2H14v1h2.3l1-2h1.45l-1.95 3.475q-.125.25-.362.388q-.238.137-.513.137Z",
  cooking: "M3.725 7q-.65-.775-.937-1.475T2.475 4q0-.425.313-.712T3.525 3q.375 0 .613.3t.237.7q0 .5.175.925t.6.925q.75.9 1.063 1.613T6.5 9q-.025.425-.35.713T5.4 10q-.35 0-.562-.3t-.213-.675q0-.575-.238-1.05T3.726 7M7.75 7q-.65-.775-.95-1.475T6.475 4q0-.425.313-.712T7.525 3q.375 0 .613.3t.237.7q0 .5.175.925t.6.925q.75.9 1.063 1.613T10.5 9q-.025.425-.35.713T9.4 10q-.35 0-.562-.3t-.213-.675q.025-.575-.213-1.05T7.75 7m4 0q-.65-.775-.95-1.475T10.475 4q0-.425.313-.712T11.525 3q.375 0 .613.3t.237.7q0 .5.175.925t.6.925q.75.9 1.063 1.613T14.5 9q-.025.425-.35.713T13.4 10q-.35 0-.562-.3t-.213-.675q.025-.575-.213-1.05T11.75 7M5 20q-1.25 0-2.125-.875T2 17v-4q0-.425.288-.712T3 12h13.025q.125-.85.675-1.487t1.35-.913l3.675-1.225q.4-.125.775.05T23 9t-.062.775t-.588.5L18.675 11.5q-.3.1-.488.363T18 12.45V17q0 1.25-.875 2.125T15 20zm0-2h10q.425 0 .713-.288T16 17v-3H4v3q0 .425.288.713T5 18m5-2",
  desktop: "M10 19v-2H4q-.825 0-1.412-.587T2 15V5q0-.825.588-1.412T4 3h16q.825 0 1.413.588T22 5v10q0 .825-.587 1.413T20 17h-6v2h1q.425 0 .713.288T16 20t-.288.713T15 21H9q-.425 0-.712-.288T8 20t.288-.712T9 19zm-6-4h16V5H4zm0 0V5z",
  device: "M4 21q-1.25 0-2.125-.875T1 18V6q0-1.25.875-2.125T4 3h8q1.25 0 2.125.875T15 6v6.3h1q.825 0 1.413.588T18 14.3v3.2q0 .2.15.35t.35.15t.35-.15t.15-.35V11q-.825 0-1.412-.587T17 9V6h1V4h1.5v2h1V4H22v2h1v3q0 .825-.587 1.413T21 11v6.4q0 1.05-.725 1.775T18.5 19.9t-1.775-.725T16 17.4v-3.2h-1V17q0 1.65-1.175 2.825T11 21zm0-2h7q.825 0 1.413-.587T13 17t-.587-1.412T11 15H6.5q-.2 0-.35.15T6 15.5t.15.35t.35.15H11q.425 0 .713.288T12 17t-.288.713T11 18H6.5q-1.05 0-1.775-.725T4 15.5t.725-1.775T6.5 13H11q.525 0 1.038.15t.962.45V6q0-.425-.288-.712T12 5H4q-.425 0-.712.288T3 6v12q0 .425.288.713T4 19m0 0h7h-8z",
  dishwasher: "M8 7q.425 0 .713-.288T9 6t-.288-.712T8 5t-.712.288T7 6t.288.713T8 7m3 0q.425 0 .713-.288T12 6t-.288-.712T11 5t-.712.288T10 6t.288.713T11 7m1 11q1.575 0 2.688-1.075T15.8 14.3q0-.725-.25-1.412T14.8 11.7L12 8.9l-2.7 2.7q-.55.55-.837 1.25T8.2 14.3q.05 1.55 1.15 2.625T12 18m0-1.9q-.75 0-1.275-.525T10.2 14.3q0-.375.138-.712t.412-.613l1.25-1.25l1.225 1.225q.275.275.425.625t.15.725q0 .75-.525 1.275T12 16.1M6 22q-.825 0-1.412-.587T4 20V4q0-.825.588-1.412T6 2h12q.825 0 1.413.588T20 4v16q0 .825-.587 1.413T18 22zm0-2h12V4H6zm0 0V4z",
  dryer: "M4 12.6q0-1.65.613-3.062T6.35 7.05l4.6-4.525q.225-.2.5-.312T12 2.1t.55.113t.5.312l4.6 4.525q.725.725 1.263 1.6t.812 1.875q.1.35-.137.613t-.588.337t-.75-.137t-.625-.788t-.562-1.1t-.813-.95L12 4.3L7.75 8.5q-.875.825-1.312 1.863T6 12.6q0 1.9 1.138 3.425t2.887 2.15q.575.2.775.6t.15.75t-.312.588t-.613.137Q7.4 19.575 5.7 17.463T4 12.6m13.375 2.9q-.45-.2-.913-.35T15.5 15q-.4 0-.775.088t-.725.237q-.275.125-.575.025T13 14.975q-.125-.3 0-.6t.425-.425q.5-.2 1.025-.325t1.05-.125q.575 0 1.138.138t1.087.337q.45.2.913.35t.962.15q.4 0 .775-.087t.725-.238q.275-.125.575-.025t.425.375q.125.3 0 .6t-.425.425q-.5.2-1.025.325t-1.05.125q-.575 0-1.137-.137t-1.088-.338m0 3q-.45-.2-.913-.35T15.5 18q-.4 0-.775.088t-.725.237q-.275.125-.575.025T13 17.975q-.125-.3 0-.6t.425-.425q.5-.2 1.025-.325t1.05-.125q.575 0 1.138.137t1.087.338q.45.2.913.35t.962.15q.4 0 .775-.088t.725-.237q.275-.125.575-.025t.425.375q.125.3 0 .6t-.425.425q-.5.2-1.025.325t-1.05.125q-.575 0-1.137-.137t-1.088-.338m0 3q-.45-.2-.913-.35T15.5 21q-.4 0-.775.088t-.725.237q-.275.125-.575.025T13 20.975q-.125-.3 0-.6t.425-.425q.5-.2 1.025-.325t1.05-.125q.575 0 1.138.137t1.087.338q.45.2.913.35t.962.15q.4 0 .775-.088t.725-.237q.275-.125.575-.025t.425.375q.125.3 0 .6t-.425.425q-.5.2-1.025.325t-1.05.125q-.575 0-1.137-.137t-1.088-.338",
  floorlamp: "M12 19q-.425 0-.712-.288T11 18v-7H6q-.5 0-.8-.4t-.15-.9L7 3.4q.2-.625.725-1.013T8.9 2h6.2q.65 0 1.175.388T17 3.4l1.95 6.3q.15.5-.15.9t-.8.4h-5v7q0 .425-.288.713T12 19M7.35 9h9.3L15.1 4H8.9zM9 22q-.425 0-.712-.288T8 21t.288-.712T9 20h6q.425 0 .713.288T16 21t-.288.713T15 22zm3-15.5",
  heatexchange: "M20.175 7.6H19q-.425 0-.712.288T18 8.6v7q0 1.25-.875 2.125T15 18.6t-2.125-.875T12 15.6v-6q0-.425-.288-.712T11 8.6t-.712.288T10 9.6v6q0 1.25-.875 2.125T7 18.6t-2.125-.875T4 15.6v-8q0-.425.288-.712T5 6.6t.713.288T6 7.6v8q0 .425.288.713T7 16.6t.713-.288T8 15.6v-6q0-1.25.875-2.125T11 6.6t2.125.875T14 9.6v6q0 .425.288.713T15 16.6t.713-.288T16 15.6v-7q0-1.25.875-2.125T19 5.6h1.175l-.475-.475q-.275-.275-.275-.687t.275-.713q.3-.3.713-.3t.712.3L23.3 5.9q.3.3.3.7t-.3.7l-2.2 2.175q-.3.275-.713.288t-.687-.288t-.275-.725t.3-.7zM3 21.6q-.825 0-1.412-.587T1 19.6v-7q0-.425.288-.712T2 11.6h20q.425 0 .713.288T23 12.6v7q0 .825-.587 1.413T21 21.6zm0-2h18v-6H3zm18-6H3z",
  heatpump: "M12 18q-2.5 0-4.25-1.75T6 12t1.75-4.25T12 6t4.25 1.75T18 12t-1.75 4.25T12 18m-.75-2.075V13.8l-1.5 1.5q.35.225.713.388t.787.237m1.5 0q.4-.075.775-.238t.725-.387l-1.5-1.5zm2.55-1.675q.225-.35.388-.725t.237-.775H13.8zm-1.5-3h2.125q-.075-.4-.238-.775T15.3 9.75zm-1.05-1.05l1.5-1.5q-.35-.225-.712-.387t-.788-.238zM12 13q.425 0 .713-.288T13 12t-.288-.712T12 11t-.712.288T11 12t.288.713T12 13m-.75-2.8V8.075q-.4.075-.775.238T9.75 8.7zm-3.175 1.05H10.2l-1.5-1.5q-.225.35-.387.725t-.238.775m.625 3l1.5-1.5H8.075q.075.4.238.775t.387.725M5 21q-.825 0-1.412-.587T3 19V5q0-.825.588-1.412T5 3h14q.825 0 1.413.588T21 5v14q0 .825-.587 1.413T19 21zm0-2h14V5H5zM5 5v14z",
  kettle: "M6 17V6L4.2 3.6q-.375-.5-.1-1.05T5 2h10.775q.925 0 1.575.65T18 4.225V5h2q.825 0 1.413.588T22 7v5q0 .825-.587 1.413T20 14h-2v3q0 .825-.587 1.413T16 19H8q-.825 0-1.412-.587T6 17m2 0h8V4H7l1 1.3zm10-5h2V7h-2zm-4.5-7q-.625 0-1.062.438T12 6.5v8q0 .625.438 1.063T13.5 16t1.063-.437T15 14.5v-8q0-.625-.437-1.062T13.5 5M4 22q-.425 0-.712-.288T3 21t.288-.712T4 20h16q.425 0 .713.288T21 21t-.288.713T20 22zm7.5-11.5",
  laundry: "M6 22q-.825 0-1.412-.587T4 20V4q0-.825.588-1.412T6 2h12q.825 0 1.413.588T20 4v16q0 .825-.587 1.413T18 22zm0-2h12V4H6zm6-1q2.075 0 3.538-1.463T17 14t-1.463-3.537T12 9t-3.537 1.463T7 14t1.463 3.538T12 19m0-1.7q-.65 0-1.263-.238T9.65 16.35l4.7-4.7q.475.475.713 1.088T15.3 14q0 1.375-.962 2.338T12 17.3M8 7q.425 0 .713-.288T9 6t-.288-.712T8 5t-.712.288T7 6t.288.713T8 7m3 0q.425 0 .713-.288T12 6t-.288-.712T11 5t-.712.288T10 6t.288.713T11 7M6 20V4z",
  laundry2: "M4.875 9.3L8 7.575V13.5q-.525.05-1.025.163T6 13.975v-3l-1.025.55q-.35.2-.75.088t-.6-.463l-2-3.475q-.2-.35-.088-.762T2 6.3l4.975-2.875q.3-.175.625-.3T8.275 3t.6.213t.375.537q.35.95.913 1.6T12 6t1.838-.65t.912-1.6q.125-.325.388-.537T15.75 3t.663.125t.612.3L22 6.3q.35.2.45.6t-.1.75l-1.975 3.5q-.2.35-.6.463t-.75-.088L18 10.975v4.8l-1.575 1.375q-.1.075-.2.138T16 17.4V7.575L19.125 9.3l1-1.75L16.3 5.325q-.6 1.225-1.763 1.95T12 8t-2.537-.725T7.7 5.325L3.85 7.55zM4 18.625q-.275-.325-.238-.737t.363-.688l1.4-1.2q.575-.5 1.313-.763t1.537-.262t1.525.263t1.3.762l2.9 2.475q.3.25.713.388t.837.137q.45 0 .838-.125t.687-.4l1.4-1.2q.325-.275.738-.25t.687.35t.238.738t-.363.687l-1.4 1.2q-.575.5-1.3.75T15.65 21t-1.537-.25T12.8 20l-2.9-2.475q-.3-.25-.687-.387T8.375 17q-.425 0-.837.138t-.713.387l-1.425 1.2q-.325.275-.725.25T4 18.625",
  machine: "M5.475 21q-.625 0-1.062-.437T3.975 19.5t.438-1.062T5.475 18h1.6l-2.55-8.35q-.675-.375-1.112-1.1T2.975 7q0-1.25.875-2.125T5.975 4q.975 0 1.738.563T8.775 6h3.2V5q0-.425.288-.712T12.975 4q.225 0 .438.1t.362.3l1.7-1.6q.225-.225.538-.288t.612.088l3.9 1.8q.3.15.413.438t-.013.562q-.15.3-.437.388t-.563-.038l-3.6-1.65l-2.35 2.2v1.4l2.35 2.15l3.6-1.65q.275-.125.575-.025t.425.375q.15.3.025.575t-.425.425l-3.9 1.85q-.3.15-.612.087t-.538-.287l-1.7-1.6q-.15.15-.362.275t-.438.125q-.425 0-.712-.287T11.975 9V8h-3.2q-.075.2-.162.375t-.238.375l5 9.25h2.1q.625 0 1.063.438t.437 1.062t-.437 1.063t-1.063.437zm.5-13q.425 0 .713-.288T6.975 7t-.287-.712T5.975 6t-.712.288T4.975 7t.288.713t.712.287m3.15 10h1.95l-4.3-8h-.1zm1.95 0",
  meter: "M9 20.95v-1.5q-2.65-.925-4.325-3.237T3 10.95q0-1.875.713-3.512t1.924-2.85t2.85-1.925t3.488-.713t3.5.713t2.875 1.925t1.938 2.85T21 10.95q0 2.95-1.687 5.238T15 19.425v1.525q0 .425-.288.713T14 21.95t-.712-.287T13 20.95V19.9q-.25.05-.5.05h-.525q-.25 0-.488-.012T11 19.9v1.05q0 .425-.288.713T10 21.95t-.712-.287T9 20.95M12 18q2.9 0 4.95-2.05T19 11t-2.05-4.95T12 4T7.05 6.05T5 11t2.05 4.95T12 18M9 9h6q.425 0 .713-.288T16 8t-.288-.712T15 7H9q-.425 0-.712.288T8 8t.288.713T9 9m2 5.25l-.5.5q-.325.325-.325.75t.325.75t.75.325t.75-.325l1.55-1.55q.3-.3.3-.7t-.3-.7l-.55-.55l.5-.5q.325-.325.325-.75t-.325-.75t-.75-.325t-.75.325l-1.55 1.55q-.3.3-.3.7t.3.7zM12 11",
  microwave: "M4 20q-.825 0-1.412-.587T2 18V6q0-.825.588-1.412T4 4h16q.825 0 1.413.588T22 6v12q0 .825-.587 1.413T20 20zm0-2h16V6H4zm2-1h8q.425 0 .713-.288T15 16V8q0-.425-.288-.712T14 7H6q-.425 0-.712.288T5 8v8q0 .425.288.713T6 17m12 0q.425 0 .713-.288T19 16t-.288-.712T18 15t-.712.288T17 16t.288.713T18 17M7 15V9h6v6zm11-2q.425 0 .713-.288T19 12t-.288-.712T18 11t-.712.288T17 12t.288.713T18 13m0-4q.425 0 .713-.288T19 8t-.288-.712T18 7t-.712.288T17 8t.288.713T18 9M4 18V6z",
  pump: "M12 15q-.825 0-1.412-.587T10 13q0-.575.238-1.137t.912-1.613l.425-.625q.15-.225.425-.225t.425.225l.425.625q.675 1.05.913 1.613T14 13q0 .825-.587 1.413T12 15m-9 2h4.1q-.425-.425-.787-.925T5.675 15H3zm9 0q2.075 0 3.538-1.463T17 12t-1.463-3.537T12 7T8.463 8.463T7 12t1.463 3.538T12 17m6.325-8H21V7h-4.1q.425.425.788.925T18.325 9M3 19q0 .425-.288.713T2 20t-.712-.288T1 19v-6q0-.425.288-.712T2 12t.713.288T3 13h2.075q-.05-.25-.062-.488T5 12q0-2.925 2.038-4.962T12 5h9q0-.425.288-.712T22 4t.713.288T23 5v6q0 .425-.288.713T22 12t-.712-.288T21 11h-2.075q.05.25.063.488T19 12q0 2.925-2.037 4.963T12 19zm0-2v-2zm18-8V7zm-9 3",
  rickshaw: "M6 17q-.975 0-1.737-.562T3.2 15H3q-.825 0-1.412-.587T1 13V5q0-.825.588-1.412T3 3h12.05q.45 0 .85.175t.7.525l3.95 4.75q.225.275.338.588T21 9.7v1.45q.875.3 1.438 1.088T23 14q0 1.25-.875 2.125T20 17q-.975 0-1.763-.562T17.15 15h-8.3q-.35.875-1.112 1.438T6 17M3 8h4V5H3zm6 5h5V5H9v3h2q.425 0 .713.288T12 9t-.288.713T11 10H9zm7-4h2.4L16 6.1zM6 15q.425 0 .713-.288T7 14t-.288-.712T6 13t-.712.288T5 14t.288.713T6 15m14 0q.425 0 .713-.288T21 14t-.288-.712T20 13t-.712.288T19 14t.288.713T20 15m-7.725 7.65L7.95 20.475q-.175-.1-.137-.288T8.05 20H11v-1.2q0-.275.238-.425t.487-.025l4.325 2.175q.175.1.138.288T15.95 21H13v1.2q0 .275-.238.425t-.487.025M3 10v3h.15q.35-.875 1.113-1.437T6 11q.275 0 .525.038T7 11.15V10zm13 3h1.15q.225-.65.713-1.137T19 11.15V11h-3zM3 10h4zm13 1h3z",
  rocket: "M7.1 11.35q.35-.7.725-1.35t.825-1.3l-1.4-.275l-2.1 2.1zm12.05-6.875q-1.75.05-3.737 1.025T11.8 8.1q-1.05 1.05-1.875 2.25T8.7 12.6l2.85 2.825q1.05-.4 2.25-1.225t2.25-1.875q1.625-1.625 2.6-3.6T19.675 5q0-.1-.038-.2t-.112-.175t-.175-.112t-.2-.038m-5.5 6q-.575-.575-.575-1.412t.575-1.413t1.425-.575t1.425.575t.575 1.413t-.575 1.412t-1.425.575t-1.425-.575m-.85 6.55L13.625 19l2.1-2.1l-.275-1.4q-.65.45-1.3.813t-1.35.712m8.775-13.35q.2 2.75-.9 5.363T17.2 14.025l.5 2.475q.1.5-.05.975t-.5.825L14 21.45q-.375.375-.9.288t-.725-.588l-1.525-3.575L6.575 13.3L3 11.775q-.5-.2-.6-.725t.275-.9L5.825 7q.35-.35.837-.5t.988-.05l2.475.5q2.375-2.375 4.988-3.475t5.362-.9q.2.025.4.113t.35.237t.238.35t.112.4m-17.65 12.3q.875-.875 2.138-.887t2.137.862t.863 2.138t-.888 2.137q-1.2 1.2-2.838 1.425t-3.287.45l.45-3.287q.225-1.637 1.425-2.838m1.425 1.4q-.425.425-.587 1.025T4.5 19.625q.625-.1 1.225-.25T6.75 18.8q.3-.3.325-.725T6.8 17.35t-.725-.288t-.725.313",
  smartconsumer: "M12,27.933l0,-2c-2.356,-0.822 -4.278,-2.261 -5.767,-4.316c-1.489,-2.055 -2.233,-4.394 -2.233,-7.017c0,-1.667 0.317,-3.228 0.951,-4.683c0.633,-1.455 1.489,-2.721 2.565,-3.8c1.076,-1.078 2.343,-1.933 3.8,-2.566c1.457,-0.633 3.007,-0.95 4.651,-0.951c1.643,-0.001 3.199,0.316 4.666,0.951c1.468,0.634 2.746,1.49 3.834,2.566c1.088,1.077 1.949,2.343 2.584,3.8c0.634,1.457 0.951,3.018 0.949,4.683c-0,2.622 -0.75,4.95 -2.249,6.984c-1.5,2.034 -3.417,3.472 -5.751,4.316l-0,2.033c-0,0.378 -0.128,0.695 -0.384,0.951c-0.256,0.256 -0.572,0.384 -0.949,0.383c-0.377,-0.001 -0.694,-0.129 -0.95,-0.383c-0.256,-0.254 -0.384,-0.571 -0.384,-0.951l0,-1.4c-0.222,0.045 -0.444,0.067 -0.666,0.067l-0.7,-0c-0.223,-0 -0.439,-0.005 -0.651,-0.016c-0.212,-0.011 -0.428,-0.028 -0.649,-0.051l-0,1.4c-0,0.378 -0.128,0.695 -0.384,0.951c-0.256,0.256 -0.573,0.384 -0.95,0.383c-0.377,-0.001 -0.693,-0.129 -0.949,-0.383c-0.256,-0.254 -0.384,-0.571 -0.384,-0.951Zm4,-3.933c2.578,-0 4.778,-0.911 6.6,-2.733c1.822,-1.823 2.733,-4.023 2.733,-6.6c0,-2.578 -0.911,-4.778 -2.733,-6.6c-1.822,-1.823 -4.022,-2.734 -6.6,-2.734c-2.578,0 -4.778,0.911 -6.6,2.734c-1.822,1.822 -2.733,4.022 -2.733,6.6c-0,2.577 0.911,4.777 2.733,6.6c1.822,1.822 4.022,2.733 6.6,2.733Zm-4,-12c-0.376,0.002 -0.692,-0.126 -0.949,-0.383c-0.257,-0.257 -0.385,-0.573 -0.384,-0.95c0.001,-0.377 0.129,-0.694 0.384,-0.95c0.255,-0.256 0.571,-0.384 0.949,-0.384l8,0c0.378,0 0.694,0.128 0.949,0.384c0.255,0.256 0.383,0.573 0.384,0.95c0.001,0.377 -0.126,0.693 -0.382,0.949c-0.256,0.256 -0.573,0.384 -0.951,0.384l-8,-0Zm6.833,5.5l-1.833,-0.833l1.833,-0.834l0.834,-1.833l0.833,1.833l1.833,0.834l-1.833,0.833l-0.833,1.833l-0.834,-1.833Zm-6.433,1.767l-2.733,-1.267l2.733,-1.267l1.267,-2.733l1.266,2.733l2.734,1.267l-2.734,1.267l-1.266,2.733l-1.267,-2.733Z",
  tool: "M6 19h6v-1H6zm.75-9h4.5q.3 0 .525-.225T12 9.25t-.225-.525t-.525-.225h-4.5q-.3 0-.525.225T6 9.25t.225.525t.525.225m0-2.5h4.5q.3 0 .525-.225T12 6.75t-.225-.525T11.25 6h-4.5q-.3 0-.525.225T6 6.75t.225.525t.525.225M16 11V9h2V7h-2V5h2q.825 0 1.413.588T20 7h2q.425 0 .713.288T23 8t-.288.713T22 9h-2q0 .825-.587 1.413T18 11zm-4 5h-2v-5h4V5H6q-.825 0-1.412.588T4 7v2q0 .825.588 1.413T6 11h2v5H6v-3q-1.65 0-2.825-1.175T2 9V7q0-1.65 1.175-2.825T6 3h8q.825 0 1.413.588T16 5v6q0 .825-.587 1.413T14 13h-2zm-6.5 5q-.625 0-1.062-.437T4 19.5v-2q0-.625.438-1.062T5.5 16h7q.625 0 1.063.438T14 17.5v2q0 .625-.437 1.063T12.5 21zm6.5-2H6z",
};

const evccCarIcon = '<svg class="vehicle-icon" viewBox="0 0 48 48" fill="currentColor" aria-hidden="true"><circle cx="16" cy="26" r="2"></circle><circle cx="32" cy="26" r="2"></circle><path d="M42 18h-3.8c-.5-4.5-4.3-8.1-9-8.1H18.8c-4.7 0-8.5 3.6-9 8.1H6c-1.1 0-2 .9-2 2s.9 2 2 2h2.4c-.3.6-.4 1.3-.4 2v10.4c.2 2 1.9 3.6 4 3.6s3.8-1.6 4-3.6V34h16v.4c.2 2 1.9 3.6 4 3.6s3.8-1.6 4-3.6V24c0-.7-.1-1.4-.3-2H42c1.1 0 2-.9 2-2s-.9-2-2-2zm-23.2-4.1h10.5c2.4 0 4.5 1.7 4.9 4.1H13.8c.5-2.4 2.5-4.1 5-4.1zM14 30c-1.1 0-2-.9-2-2v-4c0-1.1.9-2 2-2h20c1.1 0 2 .9 2 2v4c0 1.1-.9 2-2 2H14z"></path></svg>';

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
  if (name === "car") return evccCarIcon;
  const path = Object.prototype.hasOwnProperty.call(evccVehicleIconPaths, name)
    ? evccVehicleIconPaths[name]
    : null;
  if (!path) return evccCarIcon;
  const viewBox = name === "smartconsumer" ? "0 0 32 32" : "0 0 24 24";
  return `<svg class="vehicle-icon" viewBox="${viewBox}" aria-hidden="true"><path fill="currentColor" d="${path}"></path></svg>`;
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
