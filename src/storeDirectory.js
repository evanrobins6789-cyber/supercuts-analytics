// One-time input: the authoritative store code -> name lookup, taken from
// Book5.xlsx (the same source as leaderRoster.js). Used to match incoming
// files (like goal spreadsheets) that only have store NAMES, not codes,
// back to the right store — since different reports spell the same store
// differently (see the known aliases below).

export const STORE_CODE_TO_NAME = {
  "80591": "East Greenville",
  "81142": "Hatfield",
  "80618": "Upper Providence",
  "80694": "Whitehall",
  "80095": "Eagle",
  "80952": "Exton",
  "81038": "Havertown",
  "81772": "Villanova",
  "82025": "Granite Run",
  "82267": "Graylyn",
  "80212": "Media",
  "81516": "Enola",
  "82183": "Ephrata",
  "80180": "Harrisburg",
  "80014": "Sinking Spring",
  "81098": "West Lawn",
  "80577": "Bethlehem",
  "82993": "Broadcasting Sq",
  "80651": "Shillington",
  "8150": "Wyomissing",
  "80948": "Bensalem",
  "80147": "East Windsor",
  "81673": "Langhorne",
  "82818": "Nabisco",
  "80667": "Roxborough",
  "80719": "South Brunswick",
  "80554": "Douglassville",
  "80756": "Exeter",
  "8900": "Phoenixville",
  "80711": "Pottstown",
  "82734": "Bryn Mawr",
  "80108": "KOP",
  "81475": "Oaks",
  "8844": "Wynnewood",
  "81416": "Fairfax",
  "89080": "Parkesburg",
  "82262": "Valley View",
  "80185": "Frazer",
  "82179": "Malvern",
  "80661": "Bordentown",
  "81092": "Drexel",
  "8919": "Pennington",
  "81729": "East Brunswick",
  "80684": "Morrell",
  "80354": "Mullica Hill",
  "80358": "Plainsboro",
  "80306": "Kutztown",
  "80873": "Muhlenberg",
  "82831": "Trexlertown",
  "82223": "Bear",
  "82264": "Middletown",
  "81795": "Easton",
  "81219": "Madison Farms",
  "81036": "Schoenersville",
  "80417": "Devon",
  "8961": "Paoli",
  "80793": "Avondale",
  "82817": "Kennett Square",
  "82265": "Pike Creek",
};

// Known cases where a store is spelled differently across different report
// sources. Add to this list if a future file introduces a new alias.
const ALIASES = {
  'king of prussia': '80108',  // roster calls this "KOP"
  'kop': '80108',
  'broadcasting': '82993',     // roster calls this "Broadcasting Sq"
  'naamans': '82262',          // stylist report calls this "Valley View"
};

function normalize(name) {
  return String(name).replace(/[\s\u00a0]+/g, ' ').trim().toLowerCase();
}

const nameToCode = {};
Object.entries(STORE_CODE_TO_NAME).forEach(([code, name]) => {
  nameToCode[normalize(name)] = code;
});

// Returns the store code for a given store name, or null if no match —
// checks known aliases first, then the roster's own names.
export function getCodeForStoreName(name) {
  const n = normalize(name);
  if (ALIASES[n]) return ALIASES[n];
  if (nameToCode[n]) return nameToCode[n];
  return null;
}
