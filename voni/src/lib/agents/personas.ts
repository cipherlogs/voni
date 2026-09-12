import type { AgentConfig } from "./config";
import { REAL_ESTATE_TEMPLATE } from "./config";
import { getVoice } from "./voices";

/**
 * Demo personas — the scenarios a visitor can pick before starting a call.
 *
 * Plan Section E names Vapi's landing widget (mic permission + scenario
 * dropdown + one-click "Initiate Call") as the pattern to follow, over
 * Structurely's phone-number-collection version. A persona *is* that scenario
 * dropdown, with the voice choice folded in — which the API forces anyway,
 * since `voice` is immutable once a session starts.
 *
 * Real estate reuses REAL_ESTATE_TEMPLATE verbatim rather than restating it, so
 * the demo a visitor hears and the template a customer starts from cannot drift
 * apart.
 *
 * Each persona keeps a full AgentConfig so the same `compileSystemPrompt` runs
 * for demos and for real agents — a demo that is prompted differently from the
 * product is a demo that lies.
 */

export type Persona = {
  id: string;
  /** The agent's own name, spoken on the call. */
  name: string;
  /** Vertical, shown as the card's eyebrow. */
  vertical: string;
  /** One line explaining what the visitor is about to experience. */
  pitch: string;
  /** What the visitor should pretend to be, so they know how to open. */
  yourRole: string;
  /** Default voice; the picker can override it before connecting. */
  voiceId: string;
  /**
   * Greeting per output language, keyed by language code.
   *
   * Needed because the greeting is a fixed string sent straight to TTS while
   * the voice is chosen at call time — so an English greeting spoken by `lola`
   * is a Spanish voice reading English, and it is the very first thing a
   * visitor hears. `en` is required; anything missing falls back to it.
   *
   * ⚠️ These are written rather than machine-translated, but have NOT been
   * reviewed by native speakers. Get one to check them before launch — this is
   * the most-heard sentence in the product.
   *
   * ⚠️ AVOID GENDERED AGREEMENT ON THE SPEAKER. Any voice can be paired with
   * any persona, so a line whose grammar assumes the speaker's gender is wrong
   * half the time — Portuguese "obrigada" spoken by the masculine voice
   * `rafael`, for instance. Use a neutral form ("agradeço a chamada") instead.
   * Articles tied to the persona's own NAME ("é a Layla", "é o Marcus") are
   * fine: those follow the character, not whoever is voicing it.
   */
  greetings: Record<string, string>;
  /**
   * Optional portrait at /public/personas/<id>.jpg.
   *
   * Left undefined until the images actually exist — a set path with no file
   * costs a 404 per card on every render, and the monogram fallback is the
   * same code path either way. Fill these in once the portraits are generated.
   *
   * They must be generated for this project or properly licensed, never
   * scraped from another site: an AI-generated image is still owned by
   * whoever made it, and a real person's face attached to an AI sales agent
   * is a separate rights problem on top.
   */
  portrait?: string;
  config: AgentConfig;
};

export const PERSONAS: Persona[] = [
  {
    id: "real-estate",
    portrait: "/personas/real-estate.jpg",
    greetings: {
      en: "Hi, it's Layla calling about the apartment. Is now okay?",
      es: "Hola, soy Layla, le llamo por el apartamento. ¿Le viene bien ahora?",
      fr: "Bonjour, c'est Layla, je vous appelle au sujet de l'appartement. C'est le bon moment ?",
      de: "Hallo, hier ist Layla, ich rufe wegen der Wohnung an. Passt es gerade?",
      it: "Salve, sono Layla, la chiamo per l'appartamento. È un buon momento?",
      pt: "Olá, é a Layla, ligo por causa do apartamento. É boa altura?",
    },
    name: "Layla",
    vertical: "Real estate",
    pitch: "Qualifies a property lead and books a viewing.",
    yourRole: "You enquired about a 2-bedroom apartment in Abu Dhabi.",
    voiceId: "anna",
    config: {
      ...REAL_ESTATE_TEMPLATE,
      identity: { name: "Layla", role: "property consultant" },
      voiceId: "anna",
      greeting: "Hi, it's Layla calling about the apartment. Is now okay?",
    },
  },
  {
    id: "car-dealership",
    portrait: "/personas/car-dealership.jpg",
    greetings: {
      en: "Hi, Marcus here from the dealership. Caught you at a bad time?",
      es: "Hola, soy Marcus, del concesionario. ¿Le pillo en mal momento?",
      fr: "Bonjour, Marcus de la concession. Je vous dérange ?",
      de: "Hallo, hier ist Marcus vom Autohaus. Störe ich gerade?",
      it: "Salve, sono Marcus della concessionaria. La disturbo?",
      pt: "Olá, é o Marcus, do stand. Apanhei-o em má altura?",
    },
    name: "Marcus",
    vertical: "Car dealership",
    pitch: "Follows up on a test-drive enquiry and books the slot.",
    yourRole: "You asked online about a used SUV last week.",
    voiceId: "george",
    config: {
      mission:
        "Turn a car enquiry into a booked test drive at the dealership.",
      identity: { name: "Marcus", role: "sales advisor" },
      detect: [
        { key: "model_interest", label: "Model of interest", description: "Which vehicle or type." },
        { key: "budget", label: "Budget", description: "Cash price or monthly payment." },
        { key: "trade_in", label: "Trade-in", description: "Whether they have a car to trade." },
        { key: "financing", label: "Financing", description: "Cash, finance, or lease." },
        { key: "timeline", label: "Timeline", description: "How soon they want to buy." },
      ],
      tools: ["check_calendar", "book_viewing", "schedule_follow_up", "update_lead", "transfer_to_human"],
      knowledge:
        "Never quote a price or availability you have not confirmed with a tool. Do not promise a finance rate — that is the finance desk's call.",
      channels: ["phone", "whatsapp"],
      // Empty = detect across all 18 recognised languages. A demo visitor
      // may open in any of them, and the agent should follow rather than
      // be pinned to one.
      languageCodes: [],
      voiceId: "george",
      greeting: "Hi, Marcus here from the dealership. Caught you at a bad time?",
    },
  },
  {
    id: "restaurant",
    portrait: "/personas/restaurant.jpg",
    greetings: {
      en: "Good evening, thanks for calling. How can I help?",
      es: "Buenas noches, gracias por llamar. ¿En qué puedo ayudarle?",
      fr: "Bonsoir, merci de votre appel. Comment puis-je vous aider ?",
      de: "Guten Abend, danke für Ihren Anruf. Wie kann ich helfen?",
      it: "Buonasera, grazie per aver chiamato. Come posso aiutarla?",
      pt: "Boa noite, agradeço a chamada. Em que posso ajudar?",
    },
    name: "Sofia",
    vertical: "Restaurant",
    pitch: "Takes a reservation, including party size and seating.",
    yourRole: "You want a table for Friday evening.",
    voiceId: "eve",
    config: {
      mission: "Take and confirm restaurant reservations.",
      identity: { name: "Sofia", role: "host" },
      detect: [
        { key: "date_time", label: "Date and time", description: "When they want the table." },
        { key: "party_size", label: "Party size", description: "How many people." },
        { key: "seating", label: "Seating preference", description: "Inside, terrace, bar." },
        { key: "occasion", label: "Occasion", description: "Birthday, business, casual." },
        { key: "dietary", label: "Dietary needs", description: "Allergies or restrictions." },
      ],
      tools: ["check_availability", "check_calendar", "book_viewing", "update_lead", "transfer_to_human"],
      knowledge:
        "Never confirm a table without checking availability with a tool. Always read the date, time and party size back before confirming.",
      channels: ["phone", "whatsapp"],
      // Empty = detect across all 18 recognised languages. A demo visitor
      // may open in any of them, and the agent should follow rather than
      // be pinned to one.
      languageCodes: [],
      voiceId: "eve",
      greeting: "Good evening, thanks for calling. How can I help?",
    },
  },
  {
    id: "dental",
    portrait: "/personas/dental.jpg",
    greetings: {
      en: "Hello, this is Nadia at the dental clinic. How can I help?",
      es: "Hola, soy Nadia, de la clínica dental. ¿En qué puedo ayudarle?",
      fr: "Bonjour, ici Nadia, du cabinet dentaire. Comment puis-je vous aider ?",
      de: "Hallo, hier ist Nadia von der Zahnarztpraxis. Wie kann ich helfen?",
      it: "Salve, sono Nadia dello studio dentistico. Come posso aiutarla?",
      pt: "Olá, é a Nadia, da clínica dentária. Em que posso ajudar?",
    },
    name: "Nadia",
    vertical: "Dental clinic",
    pitch: "Books an appointment and triages urgency.",
    yourRole: "You have had toothache for a couple of days.",
    voiceId: "vera",
    config: {
      mission:
        "Book dental appointments and get urgent cases seen sooner.",
      identity: { name: "Nadia", role: "clinic coordinator" },
      detect: [
        { key: "reason", label: "Reason for visit", description: "Checkup, pain, cosmetic, emergency." },
        { key: "urgency", label: "Urgency", description: "Pain level and how long it has lasted." },
        { key: "new_or_existing", label: "New or existing patient", description: "Whether they are on file." },
        { key: "availability", label: "Availability", description: "Days and times that work." },
        { key: "insurance", label: "Insurance", description: "Provider, if any." },
      ],
      tools: ["check_calendar", "check_availability", "book_viewing", "schedule_follow_up", "update_lead", "transfer_to_human"],
      // The first sentence is what keeps a booking assistant from practising medicine.
      knowledge:
        "Never give clinical or medical advice. Book the appointment and let the dentist advise. If someone describes severe swelling, bleeding that will not stop, or trouble breathing, tell them to seek urgent care immediately and offer to transfer them. Never confirm a slot without checking the calendar with a tool.",
      channels: ["phone", "whatsapp"],
      // Empty = detect across all 18 recognised languages. A demo visitor
      // may open in any of them, and the agent should follow rather than
      // be pinned to one.
      languageCodes: [],
      voiceId: "vera",
      greeting: "Hello, this is Nadia at the dental clinic. How can I help?",
    },
  },
  {
    id: "reception",
    portrait: "/personas/reception.jpg",
    greetings: {
      en: "Good morning, thanks for calling. Who am I speaking with?",
      es: "Buenos días, gracias por llamar. ¿Con quién hablo?",
      fr: "Bonjour, merci de votre appel. Puis-je avoir votre nom ?",
      de: "Guten Morgen, danke für Ihren Anruf. Mit wem spreche ich?",
      it: "Buongiorno, grazie per aver chiamato. Con chi parlo?",
      pt: "Bom dia, agradeço a chamada. Com quem falo?",
    },
    name: "Adam",
    vertical: "Inbound reception",
    pitch: "Answers a general enquiry and routes it to the right person.",
    yourRole: "You are calling a business you have never dealt with.",
    voiceId: "charles",
    config: {
      mission:
        "Answer inbound calls, capture who is calling and why, and route or take a message.",
      identity: { name: "Adam", role: "receptionist" },
      detect: [
        { key: "caller_name", label: "Caller name", description: "Who is calling." },
        { key: "company", label: "Company", description: "Where they are calling from." },
        { key: "reason", label: "Reason for calling", description: "What they need." },
        { key: "callback_number", label: "Callback number", description: "Best number to reach them." },
        { key: "urgency", label: "Urgency", description: "How soon they need a response." },
      ],
      tools: ["schedule_follow_up", "update_lead", "transfer_to_human"],
      knowledge:
        "Never invent an answer about pricing, availability or policy — take a message instead. Always read a callback number back digit by digit before ending the call.",
      channels: ["phone"],
      // Empty = detect across all 18 recognised languages. A demo visitor
      // may open in any of them, and the agent should follow rather than
      // be pinned to one.
      languageCodes: [],
      voiceId: "charles",
      greeting: "Good morning, thanks for calling. Who am I speaking with?",
    },
  },
];

export function getPersona(id: string): Persona | undefined {
  return PERSONAS.find((p) => p.id === id);
}


/**
 * The config to call this persona with, for a given voice.
 *
 * Resolves the greeting to the voice's own language so the first line the
 * caller hears is not English read by a Spanish voice. Falls back to English
 * for any language without a written greeting.
 */
export function personaConfig(persona: Persona, voiceId: string): AgentConfig {
  const voice = getVoice(voiceId);
  const code = voice?.languageCode ?? "en";
  return {
    ...persona.config,
    voiceId,
    greeting: persona.greetings[code] ?? persona.greetings.en,
  };
}
