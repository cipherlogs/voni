import type { RecognitionSlotValues } from "../../types";

/**
 * Spanish scene: the call the recogniser is hearing, described in Spanish.
 *
 * A scene DESCRIBES the call and never INSTRUCTS the recogniser: "transcribe
 * verbatim" or "add punctuation" is ignored, so Spanish supplies a description
 * of a Spanish call, not a command list in Spanish. The role, mission and
 * topics are the agent's own words and arrive in whatever language the owner
 * configured them.
 */
export const ES_SCENE: RecognitionSlotValues["scene"] = ({
  agentName,
  role,
  mission,
  topics,
}) =>
  `Una llamada telefónica de ${role}. ${mission} Habla ${agentName}.` +
  (topics.length > 0 ? ` Quien llama menciona ${topics.join(", ")}.` : "");
