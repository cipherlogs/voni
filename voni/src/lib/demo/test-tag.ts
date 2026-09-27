/**
 * The Test tag (CONTEXT.md; docs/adr/0004-test-tag-email-matching.md): a
 * word in the call's language plus two digits ("Lime 42") that the visitor
 * puts in their email's subject, so Voni finds their email in the shared
 * inbox without anyone spelling an address aloud. A tag lives a day: the
 * browser keeps a signed token for it (call-token.ts) and the server
 * registry (`demo_test_tags`, test-tag-registry.ts) keeps it unique. Pure
 * and browser-safe: the call component imports it through email-test.ts.
 */

export const TAG_TTL_S = 24 * 60 * 60;

/** Short, easy-to-spell words per demo language, no accents (the visitor types them). */
export const TAG_WORDS: Record<string, string[]> = {
  en: [
    "Lime", "Wave", "Bolt", "Pine", "Coral", "Maple", "River", "Stone", "Cedar", "Anchor",
    "Delta", "Echo", "Falcon", "Harbor", "Jade", "Kite", "Lotus", "Mango", "Nova", "Olive",
    "Pepper", "Quartz", "Robin", "Sage", "Tiger", "Violet", "Willow", "Zebra", "Cobalt", "Ember",
    "Frost", "Hazel", "Iris", "Lemon", "Meadow", "Orbit", "Pebble", "Raven", "Summit", "Cloud",
  ],
  es: [
    "Lima", "Ola", "Pino", "Coral", "Rio", "Piedra", "Cedro", "Mango", "Oliva", "Tigre",
    "Sol", "Luna", "Nube", "Rayo", "Faro", "Isla", "Roble", "Palma", "Perla", "Brisa",
    "Cometa", "Delfin", "Fresa", "Hoja", "Jade", "Lince", "Menta", "Nieve", "Pluma", "Rosa",
    "Salvia", "Trueno", "Uva", "Vela", "Zorro", "Cielo", "Arena", "Bosque", "Canela", "Miel",
  ],
  fr: [
    "Citron", "Vague", "Pin", "Corail", "Fleuve", "Pierre", "Sapin", "Mangue", "Olive", "Tigre",
    "Soleil", "Lune", "Nuage", "Phare", "Plage", "Perle", "Brise", "Astre", "Dauphin", "Fraise",
    "Feuille", "Jade", "Lynx", "Menthe", "Neige", "Plume", "Rose", "Sauge", "Tonnerre", "Raisin",
    "Voile", "Renard", "Ciel", "Sable", "Bois", "Cannelle", "Orage", "Lilas", "Miel", "Cerise",
  ],
  de: [
    "Limette", "Welle", "Kiefer", "Koralle", "Fluss", "Stein", "Zeder", "Mango", "Olive", "Tiger",
    "Sonne", "Mond", "Wolke", "Blitz", "Turm", "Insel", "Eiche", "Palme", "Perle", "Brise",
    "Komet", "Delfin", "Beere", "Blatt", "Jade", "Luchs", "Minze", "Schnee", "Feder", "Rose",
    "Salbei", "Donner", "Traube", "Segel", "Fuchs", "Himmel", "Sand", "Wald", "Zimt", "Honig",
  ],
  it: [
    "Lime", "Onda", "Pino", "Corallo", "Fiume", "Pietra", "Cedro", "Mango", "Oliva", "Tigre",
    "Sole", "Luna", "Nuvola", "Lampo", "Faro", "Isola", "Quercia", "Palma", "Perla", "Brezza",
    "Cometa", "Delfino", "Fragola", "Foglia", "Giada", "Lince", "Menta", "Neve", "Piuma", "Rosa",
    "Salvia", "Tuono", "Uva", "Vela", "Volpe", "Cielo", "Sabbia", "Bosco", "Cannella", "Miele",
  ],
  pt: [
    "Lima", "Onda", "Pinho", "Coral", "Rio", "Pedra", "Cedro", "Manga", "Oliva", "Tigre",
    "Sol", "Lua", "Nuvem", "Raio", "Farol", "Ilha", "Carvalho", "Palma", "Brisa", "Cometa",
    "Golfinho", "Morango", "Folha", "Jade", "Lince", "Menta", "Neve", "Pena", "Rosa", "Uva",
    "Vela", "Raposa", "Areia", "Bosque", "Canela", "Mel", "Cereja", "Ameixa", "Figo", "Lobo",
  ],
};

/** A fresh tag in the call's language (English when unknown), skipping live ones (lowercased). */
export function pickTag(language: string, taken: Set<string>, random: () => number = Math.random): string {
  const words = TAG_WORDS[language] ?? TAG_WORDS.en;
  // 40 words × 90 numbers per language vs ~60 calls a day: a free tag comes
  // within a few draws; the cap only guards a registry gone wrong.
  for (let draw = 0; draw < 50; draw++) {
    const tag = `${words[Math.floor(random() * words.length) % words.length]} ${10 + (Math.floor(random() * 90) % 90)}`;
    if (!taken.has(tag.toLowerCase())) return tag;
  }
  throw new Error("no free test tag");
}

const fold = (text: string) => text.normalize("NFD").replace(/\p{Diacritic}/gu, "").toLowerCase();

/**
 * Text as a visitor typed it, ready to match: folded, and a spoken digit pair
 * joined ("Lime 4 2" → "lime 42"). Only a lone digit pair: never across a
 * phone number ("Lemon 93 555 1234" stays apart).
 */
function typed(text: string): string {
  return fold(text).replace(/(^|[^0-9])(\d)[\s-]+(\d)(?![0-9])/g, "$1$2$3");
}

/** Whether a subject or body carries the tag, however it was typed ("lime42", "Lime-42", "Lime #42"). */
export function containsTag(text: string, tag: string): boolean {
  const [word, digits] = fold(tag).split(" ");
  return new RegExp(`(^|[^a-z0-9])${word}[\\s\\-_.:#]*${digits}(?![0-9])`).test(typed(text));
}

/** The tag list a tag's word comes from (its call's language). */
function wordsOf(tag: string): string[] {
  const word = fold(tag).split(" ")[0];
  return (Object.values(TAG_WORDS).find((list) => list.some((w) => w.toLowerCase() === word)) ?? TAG_WORDS.en).map((w) =>
    w.toLowerCase(),
  );
}

/**
 * How many distinct tags an email names, from the tag's own language: one
 * naming several is nobody's (it would claim every visitor it lists). The
 * same tag twice (subject and body, a quoted reply) is one.
 */
export function countTags(text: string, tag: string): number {
  const shape = new RegExp(`(?:^|[^a-z0-9])(${wordsOf(tag).join("|")})[\\s\\-_.:#]*(\\d{2})(?![0-9])`, "g");
  return new Set([...typed(text).matchAll(shape)].map((m) => `${m[1]} ${m[2]}`)).size;
}
