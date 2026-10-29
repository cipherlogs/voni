import type { RecognitionSlotValues } from "../../types";

/**
 * Italian scene: the call the recogniser is hearing, described in Italian.
 *
 * A scene DESCRIBES the call and never INSTRUCTS the recogniser: a command such
 * as "trascrivi parola per parola" is ignored, so Italian supplies a description
 * of an Italian call. The role, mission and topics are the agent's own words and
 * arrive in whatever language the owner configured them.
 */
export const IT_SCENE: RecognitionSlotValues["scene"] = ({
  agentName,
  role,
  mission,
  topics,
}) =>
  `Una chiamata telefonica con ${role}. ${mission} Risponde ${agentName}.` +
  (topics.length > 0 ? ` Chi chiama parla di ${topics.join(", ")}.` : "");
