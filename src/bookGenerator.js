/* ------------------------------------------------------------------ *
 *  Bindary — procedural book generator
 *  Every book is deterministic: the same seed always regenerates the
 *  same tier / genre / subgenre / collection / visual style / title /
 *  poem. Nothing here needs to be stored except the seed itself — the
 *  book object we persist is just a cache of one deterministic roll.
 *
 *  Structural space: 7 tiers × 25 genres × 10 subgenres × 20 collections
 *  × 20 visual styles × 10 title structures × 15 poem structures × 2
 *  modifiers = 210,000,000,000 distinct structural combinations, before
 *  the per-genre vocabulary pools multiply it further.
 * ------------------------------------------------------------------ */

/* ---------- tiny deterministic PRNG helpers (shared shape with the app) ---------- */
function hashInt(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}
function mulberry(seed) {
  return function () {
    seed |= 0; seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function pick(list, rand) { return list[Math.floor(rand() * list.length)]; }
function pickWeighted(list, rand) {
  const total = list.reduce((s, x) => s + x.weight, 0);
  let x = rand() * total;
  for (const item of list) { if ((x -= item.weight) < 0) return item; }
  return list[list.length - 1];
}
function pluralize(word) {
  if (/[sxz]$|[cs]h$/i.test(word)) return word + "es";
  if (/[^aeiou]y$/i.test(word)) return word.replace(/y$/i, "ies");
  return word + "s";
}
/* "he crosses" -> "they cross" — de-conjugates a genre verb pool entry (only ever 3rd-person-singular) so it can pair with a plural subject */
function baseVerb(v) {
  const [first, ...rest] = v.split(" ");
  let base = first;
  if (/(ss|sh|ch|x|z|o)es$/i.test(first)) base = first.slice(0, -2);
  else if (/[^aeiou]ies$/i.test(first)) base = first.replace(/ies$/i, "y");
  else if (/s$/i.test(first) && !/ss$/i.test(first)) base = first.slice(0, -1);
  return [base, ...rest].join(" ");
}
const aOrAn = (word) => (/^[aeiou]/i.test(word) ? "An" : "A");
const titleCase = (s) => s.replace(/\w\S*/g, (w) => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase());

/* ================================================================== *
 *  1. TIERS (7)
 * ================================================================== */
export const TIERS = [
  { key: "common",    name: "Common",    weight: 5000, color: "#C7BB99", ink: "#6E6344", rank: 0 },
  { key: "uncommon",  name: "Uncommon",  weight: 2500, color: "#8FB0A6", ink: "#3E6B5E", rank: 1 },
  { key: "rare",      name: "Rare",      weight: 1200, color: "#8FB6E6", ink: "#33608F", rank: 2 },
  { key: "epic",      name: "Epic",      weight: 700,  color: "#B48FE6", ink: "#6B3F94", rank: 3 },
  { key: "legendary", name: "Legendary", weight: 400,  color: "#E6C976", ink: "#8A6A1E", rank: 4 },
  { key: "mythic",    name: "Mythic",    weight: 150,  color: "#E68F8F", ink: "#943F3F", rank: 5 },
  { key: "relic",     name: "Relic",     weight: 50,   color: "#F2DE9A", ink: "#96690F", rank: 6 },
];
export const TIER_RANK = Object.fromEntries(TIERS.map((t) => [t.key, t.rank]));
export const tierOf = (key) => TIERS.find((t) => t.key === key) || TIERS[0];

/* legacy 5-tier -> new 7-tier, for books saved before this system existed */
const LEGACY_TIER_MAP = { common: "common", uncommon: "uncommon", rare: "rare", fine: "legendary", first: "relic" };
export function migrateLegacyRarity(oldKey) {
  if (TIERS.some((t) => t.key === oldKey)) return oldKey; // already a current tier key
  return LEGACY_TIER_MAP[oldKey] || "common";
}

/* ================================================================== *
 *  2. GENRES (25) — each with 10 subgenres and its own word pools
 * ================================================================== */
export const GENRES = [
  { key: "fantasy", label: "Fantasy",
    subgenres: ["High Fantasy", "Dark Fantasy", "Lost Kingdoms", "Dragons", "Enchanted Forests", "Wizards", "Magical Creatures", "Ancient Magic", "Cursed Realms", "Heroic Fantasy"],
    palette: [{ bg: "#4A2F52", cap: "#35213B" }, { bg: "#2C4A3B", cap: "#1F3529" }],
    adjectives: ["Ancient", "Enchanted", "Forgotten", "Cursed", "Silver", "Shattered", "Sworn", "Hidden", "Golden", "Wild", "Last", "Ember-lit"],
    nouns: ["Kingdom", "Blade", "Crown", "Dragon", "Grimoire", "Throne", "Oath", "Relic", "Wizard", "Realm", "Spell", "Banner"],
    verbs: ["reigns", "awakens", "guards", "remembers", "falls", "rises", "binds", "wanders"],
    locations: ["Everdark", "the Silver Vale", "the Lost Court", "the Ashen Wood", "the Old Spire", "the Fae Border", "the Iron Keep", "the Hollow Crown"],
    concepts: ["Destiny", "Ruin", "Wonder", "the Old Ways", "Betrayal", "Legacy"] },

  { key: "scifi", label: "Science Fiction",
    subgenres: ["Cyberpunk", "Artificial Intelligence", "Distant Future", "Alien Worlds", "Robotics", "Genetic Engineering", "Post-Human", "Virtual Reality", "Dystopian Future", "First Contact"],
    palette: [{ bg: "#26374F", cap: "#1A2839" }, { bg: "#3A4351", cap: "#29303B" }],
    adjectives: ["Synthetic", "Distant", "Encoded", "Fractured", "Neon", "Silent", "Recursive", "Forgotten", "Digital", "Cold", "Wired", "Last"],
    nouns: ["Signal", "Circuit", "Colony", "Android", "Protocol", "Station", "Core", "Frequency", "Uplink", "Drive", "Network", "Vessel"],
    verbs: ["transmits", "boots", "drifts", "calculates", "reroutes", "wakes", "fails", "connects"],
    locations: ["the Dead Grid", "Sector Nine", "the Null Zone", "the Orbit Ring", "the Server Vault", "the Edge Colony", "the Dark Terminal", "the Old Uplink"],
    concepts: ["Singularity", "Entropy", "the Signal", "Recursion", "Obsolescence", "Continuity"] },

  { key: "adventure", label: "Adventure",
    subgenres: ["Lost Expeditions", "Treasure Hunts", "Wilderness", "Ancient Ruins", "Voyages", "Survival", "Mountain Expeditions", "Underground Worlds", "Island Adventures", "Great Journeys"],
    palette: [{ bg: "#7A3E24", cap: "#5A2C18" }, { bg: "#6E5230", cap: "#4E3A20" }],
    adjectives: ["Uncharted", "Weathered", "Restless", "Bold", "Far-flung", "Wild", "Salt-worn", "Forgotten", "Rugged", "Endless"],
    nouns: ["Compass", "Trail", "Expedition", "Summit", "Map", "Camp", "Horizon", "Ruin", "Passage", "Ridge"],
    verbs: ["climbs", "ventures", "crosses", "discovers", "presses on", "camps", "charts", "endures"],
    locations: ["the Far Ridge", "the Lost Pass", "the Wide Country", "the Broken Trail", "the Iron Coast", "the Deep Range", "the Last Camp", "the Wild Frontier"],
    concepts: ["the Unknown", "Resolve", "the Journey", "Discovery", "Wanderlust", "Nerve"] },

  { key: "mystery", label: "Mystery",
    subgenres: ["Unsolved Cases", "Secret Societies", "Missing People", "Hidden Rooms", "Ancient Mysteries", "Strange Objects", "Forgotten Places", "Codes & Ciphers", "Supernatural Mystery", "Detective Tales"],
    palette: [{ bg: "#3A3A46", cap: "#282833" }, { bg: "#4E2A2E", cap: "#371D20" }],
    adjectives: ["Unsolved", "Hidden", "Quiet", "Coded", "Locked", "Missing", "Whispered", "Shadowed", "Careful", "Cold"],
    nouns: ["Case", "Clue", "Cipher", "Room", "Witness", "Ledger", "Key", "Letter", "Alibi", "Shadow"],
    verbs: ["vanishes", "conceals", "unravels", "watches", "waits", "whispers", "disappears", "returns"],
    locations: ["the Locked Room", "the Quiet Street", "the Old Office", "the Back Archive", "the Grey House", "the Empty Platform", "the Sealed Vault", "the Cold Case File"],
    concepts: ["the Truth", "Suspicion", "Silence", "the Missing Hour", "Doubt", "the Answer"] },

  { key: "horror", label: "Horror",
    subgenres: ["Gothic Horror", "Cosmic Horror", "Haunted Places", "Monsters", "Psychological Horror", "Curses", "Ghost Stories", "Dark Forests", "Ancient Evil", "Unexplained Horror"],
    palette: [{ bg: "#4E2A2E", cap: "#2A1214" }, { bg: "#2A2E2A", cap: "#181A18" }],
    adjectives: ["Ancient", "Unspeakable", "Hollow", "Cursed", "Feral", "Drowned", "Pale", "Nameless", "Creeping", "Cold"],
    nouns: ["Curse", "Shadow", "Hollow", "Whisper", "Grave", "Omen", "Dread", "Specter", "Ritual", "Bone"],
    verbs: ["stalks", "lingers", "whispers", "watches", "creeps", "haunts", "wakes", "consumes"],
    locations: ["the Hollow House", "the Dead Wood", "the Forgotten Crypt", "the Black Hour", "the Silent Attic", "the Buried Chapel", "the Long Corridor", "the Empty Cellar"],
    concepts: ["Dread", "the Unseen", "Madness", "the Dark", "Ruin", "the Omen"] },

  { key: "nature", label: "Nature",
    subgenres: ["Forests", "Mountains", "Rivers", "Deserts", "Meadows", "Rainforests", "Seasons", "Storms", "Flowers", "Wilderness"],
    palette: [{ bg: "#2E4633", cap: "#203223" }, { bg: "#3E4A2A", cap: "#2B341C" }],
    adjectives: ["Quiet", "Wild", "Blooming", "Ancient", "Mossy", "Sunlit", "Windswept", "Frost-touched", "Green", "Tangled"],
    nouns: ["Forest", "River", "Meadow", "Root", "Bark", "Bloom", "Stone", "Canopy", "Fern", "Storm"],
    verbs: ["grows", "drifts", "blooms", "settles", "breathes", "shelters", "gathers", "turns"],
    locations: ["the Old Grove", "the Wide Meadow", "the Quiet Stream", "the High Ridge", "the Green Hollow", "the Deep Woods", "the Open Field", "the River Bend"],
    concepts: ["Growth", "Season", "Stillness", "the Wild", "Renewal", "Balance"] },

  { key: "ocean", label: "Ocean",
    subgenres: ["Deep Sea", "Coral Reefs", "Islands", "Sailors", "Sea Creatures", "Shipwrecks", "Tides", "Underwater Kingdoms", "Coastal Tales", "Ocean Exploration"],
    palette: [{ bg: "#26374F", cap: "#1A2839" }, { bg: "#1F4148", cap: "#142E33" }],
    adjectives: ["Sunken", "Drowned", "Silent", "Abyssal", "Forgotten", "Midnight", "Tidal", "Endless", "Salt-worn", "Deep"],
    nouns: ["Leviathan", "Mariner", "Reef", "Tide", "Trench", "Pearl", "Lighthouse", "Current", "Anchor", "Shell"],
    verbs: ["drifts", "sinks", "surfaces", "swells", "drowns", "glimmers", "calls", "returns"],
    locations: ["the Abyss", "the Black Sea", "the Coral Kingdom", "the Drowned Coast", "the Ocean Floor", "the Salt Current", "the Sunken Reef", "the Far Shore"],
    concepts: ["the Deep", "the Tide", "Drift", "Stillness", "Depth", "the Current"] },

  { key: "space", label: "Space",
    subgenres: ["Stars", "Planets", "Galaxies", "Black Holes", "Nebulae", "Astronauts", "Space Stations", "Alien Civilisations", "Cosmic Mysteries", "Interstellar Travel"],
    palette: [{ bg: "#2A2E5A", cap: "#1D2040" }, { bg: "#1F2A44", cap: "#141C30" }],
    adjectives: ["Distant", "Silent", "Infinite", "Frozen", "Burning", "Ancient", "Drifting", "Hollow", "Dark", "Endless"],
    nouns: ["Star", "Nebula", "Comet", "Void", "Orbit", "Galaxy", "Horizon", "Signal", "Station", "Constellation"],
    verbs: ["drifts", "burns", "collapses", "orbits", "fades", "ignites", "wanders", "echoes"],
    locations: ["the Dark Between", "the Outer Rim", "the Dead Star", "the Long Orbit", "the Silent Reach", "the Edge of Light", "the Drift Field", "the Last Nebula"],
    concepts: ["the Void", "Infinity", "Gravity", "the Unknown", "Distance", "Silence"] },

  { key: "mythology", label: "Mythology",
    subgenres: ["Greek", "Norse", "Egyptian", "Celtic", "Japanese", "Mesopotamian", "Roman", "Arthurian", "Legendary Creatures", "Forgotten Gods"],
    palette: [{ bg: "#5C5323", cap: "#433C18" }, { bg: "#6E5230", cap: "#4E3A20" }],
    adjectives: ["Ancient", "Sacred", "Forgotten", "Divine", "Cursed", "Eternal", "Golden", "Fallen", "Old", "Undying"],
    nouns: ["God", "Oracle", "Titan", "Temple", "Fate", "Prophecy", "Altar", "Legend", "Vow", "Throne"],
    verbs: ["decrees", "watches", "falls", "ascends", "binds", "remembers", "judges", "endures"],
    locations: ["the Old Temple", "the Sacred Grove", "the Sunken Shrine", "the Golden Hall", "the Forgotten Altar", "the Endless Court", "the High Peak", "the Silent Oracle"],
    concepts: ["Fate", "the Divine", "Legacy", "Judgment", "Prophecy", "Eternity"] },

  { key: "history", label: "History",
    subgenres: ["Ancient Civilisations", "Medieval Worlds", "Renaissance", "Exploration Age", "Industrial Age", "Lost Empires", "Historical Figures", "Ancient Cities", "Archaeology", "Forgotten Events"],
    palette: [{ bg: "#6E5230", cap: "#4E3A20" }, { bg: "#5C5323", cap: "#433C18" }],
    adjectives: ["Ancient", "Forgotten", "Lost", "Weathered", "Faded", "Buried", "Distant", "Enduring", "Old", "Storied"],
    nouns: ["Empire", "Archive", "Ruin", "Chronicle", "Dynasty", "Relic", "Monument", "Record", "Ledger", "Seal"],
    verbs: ["falls", "endures", "fades", "remains", "crumbles", "records", "survives", "echoes"],
    locations: ["the Old Capital", "the Fallen Empire", "the Buried City", "the Long Archive", "the Ancient Court", "the Lost Province", "the Marble Hall", "the Sealed Vault"],
    concepts: ["Legacy", "the Past", "Memory", "Ruin", "Record", "Continuity"] },

  { key: "folklore", label: "Folklore",
    subgenres: ["Fairy Tales", "Urban Legends", "Village Stories", "Spirits", "Folk Heroes", "Magical Creatures", "Superstitions", "Campfire Tales", "Oral Traditions", "Forgotten Legends"],
    palette: [{ bg: "#7A3E24", cap: "#5A2C18" }, { bg: "#3E4A2A", cap: "#2B341C" }],
    adjectives: ["Old", "Whispered", "Half-remembered", "Rustic", "Woven", "Enduring", "Told", "Homespun", "Familiar", "Ageless"],
    nouns: ["Tale", "Spirit", "Hearth", "Charm", "Legend", "Village", "Elder", "Custom", "Fireside", "Omen"],
    verbs: ["warns", "whispers", "remembers", "protects", "wanders", "returns", "tells", "endures"],
    locations: ["the Old Hearth", "the Quiet Village", "the Crossroads", "the Elder Wood", "the Fireside Circle", "the Winding Path", "the Sleeping Hollow", "the Forgotten Well"],
    concepts: ["Custom", "Memory", "Warning", "the Told Tale", "Tradition", "Wonder"] },

  { key: "dreams", label: "Dreams",
    subgenres: ["Lucid Dreams", "Nightmares", "Dream Worlds", "Flying Dreams", "Endless Places", "Strange Dreams", "Childhood Dreams", "Prophetic Dreams", "Surreal Dreams", "Forgotten Dreams"],
    palette: [{ bg: "#432A4A", cap: "#301D36" }, { bg: "#2A2E5A", cap: "#1D2040" }],
    adjectives: ["Fading", "Lucid", "Endless", "Strange", "Weightless", "Half-remembered", "Drifting", "Silver", "Soft", "Unreal"],
    nouns: ["Dream", "Sleep", "Vision", "Horizon", "Mirror", "Cloud", "Threshold", "Echo", "Corridor", "Veil"],
    verbs: ["drifts", "dissolves", "remembers", "floats", "fades", "wanders", "opens", "folds"],
    locations: ["the Endless Room", "the Grey Threshold", "the Dream Shore", "the Quiet Fold", "the Silver Corridor", "the Floating Stair", "the Last Doorway", "the Soft Horizon"],
    concepts: ["Memory", "the Unreal", "Wonder", "Sleep", "the Threshold", "Wandering"] },

  { key: "magic", label: "Magic",
    subgenres: ["Alchemy", "Elemental Magic", "Runes", "Potions", "Spellcraft", "Magical Objects", "Forbidden Magic", "Healing Magic", "Illusions", "Ancient Spells"],
    palette: [{ bg: "#432A4A", cap: "#301D36" }, { bg: "#5C5323", cap: "#433C18" }],
    adjectives: ["Arcane", "Ancient", "Woven", "Forbidden", "Radiant", "Hidden", "Sacred", "Bound", "Quiet", "Unstable"],
    nouns: ["Spell", "Rune", "Potion", "Charm", "Grimoire", "Circle", "Flame", "Sigil", "Ember", "Vial"],
    verbs: ["binds", "ignites", "weaves", "conjures", "seals", "awakens", "glows", "unravels"],
    locations: ["the Old Workshop", "the Rune Circle", "the Hidden Study", "the Ember Vault", "the Sealed Library", "the Glass Tower", "the Quiet Sanctum", "the Forbidden Shelf"],
    concepts: ["Power", "the Unseen", "Balance", "the Old Ways", "Transformation", "Will"] },

  { key: "animals", label: "Animals",
    subgenres: ["Birds", "Wolves", "Cats", "Dogs", "Horses", "Insects", "Marine Animals", "Mythical Animals", "Wild Animals", "Extinct Animals"],
    palette: [{ bg: "#6E5230", cap: "#4E3A20" }, { bg: "#2E4633", cap: "#203223" }],
    adjectives: ["Wild", "Silent", "Feral", "Gentle", "Swift", "Ancient", "Free", "Watchful", "Restless", "Loyal"],
    nouns: ["Wolf", "Sparrow", "Stag", "Hound", "Den", "Nest", "Pack", "Feather", "Paw", "Antler"],
    verbs: ["roams", "watches", "hunts", "shelters", "calls", "returns", "follows", "rests"],
    locations: ["the Old Den", "the Wide Field", "the Quiet Wood", "the High Nest", "the Winter Burrow", "the Open Plain", "the Tall Grass", "the Riverbank"],
    concepts: ["Instinct", "the Wild", "Loyalty", "Freedom", "Kinship", "Survival"] },

  { key: "cities", label: "Cities",
    subgenres: ["Ancient Cities", "Futuristic Cities", "Hidden Cities", "Underground Cities", "Floating Cities", "Abandoned Cities", "Night Cities", "Megacities", "Small Towns", "Impossible Cities"],
    palette: [{ bg: "#3A3A46", cap: "#282833" }, { bg: "#26374F", cap: "#1A2839" }],
    adjectives: ["Sleepless", "Forgotten", "Towering", "Hidden", "Neon-lit", "Ancient", "Crowded", "Quiet", "Endless", "Grey"],
    nouns: ["Skyline", "Street", "Alley", "Tower", "Rooftop", "District", "Bridge", "Square", "Platform", "Corner"],
    verbs: ["hums", "sprawls", "glows", "empties", "gathers", "rises", "sleeps", "wakes"],
    locations: ["the Old District", "the Lower Bridge", "the High Street", "the Night Market", "the Back Alley", "the Rooftop Line", "the Empty Platform", "the Far Suburb"],
    concepts: ["the City", "Anonymity", "Motion", "Belonging", "Noise", "Distance"] },

  { key: "technology", label: "Technology",
    subgenres: ["Computers", "Robotics", "Programming", "Networks", "Machines", "Inventions", "Cybersecurity", "Digital Worlds", "Engineering", "Future Technology"],
    palette: [{ bg: "#3A4351", cap: "#29303B" }, { bg: "#26374F", cap: "#1A2839" }],
    adjectives: ["Digital", "Wired", "Silent", "Precise", "Encoded", "Cold", "Recursive", "Bright", "Automated", "Exact"],
    nouns: ["Machine", "Circuit", "Code", "Network", "Screen", "Signal", "Server", "Interface", "Gear", "Wire"],
    verbs: ["computes", "connects", "updates", "boots", "syncs", "fails", "reroutes", "hums"],
    locations: ["the Server Room", "the Old Lab", "the Grid", "the Dead Terminal", "the Wire Closet", "the Test Bench", "the Dark Rack", "the Patch Bay"],
    concepts: ["Precision", "the Signal", "Progress", "Automation", "Logic", "Efficiency"] },

  { key: "science", label: "Science",
    subgenres: ["Physics", "Chemistry", "Biology", "Astronomy", "Geology", "Mathematics", "Medicine", "Ecology", "Neuroscience", "Quantum Science"],
    palette: [{ bg: "#21514E", cap: "#173B39" }, { bg: "#3A4351", cap: "#29303B" }],
    adjectives: ["Precise", "Curious", "Measured", "Unseen", "Vast", "Careful", "Bright", "Patient", "Exact", "Quiet"],
    nouns: ["Theorem", "Element", "Cell", "Orbit", "Equation", "Specimen", "Reaction", "Field", "Sample", "Constant"],
    verbs: ["proves", "measures", "reveals", "tests", "observes", "calculates", "discovers", "balances"],
    locations: ["the Old Laboratory", "the Quiet Field", "the Deep Field", "the Study", "the Clean Room", "the Long Bench", "the Dim Observatory", "the Sample Vault"],
    concepts: ["Discovery", "Truth", "Precision", "Wonder", "Method", "Pattern"] },

  { key: "exploration", label: "Exploration",
    subgenres: ["Polar Exploration", "Deep Ocean", "Space Exploration", "Jungle Expeditions", "Desert Expeditions", "Cave Exploration", "Ancient Ruins", "Mountain Exploration", "Unknown Lands", "Scientific Expeditions"],
    palette: [{ bg: "#1F4148", cap: "#142E33" }, { bg: "#7A3E24", cap: "#5A2C18" }],
    adjectives: ["Uncharted", "Frozen", "Remote", "Unmapped", "Distant", "Bold", "Weathered", "Vast", "Silent", "Untouched"],
    nouns: ["Compass", "Expedition", "Frontier", "Camp", "Summit", "Trail", "Map", "Horizon", "Ridge", "Base"],
    verbs: ["charts", "ventures", "discovers", "crosses", "endures", "presses on", "maps", "returns"],
    locations: ["the Frozen Reach", "the Unmapped Coast", "the Far Frontier", "the Deep Field", "the White Expanse", "the Last Camp", "the Hidden Valley", "the Silent Range"],
    concepts: ["the Unknown", "Discovery", "Endurance", "the Frontier", "Distance", "Nerve"] },

  { key: "time", label: "Time",
    subgenres: ["Past", "Future", "Time Travel", "Time Loops", "Lost Time", "Alternate Timelines", "Eternal Moments", "Ageing", "Seasons of Time", "End of Time"],
    palette: [{ bg: "#6E5230", cap: "#4E3A20" }, { bg: "#2A2E5A", cap: "#1D2040" }],
    adjectives: ["Fleeting", "Eternal", "Lost", "Endless", "Fading", "Ancient", "Sudden", "Slow", "Quiet", "Unhurried"],
    nouns: ["Hour", "Clock", "Season", "Moment", "Age", "Echo", "Thread", "Horizon", "Calendar", "Bell"],
    verbs: ["passes", "fades", "returns", "lingers", "unwinds", "waits", "repeats", "ends"],
    locations: ["the Last Hour", "the Old Clocktower", "the Long Season", "the Quiet Age", "the Turning Point", "the Far Tomorrow", "the Still Minute", "the Closing Hour"],
    concepts: ["Memory", "the Present", "Eternity", "Change", "Patience", "the Moment"] },

  { key: "memory", label: "Memory",
    subgenres: ["Childhood", "Forgotten Memories", "Lost People", "Places Remembered", "Nostalgia", "Dreams Remembered", "Family Stories", "Fading Memory", "Recovered Memory", "Collective Memory"],
    palette: [{ bg: "#6E5230", cap: "#4E3A20" }, { bg: "#4A2F52", cap: "#35213B" }],
    adjectives: ["Fading", "Half-remembered", "Warm", "Distant", "Faded", "Quiet", "Familiar", "Lost", "Gentle", "Worn"],
    nouns: ["Photograph", "Hallway", "Voice", "Room", "Letter", "Name", "Face", "Echo", "Doorway", "Keepsake"],
    verbs: ["remembers", "fades", "lingers", "returns", "forgets", "holds", "keeps", "recalls"],
    locations: ["the Old Hallway", "the Childhood House", "the Quiet Room", "the Familiar Street", "the Back Garden", "the Kitchen Table", "the Front Porch", "the Attic Box"],
    concepts: ["Nostalgia", "the Past", "Belonging", "Loss", "Comfort", "Recollection"] },

  { key: "philosophy", label: "Philosophy",
    subgenres: ["Existence", "Knowledge", "Morality", "Consciousness", "Reality", "Identity", "Freedom", "Meaning", "Death", "Happiness"],
    palette: [{ bg: "#3A3A46", cap: "#282833" }, { bg: "#5C5323", cap: "#433C18" }],
    adjectives: ["Quiet", "Unanswered", "Vast", "Careful", "Honest", "Uncertain", "Bare", "Enduring", "Plain", "Patient"],
    nouns: ["Question", "Mind", "Truth", "Reason", "Doubt", "Self", "Meaning", "Silence", "Argument", "Premise"],
    verbs: ["questions", "considers", "doubts", "seeks", "understands", "wonders", "holds", "examines"],
    locations: ["the Quiet Study", "the Long Argument", "the Empty Room", "the Still Hour", "the Bare Table", "the Open Question", "the Narrow Path", "the Wide Silence"],
    concepts: ["Truth", "Meaning", "Doubt", "Existence", "Reason", "the Self"] },

  { key: "art", label: "Art",
    subgenres: ["Painting", "Sculpture", "Architecture", "Photography", "Illustration", "Street Art", "Digital Art", "Ancient Art", "Abstract Art", "Lost Masterpieces"],
    palette: [{ bg: "#8A4A34", cap: "#652F1F" }, { bg: "#2A2E5A", cap: "#1D2040" }],
    adjectives: ["Unfinished", "Vivid", "Quiet", "Bold", "Faded", "Hand-drawn", "Restless", "Luminous", "Careful", "Raw"],
    nouns: ["Canvas", "Brush", "Frame", "Sketch", "Gallery", "Palette", "Line", "Studio", "Easel", "Pigment"],
    verbs: ["paints", "sketches", "frames", "captures", "reveals", "blends", "shapes", "lingers"],
    locations: ["the Old Studio", "the Quiet Gallery", "the Back Room", "the Sunlit Window", "the Cluttered Bench", "the Empty Frame", "the Corner Easel", "the North Light"],
    concepts: ["Beauty", "Expression", "the Unfinished", "Vision", "Form", "Colour"] },

  { key: "music", label: "Music",
    subgenres: ["Classical", "Jazz", "Folk", "Electronic", "Instruments", "Lost Songs", "Musicians", "Soundscapes", "Rhythm", "Silence"],
    palette: [{ bg: "#5A2540", cap: "#3F1A2D" }, { bg: "#6E5230", cap: "#4E3A20" }],
    adjectives: ["Quiet", "Rising", "Faint", "Steady", "Distant", "Bright", "Slow", "Restless", "Soft", "Unresolved"],
    nouns: ["Melody", "Chord", "Silence", "Instrument", "Rhythm", "Note", "Song", "Echo", "Refrain", "Verse"],
    verbs: ["plays", "fades", "rises", "hums", "echoes", "lingers", "resolves", "drifts"],
    locations: ["the Empty Hall", "the Old Studio", "the Back Room", "the Quiet Stage", "the Practice Room", "the Last Set", "the Open Mic", "the Rehearsal Space"],
    concepts: ["Rhythm", "Silence", "Harmony", "the Unheard", "Timing", "Resonance"] },

  { key: "romance", label: "Romance",
    subgenres: ["First Love", "Lost Love", "Eternal Love", "Forbidden Love", "Long Distance", "Reunion", "Unspoken Love", "Friendship to Love", "Magical Romance", "Bittersweet Love"],
    palette: [{ bg: "#5A2540", cap: "#3F1A2D" }, { bg: "#6E2B2B", cap: "#521E1E" }],
    adjectives: ["Quiet", "Tender", "Unspoken", "Bittersweet", "Warm", "Fleeting", "Gentle", "Certain", "Patient", "Soft"],
    nouns: ["Letter", "Glance", "Hand", "Doorway", "Evening", "Promise", "Heart", "Distance", "Window", "Photograph"],
    verbs: ["waits", "returns", "remembers", "holds", "reaches", "lingers", "hopes", "stays"],
    locations: ["the Old Café", "the Quiet Platform", "the Garden Gate", "the Late Evening", "the Corner Table", "the Long Walk Home", "the Open Window", "the Familiar Street"],
    concepts: ["Longing", "Devotion", "the Unspoken", "Belonging", "Patience", "Hope"] },

  { key: "abstract", label: "Abstract",
    subgenres: ["Colours", "Shapes", "Emotions", "Numbers", "Patterns", "Silence", "Chaos", "Light", "Darkness", "Infinity"],
    palette: [{ bg: "#3A3A46", cap: "#282833" }, { bg: "#5A2540", cap: "#3F1A2D" }],
    adjectives: ["Formless", "Bright", "Hollow", "Endless", "Fractured", "Still", "Sudden", "Quiet", "Exact", "Uneven"],
    nouns: ["Shape", "Colour", "Silence", "Pattern", "Number", "Light", "Shadow", "Chaos", "Form", "Line"],
    verbs: ["shifts", "dissolves", "forms", "repeats", "folds", "scatters", "holds", "becomes"],
    locations: ["the Empty Field", "the Fractured Frame", "the Still Point", "the Wide Blank", "the Open Grid", "the Broken Line", "the Even Space", "the Sudden Edge"],
    concepts: ["Order", "Chaos", "Form", "the Infinite", "Pattern", "Balance"] },
];
export const GENRE_KEYS = GENRES.map((g) => g.key);
export const genreOf = (key) => GENRES.find((g) => g.key === key) || GENRES[0];

/* shared, genre-agnostic finishing touches (kept small on purpose — these read fine against any genre) */
const ACCENTS = ["amber", "ash", "copper", "mist", "violet", "cedar", "opal", "sable", "moss", "linden", "pearl", "smoke", "indigo", "bronze", "chalk", "teal"];
const PAPER_TONES = ["ivory", "bone", "fog", "old gold", "cream", "ash white", "eggshell", "pale sand"];
const EDGE_TINTS = ["copper", "indigo", "emerald", "wine", "amber", "graphite", "teal", "rose ash"];

/* ================================================================== *
 *  3. COLLECTIONS (20)
 * ================================================================== */
export const COLLECTIONS = [
  "Tales From Beyond", "The Forgotten Library", "Chronicles of the Unknown", "Whispers Collection", "The Hidden Archives",
  "Stories of Old", "The Endless Collection", "Lost Tales", "The Wanderer's Library", "Echoes Through Time",
  "The Secret Shelf", "Chronicles of Wonder", "The Midnight Library", "Tales Never Told", "The Ancient Archive",
  "The Explorer's Collection", "Worlds Between Worlds", "The Keeper's Library", "The Infinite Shelf", "The Last Collection",
];

/* ================================================================== *
 *  4. VISUAL STYLES (20) — each nudges the physical binding + spine glyphs
 * ================================================================== */
export const VISUAL_STYLES = [
  { label: "Classic Clothbound", glyphs: ["✦", "✧"] },
  { label: "Antique Leather", glyphs: ["✧", "◆"] },
  { label: "Modern Minimalist", glyphs: ["▣", "◇"] },
  { label: "Victorian Ornate", glyphs: ["✺", "✹"] },
  { label: "Art Deco", glyphs: ["◈", "▣"] },
  { label: "Gothic", glyphs: ["✹", "◆"] },
  { label: "Watercolour", glyphs: ["✦", "◇"] },
  { label: "Illustrated Storybook", glyphs: ["✧", "✦"] },
  { label: "Ancient Manuscript", glyphs: ["◆", "✺"] },
  { label: "Celestial", glyphs: ["✦", "✺"] },
  { label: "Botanical", glyphs: ["✧", "◇"] },
  { label: "Geometric", glyphs: ["▣", "◈"] },
  { label: "Metallic Foil", glyphs: ["✹", "✦"] },
  { label: "Dark Academia", glyphs: ["◆", "▣"] },
  { label: "Rustic Handmade", glyphs: ["◇", "✧"] },
  { label: "Futuristic Holographic", glyphs: ["◈", "✺"] },
  { label: "Parchment", glyphs: ["◇", "◆"] },
  { label: "Embossed Collector", glyphs: ["✹", "◈"] },
  { label: "Library Archive", glyphs: ["▣", "✦"] },
  { label: "Surrealist", glyphs: ["✺", "◇"] },
];

/* ================================================================== *
 *  5. TITLE STRUCTURES (10)
 * ================================================================== */
const TITLE_STRUCTURES = [
  (w, rand) => `The ${pick(w.adjectives, rand)} ${pick(w.nouns, rand)}`,
  (w, rand) => `The ${pick(w.nouns, rand)} of ${pick(w.locations, rand)}`,
  (w, rand) => { const n = pick(w.nouns, rand); return `${pick(w.locations, rand)}: ${aOrAn(n)} ${n}`; },
  (w, rand) => `Where the ${titleCase(pluralize(pick(w.nouns, rand)))} ${baseVerb(pick(w.verbs, rand))}`,
  (w, rand) => `Beyond the ${pick(w.adjectives, rand)} ${pick(w.nouns, rand)}`,
  (w, rand) => { const n = pick(w.nouns, rand); return `${aOrAn(n)} ${n} for ${pick(w.concepts, rand)}`; },
  (w, rand) => `The ${pick(w.nouns, rand)} Beneath the ${pick(w.nouns, rand)}`,
  (w, rand) => `When ${titleCase(pluralize(pick(w.nouns, rand)))} ${baseVerb(pick(w.verbs, rand))}`,
  (w, rand) => `${pick(w.adjectives, rand)} ${titleCase(pluralize(pick(w.nouns, rand)))}`,
  (w, rand) => `Of ${pick(w.nouns, rand)} and ${pick(w.nouns, rand)}`,
];

function generateTitle(w, rand) {
  const idx = Math.floor(rand() * TITLE_STRUCTURES.length);
  const raw = TITLE_STRUCTURES[idx](w, rand);
  return { title: titleCase(raw).slice(0, 64), titleStructureIndex: idx };
}

/* ================================================================== *
 *  6. POEM STRUCTURES (15)
 * ================================================================== */
export const POEM_STRUCTURES = [
  "Haiku", "Tanka", "Couplet", "Quatrain", "Two Quatrains",
  "Free Verse — Short", "Free Verse — Medium", "Free Verse — Long",
  "Rhyming AABB", "Rhyming ABAB", "Rhyming ABBA",
  "Acrostic", "Narrative Poem", "Prose Poem", "Fragment Poem",
];

/* short, true end-rhyme groups — genre-agnostic on purpose so the rhyme always lands cleanly */
const RHYME_GROUPS = [
  ["the work at last is done", "beneath a lowering sun", "before the day was won", "and now the hour's begun", "when every task is done"],
  ["I set it down tonight", "and everything felt light", "the page turned soft and bright", "held gently out of sight", "a quiet kind of light"],
  ["the promises I keep", "while the whole house lies asleep", "a debt too small to keep", "into a calm so deep", "the hours I did not weep"],
  ["I found my steady pace", "and gave the hour its place", "a softer, quieter face", "the calm took up the space", "a small and settled place"],
  ["I put the work away", "and let the evening stay", "the light began to grey", "I earned this quiet day", "there's nothing left to say"],
  ["the story now is told", "a shape I finally hold", "against the coming cold", "a moment bound in gold", "the ledger neatly told"],
  ["I won't repeat once more", "and closed the waiting door", "the same as those before", "a calmer, steadier floor", "what I was reaching for"],
  ["a stillness fills my mind", "the kind I rarely find", "the pieces intertwined", "a quiet left behind", "exactly as designed"],
];
function rhymeLine(rand, groupIdx, avoid) {
  const group = RHYME_GROUPS[groupIdx];
  let line = pick(group, rand);
  let guard = 0;
  while (line === avoid && guard++ < 6) line = pick(group, rand);
  return line;
}

const LETTER_STARTERS = {
  A: "Always", B: "Beneath", C: "Comes", D: "Down through", E: "Even now", F: "Far beyond", G: "Gently",
  H: "Held by", I: "In the quiet", J: "Just past", K: "Keeping still", L: "Long after", M: "Marked by",
  N: "Now and then", O: "Out past", P: "Passing through", Q: "Quietly", R: "Rising from", S: "Still, the",
  T: "Through the", U: "Under the", V: "Very near", W: "Where the", X: "Exactly where", Y: "Yet still", Z: "Ever so",
};

function genreLine(w, rand) {
  const templates = [
    () => `The ${pick(w.nouns, rand)} ${pick(w.verbs, rand)} beneath ${pick(w.locations, rand)}.`,
    () => { const adj = pick(w.adjectives, rand); return `${aOrAn(adj)} ${adj} ${pick(w.nouns, rand)} ${pick(w.verbs, rand)}.`; },
    () => `${pick(w.locations, rand)} holds its ${pick(w.adjectives, rand)} ${pick(w.nouns, rand)}.`,
    () => `Even the ${pick(w.nouns, rand)} ${pick(w.verbs, rand)} tonight.`,
    () => { const n = pick(w.nouns, rand); return `Somewhere, ${aOrAn(n).toLowerCase()} ${n} still ${pick(w.verbs, rand)}.`; },
  ];
  return pick(templates, rand)();
}

function buildPoem(structureName, w, rand, cleanTask, subgenre) {
  const closingLine = cleanTask
    ? `I finished ${cleanTask}, and the ${pick(w.nouns, rand)} ${pick(w.verbs, rand)} a little quieter for it.`
    : `The work is done, and the ${pick(w.nouns, rand)} ${pick(w.verbs, rand)} a little quieter for it.`;

  switch (structureName) {
    case "Haiku":
      return [genreLine(w, rand).replace(/\.$/, ""), `${pick(w.adjectives, rand)} ${pick(w.nouns, rand)}, ${pick(w.verbs, rand)}`, `${pick(w.locations, rand)} waits`].join("\n");

    case "Tanka":
      return Array.from({ length: 5 }, () => genreLine(w, rand)).join("\n");

    case "Couplet": {
      const g = Math.floor(rand() * RHYME_GROUPS.length);
      const a = rhymeLine(rand, g);
      const b = rhymeLine(rand, g, a);
      return [genreLine(w, rand), a, b].join("\n");
    }

    case "Quatrain":
      return Array.from({ length: 4 }, () => genreLine(w, rand)).join("\n");

    case "Two Quatrains":
      return [
        Array.from({ length: 4 }, () => genreLine(w, rand)).join("\n"),
        "",
        Array.from({ length: 4 }, () => genreLine(w, rand)).join("\n"),
      ].join("\n");

    case "Free Verse — Short":
      return Array.from({ length: 5 }, () => genreLine(w, rand)).join("\n");

    case "Free Verse — Medium":
      return [...Array.from({ length: 7 }, () => genreLine(w, rand)), closingLine].join("\n");

    case "Free Verse — Long":
      return [...Array.from({ length: 11 }, () => genreLine(w, rand)), closingLine].join("\n");

    case "Rhyming AABB": {
      const g1 = Math.floor(rand() * RHYME_GROUPS.length);
      let g2 = Math.floor(rand() * RHYME_GROUPS.length); if (g2 === g1) g2 = (g2 + 1) % RHYME_GROUPS.length;
      const a1 = rhymeLine(rand, g1), a2 = rhymeLine(rand, g1, a1);
      const b1 = rhymeLine(rand, g2), b2 = rhymeLine(rand, g2, b1);
      return [genreLine(w, rand), a1, a2, b1, b2].join("\n");
    }
    case "Rhyming ABAB": {
      const g1 = Math.floor(rand() * RHYME_GROUPS.length);
      let g2 = Math.floor(rand() * RHYME_GROUPS.length); if (g2 === g1) g2 = (g2 + 1) % RHYME_GROUPS.length;
      const a1 = rhymeLine(rand, g1), b1 = rhymeLine(rand, g2);
      const a2 = rhymeLine(rand, g1, a1), b2 = rhymeLine(rand, g2, b1);
      return [genreLine(w, rand), a1, b1, a2, b2].join("\n");
    }
    case "Rhyming ABBA": {
      const g1 = Math.floor(rand() * RHYME_GROUPS.length);
      let g2 = Math.floor(rand() * RHYME_GROUPS.length); if (g2 === g1) g2 = (g2 + 1) % RHYME_GROUPS.length;
      const a1 = rhymeLine(rand, g1), b1 = rhymeLine(rand, g2);
      const b2 = rhymeLine(rand, g2, b1), a2 = rhymeLine(rand, g1, a1);
      return [genreLine(w, rand), a1, b1, b2, a2].join("\n");
    }

    case "Acrostic": {
      const letters = (subgenre || "Bindary").replace(/[^a-zA-Z]/g, "").slice(0, 8).toUpperCase().split("");
      return letters.map((letter) => {
        const starter = LETTER_STARTERS[letter] || "Softly";
        return `${starter} ${pick(w.nouns, rand).toLowerCase()} ${pick(w.verbs, rand)}.`;
      }).join("\n");
    }

    case "Narrative Poem":
      return [
        genreLine(w, rand), genreLine(w, rand), genreLine(w, rand),
        `And then, the ${pick(w.nouns, rand)} ${pick(w.verbs, rand)}.`,
        genreLine(w, rand), genreLine(w, rand),
        closingLine,
        genreLine(w, rand), genreLine(w, rand),
      ].join("\n");

    case "Prose Poem":
      return Array.from({ length: 6 }, () => genreLine(w, rand)).join(" ");

    case "Fragment Poem":
      return [
        `${pick(w.adjectives, rand)} ${pick(w.nouns, rand)}…`,
        `${pick(w.verbs, rand)}, then still.`,
        `${pick(w.locations, rand)}.`,
        `${pick(w.concepts, rand)}, maybe.`,
        `…${pick(w.nouns, rand)}.`,
      ].join("\n");

    default:
      return Array.from({ length: 6 }, () => genreLine(w, rand)).join("\n");
  }
}

/* ================================================================== *
 *  7. THE GENERATOR
 * ================================================================== */
function cleanTaskText(task) {
  let t = (task || "").trim().replace(/[.!?;:,]+$/, "").toLowerCase();
  t = t.replace(/^(please\s+)?(go\s+)?(do|finish|complete|submit|hand in|study for|study|write|read|revise|prepare( for)?|work on|practice|practise|review|start|draft|edit|fix|make|build|plan)\s+/i, "");
  t = t.replace(/^(the|a|an|my|our|your|this|that|some)\s+/i, "");
  return t.trim();
}

/**
 * Fully deterministic: the same (seed, taskText, taskType) always produces
 * the exact same book. `seed` is the permanent book id — nothing about the
 * result needs to be stored except this seed, though we do persist the
 * resolved fields so the library can render/filter without recomputing.
 */
export function generateBook(seed, taskText, taskType) {
  const rand = mulberry(hashInt(`${seed}|${taskText}|${taskType}`));
  const clean = cleanTaskText(taskText);

  const tier = pickWeighted(TIERS, rand);
  const genre = pick(GENRES, rand);
  const subgenre = pick(genre.subgenres, rand);
  const collection = pick(COLLECTIONS, rand);
  const volume = 1 + Math.floor(rand() * 998);
  const visualStyle = pick(VISUAL_STYLES, rand);
  const modifier = rand() < 0.5 ? "standard" : "altered";
  const poemStructure = pick(POEM_STRUCTURES, rand);

  const { title, titleStructureIndex } = generateTitle(genre, rand);
  const poem = buildPoem(poemStructure, genre, rand, clean, subgenre);

  const cloth = pick(genre.palette, rand);
  const motif = pick(genre.nouns, rand).toLowerCase();
  const accent = pick(ACCENTS, rand);

  return {
    tier: tier.key,
    rarity: tier.key, // kept as `rarity` too — the rest of the app already reads book.rarity everywhere
    genre: genre.label,
    subgenre,
    collection,
    volume,
    visualStyle: visualStyle.label,
    modifier,
    titleStructureIndex,
    poemStructure,
    title,
    poem,

    clothBg: cloth.bg,
    clothCap: cloth.cap,
    motif,
    accent,
    bindingForm: visualStyle.label.toLowerCase(),
    paperTone: pick(PAPER_TONES, rand),
    edgeTint: pick(EDGE_TINTS, rand),
    classification: subgenre.toLowerCase(),
    seriesMark: `${String(Math.floor(rand() * 900) + 100)}-${String.fromCharCode(65 + Math.floor(rand() * 26))}${String.fromCharCode(65 + Math.floor(rand() * 26))}`,
    editionNote: `Filed under ${motif} in ${accent} light.`,
    spineMark: motif.slice(0, 1).toUpperCase(),
    spineShift: Math.floor(rand() * 16) - 8,
    spineTilt: Math.floor(rand() * 5) - 2,
    spineBands: 1 + Math.floor(rand() * 4),
    spineDivision: 1 + Math.floor(rand() * 3),
    spineGlyph: pick(visualStyle.glyphs, rand),
  };
}

/** one extra page for a completed subtask — same genre/tier voice as the book it joins */
export function generateSubtaskPage(seed, subtaskText, taskType, genreLabel) {
  const genre = GENRES.find((g) => g.label === genreLabel) || pick(GENRES, mulberry(hashInt(`${seed}|${subtaskText}`)));
  const rand = mulberry(hashInt(`${seed}|${subtaskText}|${taskType}|page`));
  const clean = cleanTaskText(subtaskText);
  const heading = titleCase(clean || subtaskText).slice(0, 60);
  const poemStructure = pick(["Free Verse — Short", "Haiku", "Couplet", "Fragment Poem"], rand);
  return { heading, poem: buildPoem(poemStructure, genre, rand, clean, null) };
}
