import type { RecognitionSlotValues } from "../../types";

/**
 * French scene: the call the recogniser is hearing, described in French.
 *
 * A scene DESCRIBES the call and never INSTRUCTS the recogniser: a command such
 * as "transcris mot pour mot" is ignored, so French supplies a description of a
 * French call. The role, mission and topics are the agent's own words and
 * arrive in whatever language the owner configured them.
 */
export const FR_SCENE: RecognitionSlotValues["scene"] = ({
  agentName,
  role,
  mission,
  topics,
}) =>
  `Un appel téléphonique avec ${role}. ${mission} ${agentName} répond.` +
  (topics.length > 0 ? ` Les personnes qui appellent parlent de ${topics.join(", ")}.` : "");
