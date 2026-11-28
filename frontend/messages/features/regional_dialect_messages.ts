import type { MessageTree } from "@/lib/i18n/types";

export const regionalDialectVi = {
  // Profile card & dual-score fairness preview
  profileCardTitle: "Hồ Sơ Ngữ Âm Vùng Miền",
  profileCardSubtitle:
    "Khoan dung phương ngữ ấm áp mà vẫn giữ nguyên mục tiêu chính tả SGK minh bạch cho phụ huynh.",
  privateBadge: "Riêng tư gia đình",
  profileStrictSgk: "Chuẩn chính tả SGK",
  profileStrictSgkDesc:
    "Chấm điểm theo chuẩn chính tả Tiếng Việt SGK — không áp dụng khoan dung vùng miền.",
  profileNorthTolerant: "Khoan dung giọng Bắc",
  profileNorthTolerantDesc:
    "Chấp nhận l/n, s/x, tr/ch, r/d/gi khi phần vần và thanh điệu khớp chuẩn.",
  profileCentralTolerant: "Khoan dung giọng Trung",
  profileCentralTolerantDesc:
    "Chấp nhận thanh hỏi/ngã (và sắc/nặng do nhiễu âm), vần cuối n/ng, t/c khi âm đầu và nguyên âm chính khớp.",
  profileSouthTolerant: "Khoan dung giọng Nam",
  profileSouthTolerantDesc:
    "Chấp nhận âm đầu v/d, thanh hỏi/ngã, vần cuối n/ng, t/c, n/nh khi khung âm khớp.",
  dualScoreHeading: "Xem trước công bằng hai cột điểm",
  dualScoreInfo:
    "Phụ huynh luôn thấy song song Điểm Chuẩn chính tả SGK và Điểm Khoan dung vùng miền để bé không bị nản lòng mà mục tiêu chính tả thật không bao giờ bị che khuất.",
  dualScoreStrictLabel: "Chuẩn chính tả SGK",
  dualScoreTolerLabel: "Khoan dung vùng miền",
  previewReferenceLabel: "Câu mẫu trong sách:",
  previewSpokenLabel: "Giọng đọc minh họa:",
  previewVariantsLabel: "Biến thể vùng miền được ghi nhận:",
  previewTrueErrorsLabel: "Lỗi thật / bỏ sót vẫn giữ nguyên:",
  previewNoVariants:
    "Không có biến thể vùng miền được khoan dung ở chế độ này.",
  previewNoTrueErrors: "Không có lỗi bỏ sót hay đọc sai từ khác.",
  saveProfile: "Lưu hồ sơ ngữ âm",
  savingProfile: "Đang lưu…",
  savedProfile: "Đã lưu hồ sơ ngữ âm vùng miền!",
  profileSaveError: "Chưa lưu được hồ sơ ngữ âm. Ba mẹ thử lại nhé!",
  openEarTrainerFromCard: "Luyện Tai Thính Miệng Xinh (30s)",

  // 30s Ear-Before-Voice minimal-pair trainer modal
  earTrainerTitle: "Tai Thính Miệng Xinh (30 Giây)",
  earTrainerSubtitle:
    "Nghe trước nói sau — luyện phân biệt cặp âm Tiếng Việt nhẹ nhàng, miễn nhiễm lỗi nhận diện giọng nói!",
  earTrainerRound: "Vòng {current}/{total}",
  earTrainerTimeLeft: "{seconds}s êm dịu",
  earTrainerTimeGentleDone: "Cứ thong thả hoàn thành nhé",
  earTrainerPhaseALabel: "Bước 1 · Tai Thính (Không dùng mic)",
  earTrainerPhaseAInstruction:
    "Nghe giọng mẫu và chạm vào thẻ từ đúng trong cặp âm tối thiểu!",
  earTrainerListenBtn: "Nghe từ mẫu",
  earTrainerListening: "Đang phát âm mẫu…",
  earTrainerCardAria: "Chọn từ {word}",
  earTrainerCorrect: "Tai thính quá! Bé nghe đúng từ «{word}» rồi!",
  earTrainerGentleRetry:
    "Gần đúng rồi! Từ vừa phát là «{word}» — bé nghe kỹ sự khác nhau nhé.",
  earTrainerPhaseBLabel: "Bước 2 · Miệng Xinh (Tùy chọn nói hoặc chạm tiếp)",
  earTrainerPhaseBInstruction:
    "Bé có thể đọc vang lại từ «{word}» hoặc bấm tiếp tục nhẹ nhàng không cần mic.",
  earTrainerSpeakBtn: "Nói theo từ «{word}»",
  earTrainerStopSpeakBtn: "Dừng & chấm giọng",
  earTrainerTranscribing: "Đang lắng nghe giọng bé…",
  earTrainerEchoFeedback: "Giọng bé vang rõ lắm: «{transcript}»!",
  earTrainerEchoFallbackFeedback:
    "Đã ghi nhận lượt luyện miệng! Bé chuyển sang cặp âm tiếp theo nhé.",
  earTrainerCalmNextBtn: "Qua vòng tiếp (không cần mic)",
  earTrainerCalmFinishBtn: "Hoàn thành êm dịu (không cần mic)",
  earTrainerCompleteTitle: "Hoàn thành 30 giây Tai Thính Miệng Xinh!",
  earTrainerScore: "{correct}/{total} cặp âm nghe chuẩn",
  earTrainerModeVoiceBadge: "Có luyện nói Miệng Xinh",
  earTrainerModeCalmBadge: "Hoàn thành Tai Thính êm dịu",
  earTrainerPlayAgain: "Luyện thêm 3 cặp âm",
  earTrainerClose: "Đóng",
  earTrainerLoading: "Đang chuẩn bị 3 cặp âm cho bé…",
  earTrainerError: "Chưa tải được bài luyện cặp âm. Bé thử lại nhé!",
  earTrainerRetry: "Thử tải lại",

  // Entertainment hub & Difficult Word panel triggers
  entertainmentCardBadge: "Nghe trước · Nói sau · 30s",
  entertainmentCardTitle: "Tai Thính Miệng Xinh",
  entertainmentCardDesc:
    "30 giây nghe cặp âm dễ nhầm (lúa/núa, mát/mác, cũ/củ, sẻ/xẻ) miễn nhiễm lỗi mic.",
  entertainmentCardCta: "Luyện cặp âm 30s",
  practiceDialectBtn: "Tai Thính 30s",
  practiceProfileToggle: "Hồ sơ ngữ âm vùng miền",
} as const satisfies MessageTree;

export const regionalDialectEn = {
  // Profile card & dual-score fairness preview
  profileCardTitle: "Regional Phonetic Profile",
  profileCardSubtitle:
    "Warm regional accent tolerance while keeping standard SGK spelling goals transparent for parents.",
  privateBadge: "Family Private",
  profileStrictSgk: "Standard Orthography (SGK)",
  profileStrictSgkDesc:
    "Scores strictly by standard Vietnamese SGK spelling with no regional tolerance.",
  profileNorthTolerant: "Northern Accent Tolerance",
  profileNorthTolerantDesc:
    "Accepts l/n, s/x, tr/ch, and r/d/gi onset variants when rhyme and tone match.",
  profileCentralTolerant: "Central Accent Tolerance",
  profileCentralTolerantDesc:
    "Accepts hoi/nga (and acoustic sac/nang) tones plus n/ng and t/c codas when onset and nucleus match.",
  profileSouthTolerant: "Southern Accent Tolerance",
  profileSouthTolerantDesc:
    "Accepts v/d onsets, hoi/nga tones, and n/ng, t/c, n/nh codas when the syllable skeleton matches.",
  dualScoreHeading: "Side-by-side dual-score fairness preview",
  dualScoreInfo:
    "Parents always see both Standard SGK Accuracy and Regional-Tolerant Accuracy side by side so children stay encouraged while true spelling goals are never hidden.",
  dualScoreStrictLabel: "Standard SGK",
  dualScoreTolerLabel: "Regional Tolerant",
  previewReferenceLabel: "Book reference line:",
  previewSpokenLabel: "Sample child speech:",
  previewVariantsLabel: "Accepted regional variants:",
  previewTrueErrorsLabel: "True errors / omissions kept:",
  previewNoVariants: "No regional variants are tolerated in this mode.",
  previewNoTrueErrors: "No omissions or unrelated word errors.",
  saveProfile: "Save phonetic profile",
  savingProfile: "Saving…",
  savedProfile: "Regional phonetic profile saved!",
  profileSaveError: "Could not save phonetic profile. Please try again!",
  openEarTrainerFromCard: "Open 30s Ear-Before-Voice Drill",

  // 30s Ear-Before-Voice minimal-pair trainer modal
  earTrainerTitle: "Ear Before Voice (30 Seconds)",
  earTrainerSubtitle:
    "Listen first, speak second — calm Vietnamese minimal-pair practice immune to STT errors!",
  earTrainerRound: "Round {current} of {total}",
  earTrainerTimeLeft: "{seconds}s calm timer",
  earTrainerTimeGentleDone: "Take your time to finish",
  earTrainerPhaseALabel: "Step 1 · Sharp Ear (STT-free)",
  earTrainerPhaseAInstruction:
    "Listen to the sample audio and tap the matching minimal-pair card!",
  earTrainerListenBtn: "Listen to word",
  earTrainerListening: "Playing sample…",
  earTrainerCardAria: "Select word {word}",
  earTrainerCorrect: "Sharp ear! You picked «{word}»!",
  earTrainerGentleRetry:
    "Close listen! The spoken word was «{word}» — notice the sound contrast.",
  earTrainerPhaseBLabel: "Step 2 · Clear Voice (Optional echo or calm tap)",
  earTrainerPhaseBInstruction:
    "Echo «{word}» aloud if you like, or continue calmly without a microphone.",
  earTrainerSpeakBtn: "Echo «{word}»",
  earTrainerStopSpeakBtn: "Stop & check",
  earTrainerTranscribing: "Listening to your echo…",
  earTrainerEchoFeedback: "Clear voice heard: «{transcript}»!",
  earTrainerEchoFallbackFeedback:
    "Voice practice recorded! Ready for the next minimal pair.",
  earTrainerCalmNextBtn: "Next round (no mic needed)",
  earTrainerCalmFinishBtn: "Finish calmly (no mic needed)",
  earTrainerCompleteTitle: "30s Ear-Before-Voice Complete!",
  earTrainerScore: "{correct}/{total} minimal pairs matched",
  earTrainerModeVoiceBadge: "With Voice Echo",
  earTrainerModeCalmBadge: "Calm Listening Mode",
  earTrainerPlayAgain: "Practice 3 more pairs",
  earTrainerClose: "Close",
  earTrainerLoading: "Preparing 3 minimal pairs…",
  earTrainerError: "Could not load minimal-pair drill. Please try again!",
  earTrainerRetry: "Retry",

  // Entertainment hub & Difficult Word panel triggers
  entertainmentCardBadge: "Ear First · Voice Second · 30s",
  entertainmentCardTitle: "Ear Before Voice",
  entertainmentCardDesc:
    "30-second Vietnamese minimal-pair listening game immune to microphone errors.",
  entertainmentCardCta: "Play 30s Ear Drill",
  practiceDialectBtn: "30s Ear Drill",
  practiceProfileToggle: "Regional phonetic profile",
} as const satisfies MessageTree;

export type RegionalDialectMessageKey = keyof typeof regionalDialectVi;
