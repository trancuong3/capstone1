export type VoiceGender = "female" | "male";

export interface TeacherPersona {
  gender: VoiceGender;
  title: "Cô giáo AI" | "Thầy giáo AI";
  shortTitle: "Cô giáo" | "Thầy giáo";
  pronoun: "cô" | "thầy";
  capitalizedPronoun: "Cô" | "Thầy";
  companionListening: string;
  companionComforting: string;
  companionTeaching: string;
  companionCelebrating: string;
}

const KNOWN_MALE_VOICE_IDS = new Set([
  "local_north_thien_minh",
  "local_central_quang_son",
  "local_south_thai_son",
  "google_vi_vn_neural2_d",
  "google_vi_vn_wavenet_b",
]);

const KNOWN_FEMALE_VOICE_IDS = new Set([
  "local_north_truc_ly",
  "local_north_ngoc_linh",
  "local_central_ngoc_tran",
  "local_south_thuc_doan",
  "local_south_my_duyen",
  "google_vi_vn_neural2_a",
  "google_vi_vn_wavenet_c",
]);

const FEMALE_PERSONA: TeacherPersona = {
  gender: "female",
  title: "Cô giáo AI",
  shortTitle: "Cô giáo",
  pronoun: "cô",
  capitalizedPronoun: "Cô",
  companionListening: "Cô giáo AI đồng hành",
  companionComforting: "Cô giáo AI dịu dàng",
  companionTeaching: "Cô giáo AI hướng dẫn",
  companionCelebrating: "Cô giáo AI khen bé",
};

const MALE_PERSONA: TeacherPersona = {
  gender: "male",
  title: "Thầy giáo AI",
  shortTitle: "Thầy giáo",
  pronoun: "thầy",
  capitalizedPronoun: "Thầy",
  companionListening: "Thầy giáo AI đồng hành",
  companionComforting: "Thầy giáo AI dịu dàng",
  companionTeaching: "Thầy giáo AI hướng dẫn",
  companionCelebrating: "Thầy giáo AI khen bé",
};

export function normalizeVoiceGender(
  value?: string | null,
): VoiceGender | null {
  const normalized = (value ?? "").trim().toLowerCase();
  if (normalized === "male" || normalized === "nam") return "male";
  if (normalized === "female" || normalized === "nữ" || normalized === "nu") {
    return "female";
  }
  return null;
}

export function resolveVoiceGender(
  voiceId?: string | null,
  explicitGender?: string | null,
): VoiceGender {
  const fromExplicit = normalizeVoiceGender(explicitGender);
  if (fromExplicit) return fromExplicit;

  const trimmed = (voiceId ?? "").trim();
  if (KNOWN_MALE_VOICE_IDS.has(trimmed)) return "male";
  if (KNOWN_FEMALE_VOICE_IDS.has(trimmed)) return "female";

  const lower = trimmed.toLowerCase();
  if (
    lower.includes("thien_minh") ||
    lower.includes("quang_son") ||
    lower.includes("thai_son") ||
    lower.includes("neural2_d") ||
    lower.includes("wavenet_b") ||
    lower.includes("_male")
  ) {
    return "male";
  }
  return "female";
}

export function getTeacherPersona(gender: VoiceGender): TeacherPersona {
  return gender === "male" ? MALE_PERSONA : FEMALE_PERSONA;
}

export function getTeacherPersonaForVoice(
  voiceId?: string | null,
  explicitGender?: string | null,
): TeacherPersona {
  return getTeacherPersona(resolveVoiceGender(voiceId, explicitGender));
}

/**
 * Safely converts Vietnamese teacher self-reference ("cô" / "Cô" / "Cô giáo")
 * to ("thầy" / "Thầy" / "Thầy giáo") when a male voice is active, without
 * altering unrelated words like "con", "công", "cố", "cổ", "cơ".
 */
export function adaptTextToTeacherPersona(
  text: string,
  gender: VoiceGender,
): string {
  if (gender !== "male" || !text) return text;
  return text
    .replace(/(^|[^\p{L}])Cô giáo(?=$|[^\p{L}])/gu, "$1Thầy giáo")
    .replace(/(^|[^\p{L}])cô giáo(?=$|[^\p{L}])/gu, "$1thầy giáo")
    .replace(/(^|[^\p{L}])Cô(?=$|[^\p{L}])/gu, "$1Thầy")
    .replace(/(^|[^\p{L}])cô(?=$|[^\p{L}])/gu, "$1thầy");
}
