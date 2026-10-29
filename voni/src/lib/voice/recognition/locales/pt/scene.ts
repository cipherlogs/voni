import type { RecognitionSlotValues } from "../../types";

/**
 * Portuguese scene: the call the recogniser is hearing, described in Portuguese.
 *
 * A scene DESCRIBES the call and never INSTRUCTS the recogniser: a command such
 * as "transcreva palavra por palavra" is ignored, so Portuguese supplies a
 * description of a Portuguese call. The role, mission and topics are the agent's
 * own words and arrive in whatever language the owner configured them.
 */
export const PT_SCENE: RecognitionSlotValues["scene"] = ({
  agentName,
  role,
  mission,
  topics,
}) =>
  `Uma chamada telefónica com ${role}. ${mission} ${agentName} atende.` +
  (topics.length > 0 ? ` Quem liga fala sobre ${topics.join(", ")}.` : "");
