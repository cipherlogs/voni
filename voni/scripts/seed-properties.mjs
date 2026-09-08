import { neon } from "@neondatabase/serverless";

const databaseUrl = process.env.DATABASE_URL;
const organizationId = process.env.VONI_ORG_ID;

if (!databaseUrl) throw new Error("DATABASE_URL is required.");
if (!organizationId) {
  throw new Error(
    "VONI_ORG_ID is required. The seed never guesses or auto-seeds a customer organization.",
  );
}

const sql = neon(databaseUrl);
const availability = {
  timezone: "Asia/Dubai",
  weekly: {
    sunday: [{ start: "10:00", end: "18:00" }],
    monday: [{ start: "10:00", end: "18:00" }],
    tuesday: [{ start: "10:00", end: "18:00" }],
    wednesday: [{ start: "10:00", end: "18:00" }],
    thursday: [{ start: "10:00", end: "18:00" }],
  },
};

const listings = [
  ["VONI-AUH-001", "Sample: Yas Island marina apartment", "Yas Island, Abu Dhabi", 1850000, "apartment", 2, ["balcony", "pool", "gym", "parking"]],
  ["VONI-AUH-002", "Sample: Saadiyat cultural district apartment", "Saadiyat Island, Abu Dhabi", 3200000, "apartment", 2, ["sea view", "pool", "concierge"]],
  ["VONI-AUH-003", "Sample: Al Reem family apartment", "Al Reem Island, Abu Dhabi", 1450000, "apartment", 3, ["maid room", "gym", "parking"]],
  ["VONI-AUH-004", "Sample: Al Raha beach townhouse", "Al Raha Beach, Abu Dhabi", 2850000, "townhouse", 3, ["garden", "beach access", "parking"]],
  ["VONI-AUH-005", "Sample: Khalifa City family villa", "Khalifa City, Abu Dhabi", 4100000, "villa", 4, ["private garden", "maid room", "covered parking"]],
  ["VONI-AUH-006", "Sample: Al Reef starter townhouse", "Al Reef, Abu Dhabi", 1650000, "townhouse", 2, ["community pool", "garden", "parking"]],
  ["VONI-DXB-001", "Sample: Downtown boulevard apartment", "Downtown Dubai, Dubai", 2600000, "apartment", 2, ["Burj Khalifa view", "pool", "gym"]],
  ["VONI-DXB-002", "Sample: Dubai Marina waterfront apartment", "Dubai Marina, Dubai", 2200000, "apartment", 2, ["marina view", "balcony", "parking"]],
  ["VONI-DXB-003", "Sample: JVC modern apartment", "Jumeirah Village Circle, Dubai", 980000, "apartment", 1, ["pool", "gym", "balcony"]],
  ["VONI-DXB-004", "Sample: Arabian Ranches family villa", "Arabian Ranches, Dubai", 5200000, "villa", 4, ["private garden", "community pool", "garage"]],
  ["VONI-DXB-005", "Sample: Dubai Hills townhouse", "Dubai Hills Estate, Dubai", 3900000, "townhouse", 3, ["garden", "park access", "covered parking"]],
  ["VONI-DXB-006", "Sample: Palm Jumeirah apartment", "Palm Jumeirah, Dubai", 4750000, "apartment", 3, ["sea view", "private beach", "concierge"]],
];

for (const [reference, title, location, price, type, bedrooms, amenities] of listings) {
  const description = `${title}. Development-only sample inventory for testing Voni property tools.`;
  await sql`
    INSERT INTO properties (
      organization_id, reference, title, description, location, price,
      currency, type, bedrooms, amenities, availability
    ) VALUES (
      ${organizationId}, ${reference}, ${title}, ${description}, ${location},
      ${price}, 'AED', ${type}, ${bedrooms}, ${JSON.stringify(amenities)}::jsonb,
      ${JSON.stringify(availability)}::jsonb
    )
    ON CONFLICT (organization_id, reference) DO UPDATE SET
      title = EXCLUDED.title,
      description = EXCLUDED.description,
      location = EXCLUDED.location,
      price = EXCLUDED.price,
      currency = EXCLUDED.currency,
      type = EXCLUDED.type,
      bedrooms = EXCLUDED.bedrooms,
      amenities = EXCLUDED.amenities,
      availability = EXCLUDED.availability
  `;
}

console.log(`Upserted ${listings.length} sample properties for ${organizationId}.`);

