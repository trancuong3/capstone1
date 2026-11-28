import type { MessageTree } from "@/lib/i18n/types";

export const fiveMinTrainVi: MessageTree = {
  pageTitle: "Chuyến tàu luyện đọc 5 phút",
  pageDescription:
    "Hành trình 3 toa cá nhân hóa khoảng 5 phút mỗi ngày giúp bé ôn từ khó, ghép câu và đọc trôi chảy nhẹ nhàng.",
  cta: {
    badge: "~5 phút · 3 toa cá nhân hóa",
    title: "Chuyến Tàu Luyện Đọc 5 Phút",
    descriptionWithChild:
      "Lộ trình 1 chạm dành riêng cho {alias}: khởi động từ cần ôn, chơi ghép câu ngữ cảnh và đọc trôi chảy tốc độ êm 0.85x.",
    descriptionGeneric:
      "Khởi hành 3 toa ngắn gọn (~5 phút): ôn từ khó có gợi ý đánh vần, vận dụng qua trò chơi và về đích đọc trôi chảy.",
    car1Chip: "Toa 1 · Khởi động từ khó (~90s)",
    car2Chip: "Toa 2 · Trò chơi ngữ cảnh (~120s)",
    car3Chip: "Toa 3 · Về đích trôi chảy (~90s)",
    focusWordsLabel: "Từ trọng tâm hôm nay:",
    launchAction: "Lên tàu 5 phút ngay",
    selectChildAction: "Mở chuyến tàu 5 phút",
  },
  header: {
    backToDashboard: "Về bàn đọc gia đình",
    backToReports: "Về báo cáo tiến độ",
    backToEntertainment: "Về góc giải trí",
    selectChildAria: "Chọn hồ sơ bé cho chuyến tàu 5 phút",
    childBadge: "{alias} · Lớp {grade}",
    completedTodayBadge: "Hôm nay đã hoàn thành {count} chuyến",
    coldStartBadge: "Lộ trình làm quen theo lớp",
    noMicToggle: "Tạm không tiện bật mic",
    noMicActiveBadge: "Đang bật Nghe & Chạm (không cần mic)",
    autoNoMicBanner:
      "Thiết bị hiện chưa sẵn sàng micro — chuyến tàu đã tự chuyển sang chế độ Nghe mẫu & Chạm chọn nhẹ nhàng để bé tiếp tục trọn vẹn.",
    manualNoMicBanner:
      'Chế độ "Tạm không tiện bật mic" đang bật: bé nghe giọng mẫu rồi chạm chọn từng bước mà không cần thu âm.',
  },
  progress: {
    ariaLabel: "Tiến trình 3 toa chuyến tàu luyện đọc 5 phút",
    car1Short: "Toa 1 · Từ khó",
    car2Short: "Toa 2 · Trò chơi",
    car3Short: "Toa 3 · Trôi chảy",
    finishShort: "Ga Về Đích",
    paceLabel: "Nhịp êm ~5 phút · Không đếm ngược gây áp lực",
  },
  car1: {
    listenWord: "Nghe mẫu",
    speakWord: "Đọc cùng AI",
    recordingWord: "Đang lắng nghe...",
    tapConfirmWord: "Đã nghe & chạm đọc từ này",
    wordPracticed: "Đã khởi động xong",
    sampleSentenceLabel: "Câu mẫu:",
    progressStatus: "Đã khởi động {done}/{total} từ",
    advanceToCar2: "Sang Toa 2: Vận dụng qua trò chơi",
  },
  car2: {
    seededWordsLabel: "Từ mang theo từ Toa 1:",
    listenSentence: "Nghe câu gợi ý",
    speakSentence: "Đọc to câu vừa ghép",
    tapInstruction:
      "Chạm lần lượt từng thẻ từ bên dưới để ghép thành câu hoàn chỉnh:",
    selectedSentenceLabel: "Câu của bé:",
    emptySlotsHint: "Chạm thẻ từ đầu tiên để bắt đầu ghép câu nhé...",
    resetSentence: "Xếp lại nhẹ nhàng",
    gentleHint:
      "Từ này chưa đúng vị trí kế tiếp — bé thử nhìn lại từ đầu câu nhé!",
    roundCompleted:
      "Tuyệt quá! Bé đã ghép trọn vẹn câu có các từ vừa khởi động.",
    advanceToCar3: "Sang Toa 3: Về đích trôi chảy",
  },
  car3: {
    speedBadge: "Nhịp chậm êm 0.85x",
    karaokeBadge: "Hát chậm 0.85x",
    passageBadge: "Đoạn đọc ngắn theo nhóm vần",
    listenSlow085: "Nghe mẫu chậm 0.85x",
    speakPassage: "Đọc / hát cùng AI",
    tapRhythmInstruction:
      "Chạm lần lượt từng nhịp câu bên dưới khi bé đọc nhẩm hoặc đọc theo giọng mẫu:",
    rhythmStepDone: "Đã đọc nhịp {index}",
    rhythmStepPrompt: "Chạm nhịp {index}",
    coachingLabel: "Gợi ý đồng hành:",
    readyToFinish: "Bé đã hoàn thành nhịp đọc Toa 3 — sẵn sàng cập bến!",
    finishTrainAction: "Cập bến & lưu hành trình 5 phút",
    completingAction: "Đang lưu kết quả...",
  },
  completed: {
    badge: "Ga Về Đích · Hoàn thành êm ái",
    evidenceSummary:
      "Đã ghi nhận {count} minh chứng kỹ năng vào hồ sơ học tập riêng tư của gia đình.",
    noMicEvidenceNote:
      "Lượt hoàn thành ở chế độ Nghe & Chạm được ghi nhận trung thực là ước lượng nhẹ nhàng, không tạo áp lực điểm số.",
    naturalBreakHeading: "Nghỉ mắt thư giãn sau 5 phút",
    restartOptional: "Xem lại lộ trình hôm nay",
  },
  states: {
    loadingTitle: "Đang chuẩn bị 3 toa tàu cá nhân hóa cho bé...",
    noChildrenTitle: "Chưa có hồ sơ bé",
    noChildrenDescription:
      "Ba mẹ hãy tạo hồ sơ bé trước để hệ thống thiết kế chuyến tàu luyện đọc 5 phút phù hợp với lớp của bé.",
    createChildAction: "Tạo hồ sơ bé",
    errorTitle: "Chưa tải được chuyến tàu hôm nay",
    errorDescription: "Vui lòng kiểm tra kết nối và thử tải lại nhẹ nhàng.",
    retryAction: "Thử lại",
  },
};

export const fiveMinTrainEn: MessageTree = {
  pageTitle: "5-Minute Daily Reading Train",
  pageDescription:
    "A calm, personalized 3-car ~5-minute daily reading journey combining word warm-ups, a contextual mini-game, and smooth 0.85x fluency reading.",
  cta: {
    badge: "~5 min · 3 personalized cars",
    title: "5-Minute Daily Reading Train",
    descriptionWithChild:
      "1-tap personalized flow for {alias}: warm up tricky words, play a contextual sentence round, and finish with calm 0.85x fluency reading.",
    descriptionGeneric:
      "Hop on 3 short cars (~5 min): phonics word warm-up, a seeded mini-game round, and a gentle fluency finish.",
    car1Chip: "Car 1 · Word Warm-up (~90s)",
    car2Chip: "Car 2 · Context Game (~120s)",
    car3Chip: "Car 3 · Fluency Finish (~90s)",
    focusWordsLabel: "Today's focus words:",
    launchAction: "Start 5-minute train",
    selectChildAction: "Open 5-minute train",
  },
  header: {
    backToDashboard: "Back to Reading Desk",
    backToReports: "Back to Progress Reports",
    backToEntertainment: "Back to Play Hub",
    selectChildAria: "Select child profile for the 5-minute train",
    childBadge: "{alias} · Grade {grade}",
    completedTodayBadge: "Completed {count} train today",
    coldStartBadge: "Grade-matched starter track",
    noMicToggle: "Temporarily without mic",
    noMicActiveBadge: "Listen & Tap mode active (no mic needed)",
    autoNoMicBanner:
      "Microphone is currently unavailable — the train switched automatically to calm Listen & Tap mode so your child can finish smoothly.",
    manualNoMicBanner:
      '"Temporarily without mic" mode is active: listen to the model voice and tap each step without recording.',
  },
  progress: {
    ariaLabel: "3-car progress for the 5-minute reading train",
    car1Short: "Car 1 · Words",
    car2Short: "Car 2 · Game",
    car3Short: "Car 3 · Fluency",
    finishShort: "Arrival Station",
    paceLabel: "Calm ~5-minute pace · Zero countdown pressure",
  },
  car1: {
    listenWord: "Listen",
    speakWord: "Read aloud",
    recordingWord: "Listening...",
    tapConfirmWord: "Listened & practiced this word",
    wordPracticed: "Warmed up",
    sampleSentenceLabel: "Sample sentence:",
    progressStatus: "Warmed up {done}/{total} words",
    advanceToCar2: "Continue to Car 2: Context Game",
  },
  car2: {
    seededWordsLabel: "Carried over from Car 1:",
    listenSentence: "Listen to prompt sentence",
    speakSentence: "Read built sentence aloud",
    tapInstruction:
      "Tap each word chip in order below to build the complete sentence:",
    selectedSentenceLabel: "Your sentence:",
    emptySlotsHint: "Tap the first word chip below to start building...",
    resetSentence: "Reset gently",
    gentleHint:
      "Not the next word yet — try checking the sentence order calmly!",
    roundCompleted:
      "Wonderful! You built the full sentence with today's warmup words.",
    advanceToCar3: "Continue to Car 3: Fluency Finish",
  },
  car3: {
    speedBadge: "Calm 0.85x tempo",
    karaokeBadge: "0.85x Slow Karaoke",
    passageBadge: "Phonics short passage",
    listenSlow085: "Listen at 0.85x",
    speakPassage: "Read / sing along",
    tapRhythmInstruction:
      "Tap each phrase beat below as your child reads silently or follows the model voice:",
    rhythmStepDone: "Phrase {index} done",
    rhythmStepPrompt: "Tap phrase {index}",
    coachingLabel: "Parent & child tip:",
    readyToFinish: "Car 3 fluency practice complete — ready to arrive!",
    finishTrainAction: "Arrive & save 5-minute journey",
    completingAction: "Saving progress...",
  },
  completed: {
    badge: "Arrival Station · Calmly Completed",
    evidenceSummary:
      "Recorded {count} skill evidence entries in your family's private learning profile.",
    noMicEvidenceNote:
      "Listen & Tap completions are recorded honestly as gentle estimated practice with zero score pressure.",
    naturalBreakHeading: "Healthy eye rest after 5 minutes",
    restartOptional: "Review today's track",
  },
  states: {
    loadingTitle: "Preparing your child's personalized 3-car train...",
    noChildrenTitle: "No child profile yet",
    noChildrenDescription:
      "Create a child profile first so ViRead can tailor a grade-appropriate 5-minute reading train.",
    createChildAction: "Create child profile",
    errorTitle: "Could not load today's reading train",
    errorDescription: "Please check your connection and try again calmly.",
    retryAction: "Retry",
  },
};
