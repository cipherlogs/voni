import type { RecognitionSlotValues } from "../../types";

/**
 * German scene: the call the recogniser is hearing, described in German.
 *
 * A scene DESCRIBES the call and never INSTRUCTS the recogniser: a command such
 * as "transkribiere wörtlich" is ignored, so German supplies a description of a
 * German call. The role, mission and topics are the agent's own words and
 * arrive in whatever language the owner configured them.
 */
export const DE_SCENE: RecognitionSlotValues["scene"] = ({
  agentName,
  role,
  mission,
  topics,
}) =>
  `Ein Telefonanruf mit ${role}. ${mission} ${agentName} ist am Telefon.` +
  (topics.length > 0 ? ` Anrufer sprechen über ${topics.join(", ")}.` : "");
