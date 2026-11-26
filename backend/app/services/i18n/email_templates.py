"""Localized email templates for all 30 supported ViRead locales."""

from __future__ import annotations

from dataclasses import dataclass

from app.services.i18n.locales import resolve_supported_locale


@dataclass(frozen=True)
class RenderedEmailTemplate:
    locale: str
    subject: str
    body: str


# Note on legacy Vietnamese preservation:
# The "vi" templates match the original Vietnamese copy character-for-character.
READING_REMINDER_TEMPLATES: dict[str, dict[str, str]] = {
    "vi": {
        "subject": "Đến giờ đọc sách cùng bé",
        "body": (
            "Chào ba mẹ,\n\n"
            "Đã đến giờ đọc sách cùng {child_alias}.\n"
            "Lịch đọc: {local_date} lúc {local_time} ({timezone_name}).\n\n"
            "Mở ViRead: {app_url}\n\n"
            "Chúc gia đình có một buổi đọc sách vui vẻ!"
        ),
    },
    "en": {
        "subject": "Time to read with your child",
        "body": (
            "Hello parents,\n\n"
            "It is time to read with {child_alias}.\n"
            "Schedule: {local_date} at {local_time} ({timezone_name}).\n\n"
            "Open ViRead: {app_url}\n\n"
            "Wishing your family a joyful reading session!"
        ),
    },
    "zh-Hans": {
        "subject": "陪伴孩子阅读的时间到了",
        "body": (
            "家长您好，\n\n"
            "现在是与 {child_alias} 一起阅读的时间。\n"
            "阅读计划：{local_date} {local_time}（{timezone_name}）。\n\n"
            "打开 ViRead：{app_url}\n\n"
            "祝您和家人拥有一段愉快的阅读时光！"
        ),
    },
    "zh-Hant": {
        "subject": "陪伴孩子閱讀的時間到了",
        "body": (
            "家長您好，\n\n"
            "現在是與 {child_alias} 一起閱讀的時間。\n"
            "閱讀排程：{local_date} {local_time}（{timezone_name}）。\n\n"
            "開啟 ViRead：{app_url}\n\n"
            "祝您和家人度過愉快的閱讀時光！"
        ),
    },
    "ja": {
        "subject": "お子さまとの読書タイムのお知らせ",
        "body": (
            "保護者の皆さまへ\n\n"
            "{child_alias} さんと一緒に読書する時間になりました。\n"
            "予定時刻: {local_date} {local_time}（{timezone_name}）\n\n"
            "ViRead を開く: {app_url}\n\n"
            "ご家族で楽しい読書の時間をお過ごしください。"
        ),
    },
    "ko": {
        "subject": "아이와 함께 책 읽을 시간이에요",
        "body": (
            "학부모님 안녕하세요,\n\n"
            "{child_alias}와(과) 함께 책을 읽을 시간입니다.\n"
            "독서 일정: {local_date} {local_time} ({timezone_name}).\n\n"
            "ViRead 열기: {app_url}\n\n"
            "가족과 함께 즐거운 독서 시간 보내세요!"
        ),
    },
    "fr": {
        "subject": "C'est l'heure de lire avec votre enfant",
        "body": (
            "Bonjour,\n\n"
            "Il est l'heure de lire avec {child_alias}.\n"
            "Horaire prévu : {local_date} à {local_time} ({timezone_name}).\n\n"
            "Ouvrir ViRead : {app_url}\n\n"
            "Nous vous souhaitons une agréable séance de lecture en famille !"
        ),
    },
    "de": {
        "subject": "Zeit zum gemeinsamen Lesen mit Ihrem Kind",
        "body": (
            "Hallo liebe Eltern,\n\n"
            "es ist Zeit für die gemeinsame Lesezeit mit {child_alias}.\n"
            "Leseplan: {local_date} um {local_time} ({timezone_name}).\n\n"
            "ViRead öffnen: {app_url}\n\n"
            "Wir wünschen Ihrer Familie viel Freude beim Lesen!"
        ),
    },
    "es": {
        "subject": "Es hora de leer con tu peque",
        "body": (
            "Hola,\n\n"
            "Ya es hora de leer junto a {child_alias}.\n"
            "Horario programado: {local_date} a las {local_time} ({timezone_name}).\n\n"
            "Abrir ViRead: {app_url}\n\n"
            "¡Les deseamos una alegre sesión de lectura en familia!"
        ),
    },
    "pt": {
        "subject": "Hora da leitura em família",
        "body": (
            "Olá,\n\n"
            "Está na hora de ler com {child_alias}.\n"
            "Horário agendado: {local_date} às {local_time} ({timezone_name}).\n\n"
            "Abrir ViRead: {app_url}\n\n"
            "Desejamos à sua família uma ótima sessão de leitura!"
        ),
    },
    "it": {
        "subject": "È ora di leggere insieme",
        "body": (
            "Ciao genitori,\n\n"
            "È arrivato il momento di leggere con {child_alias}.\n"
            "Programma: {local_date} alle {local_time} ({timezone_name}).\n\n"
            "Apri ViRead: {app_url}\n\n"
            "Auguriamo alla vostra famiglia una piacevole lettura!"
        ),
    },
    "ru": {
        "subject": "Время почитать вместе с ребёнком",
        "body": (
            "Здравствуйте!\n\n"
            "Пришло время почитать вместе с {child_alias}.\n"
            "Расписание: {local_date} в {local_time} ({timezone_name}).\n\n"
            "Открыть ViRead: {app_url}\n\n"
            "Желаем вашей семье приятного чтения!"
        ),
    },
    "th": {
        "subject": "ได้เวลาอ่านหนังสือกับน้องแล้ว",
        "body": (
            "สวัสดีคุณพ่อคุณแม่,\n\n"
            "ถึงเวลาอ่านหนังสือกับ {child_alias} แล้วค่ะ\n"
            "ตารางอ่าน: {local_date} เวลา {local_time} ({timezone_name})\n\n"
            "เปิด ViRead: {app_url}\n\n"
            "ขอให้ครอบครัวมีความสุขกับการอ่านนะคะ!"
        ),
    },
    "id": {
        "subject": "Waktunya membaca bersama anak",
        "body": (
            "Halo Ayah dan Bunda,\n\n"
            "Sudah waktunya membaca bersama {child_alias}.\n"
            "Jadwal baca: {local_date} pukul {local_time} ({timezone_name}).\n\n"
            "Buka ViRead: {app_url}\n\n"
            "Selamat menikmati sesi membaca yang menyenangkan bersama keluarga!"
        ),
    },
    "ms": {
        "subject": "Tiba masanya membaca bersama anak",
        "body": (
            "Salam sejahtera ibu bapa,\n\n"
            "Sudah tiba masanya untuk membaca bersama {child_alias}.\n"
            "Jadual bacaan: {local_date} pada {local_time} ({timezone_name}).\n\n"
            "Buka ViRead: {app_url}\n\n"
            "Semoga keluarga anda menikmati sesi membaca yang ceria!"
        ),
    },
    "fil": {
        "subject": "Oras na para magbasa kasama ang anak",
        "body": (
            "Kumusta mga magulang,\n\n"
            "Oras na para magbasa kasama si {child_alias}.\n"
            "Iskedyul ng pagbasa: {local_date} nang {local_time} ({timezone_name}).\n\n"
            "Buksan ang ViRead: {app_url}\n\n"
            "Hangad namin ang masayang oras ng pagbabasa para sa inyong pamilya!"
        ),
    },
    "hi": {
        "subject": "बच्चे के साथ पढ़ने का समय हो गया है",
        "body": (
            "नमस्ते माता-पिता,\n\n"
            "{child_alias} के साथ पढ़ने का समय हो गया है।\n"
            "पढ़ने की समय-सारणी: {local_date} को {local_time} ({timezone_name})।\n\n"
            "ViRead खोलें: {app_url}\n\n"
            "आपके परिवार को आनंदमय पठन सत्र की शुभकामनाएँ!"
        ),
    },
    "bn": {
        "subject": "শিশুর সাথে বই পড়ার সময় হয়েছে",
        "body": (
            "প্রিয় অভিভাবক,\n\n"
            "{child_alias}-এর সাথে বই পড়ার সময় হয়েছে।\n"
            "পড়ার সময়সূচি: {local_date} সময় {local_time} ({timezone_name})।\n\n"
            "ViRead খুলুন: {app_url}\n\n"
            "আপনার পরিবারের জন্য একটি আনন্দময় পাঠ সেশনের শুভেচ্ছা!"
        ),
    },
    "ar": {
        "subject": "حان وقت القراءة مع طفلكم",
        "body": (
            "مرحباً أيها الوالدان،\n\n"
            "لقد حان وقت القراءة مع {child_alias}.\n"
            "موعد القراءة: {local_date} الساعة {local_time} ({timezone_name}).\n\n"
            "افتح ViRead: {app_url}\n\n"
            "نتمنى لعائلتكم جلسة قراءة ممتعة!"
        ),
    },
    "tr": {
        "subject": "Çocuğunuzla okuma zamanı",
        "body": (
            "Merhaba ebeveynler,\n\n"
            "{child_alias} ile okuma zamanı geldi.\n"
            "Okuma planı: {local_date} saat {local_time} ({timezone_name}).\n\n"
            "ViRead'i açın: {app_url}\n\n"
            "Ailenize keyifli bir okuma oturumu dileriz!"
        ),
    },
    "nl": {
        "subject": "Tijd om samen met je kind te lezen",
        "body": (
            "Hallo ouders,\n\n"
            "Het is tijd om samen met {child_alias} te lezen.\n"
            "Leesschema: {local_date} om {local_time} ({timezone_name}).\n\n"
            "Open ViRead: {app_url}\n\n"
            "Veel leesplezier gewenst voor het hele gezin!"
        ),
    },
    "sv": {
        "subject": "Dags att läsa tillsammans med ditt barn",
        "body": (
            "Hej föräldrar,\n\n"
            "Nu är det dags att läsa tillsammans med {child_alias}.\n"
            "Lässchema: {local_date} kl. {local_time} ({timezone_name}).\n\n"
            "Öppna ViRead: {app_url}\n\n"
            "Vi önskar er familj en fin lässtund!"
        ),
    },
    "pl": {
        "subject": "Czas na wspólne czytanie z dzieckiem",
        "body": (
            "Drodzy Rodzice,\n\n"
            "Nadszedł czas na czytanie z {child_alias}.\n"
            "Harmonogram czytania: {local_date} o {local_time} ({timezone_name}).\n\n"
            "Otwórz ViRead: {app_url}\n\n"
            "Życzymy rodzinie radosnej sesji czytania!"
        ),
    },
    "uk": {
        "subject": "Час читати разом із дитиною",
        "body": (
            "Вітаємо, батьки!\n\n"
            "Настав час почитати разом із {child_alias}.\n"
            "Розклад читання: {local_date} о {local_time} ({timezone_name}).\n\n"
            "Відкрити ViRead: {app_url}\n\n"
            "Бажаємо вашій родині приємного читання!"
        ),
    },
    "el": {
        "subject": "Ώρα για ανάγνωση με το παιδί σας",
        "body": (
            "Γεια σας γονείς,\n\n"
            "Ήρθε η ώρα για ανάγνωση με το παιδί {child_alias}.\n"
            "Πρόγραμμα ανάγνωσης: {local_date} στις {local_time} ({timezone_name}).\n\n"
            "Άνοιγμα ViRead: {app_url}\n\n"
            "Ευχόμαστε στην οικογένειά σας μια ευχάριστη συνεδρία ανάγνωσης!"
        ),
    },
    "he": {
        "subject": "הגיע הזמן לקרוא יחד עם הילד",
        "body": (
            "שלום הורים,\n\n"
            "הגיע הזמן לקרוא יחד עם {child_alias}.\n"
            "מועד הקריאה: {local_date} בשעה {local_time} ({timezone_name}).\n\n"
            "פתיחת ViRead: {app_url}\n\n"
            "אנו מאחלים למשפחתכם זמן קריאה מהנה!"
        ),
    },
    "km": {
        "subject": "ដល់ម៉ោងអានសៀវភៅជាមួយកូនហើយ",
        "body": (
            "សួស្តីមាតាបិតា,\n\n"
            "ដល់ម៉ោងអានសៀវភៅជាមួយ {child_alias} ហើយ។\n"
            "កាលវិភាគអាន៖ {local_date} ម៉ោង {local_time} ({timezone_name})។\n\n"
            "បើក ViRead៖ {app_url}\n\n"
            "សូមជូនពរក្រុមគ្រួសារមានពេលអានសៀវភៅដ៏រីករាយ!"
        ),
    },
    "lo": {
        "subject": "ເຖິງເວລາອ່ານປຶ້ມກັບລູກແລ້ວ",
        "body": (
            "ສະບາຍດີພໍ່ແມ່,\n\n"
            "ເຖິງເວລາອ່ານປຶ້ມຮ່ວມກັບ {child_alias} ແລ້ວ.\n"
            "ຕາຕະລາງອ່ານ: {local_date} ເວລາ {local_time} ({timezone_name}).\n\n"
            "ເປີດ ViRead: {app_url}\n\n"
            "ຂໍອວຍພອນໃຫ້ຄອບຄົວມີຊ່ວງເວລາອ່ານປຶ້ມທີ່ມ່ວນຊື່ນ!"
        ),
    },
    "my": {
        "subject": "ကလေးနှင့်အတူ စာဖတ်ချိန် ရောက်ပါပြီ",
        "body": (
            "မင်္ဂလာပါ မိဘများခင်ဗျာ/ရှင်၊\n\n"
            "{child_alias} နှင့်အတူ စာဖတ်ချိန် ရောက်ပါပြီ။\n"
            "စာဖတ်ချိန်ဇယား- {local_date}၊ {local_time} ({timezone_name})။\n\n"
            "ViRead ဖွင့်ရန်- {app_url}\n\n"
            "မိသားစုနှင့်အတူ ပျော်ရွှင်ဖွယ် စာဖတ်ချိန် ဖြစ်ပါစေ!"
        ),
    },
    "ne": {
        "subject": "बच्चासँग किताब पढ्ने समय भयो",
        "body": (
            "नमस्ते अभिभावकज्यू,\n\n"
            "{child_alias} सँग किताब पढ्ने समय भएको छ।\n"
            "पढ्ने तालिका: {local_date} मा {local_time} ({timezone_name})।\n\n"
            "ViRead खोल्नुहोस्: {app_url}\n\n"
            "तपाईंको परिवारलाई रमाइलो पठन समयको शुभकामना!"
        ),
    },
}


# Safety & privacy rule: presence emails state one neutral fact only
# (ViRead paused the session because no reader was seen in the frame for a while).
PRESENCE_ALERT_TEMPLATES: dict[str, dict[str, str]] = {
    "vi": {
        "subject": "ViRead đã tạm dừng buổi đọc",
        "body_with_child": (
            "Chào ba mẹ,\n\n"
            "ViRead đã tạm dừng buổi đọc của {child_alias} vì một lúc không thấy người đọc trong khung hình.\n\n"
            "Khi sẵn sàng, ba mẹ có thể mở ViRead để tiếp tục: {app_url}\n\n"
            'Bạn nhận email này vì đã bật "Nhắc qua email khi không thấy người đọc". '
            "Ba mẹ có thể tắt bất kỳ lúc nào trong phần cài đặt đọc sách."
        ),
        "body_without_child": (
            "Chào ba mẹ,\n\n"
            "ViRead đã tạm dừng buổi đọc vì một lúc không thấy người đọc trong khung hình.\n\n"
            "Khi sẵn sàng, ba mẹ có thể mở ViRead để tiếp tục: {app_url}\n\n"
            'Bạn nhận email này vì đã bật "Nhắc qua email khi không thấy người đọc". '
            "Ba mẹ có thể tắt bất kỳ lúc nào trong phần cài đặt đọc sách."
        ),
    },
    "en": {
        "subject": "ViRead paused the reading session",
        "body_with_child": (
            "Hello parents,\n\n"
            "ViRead paused {child_alias}'s reading session because no reader was seen in the frame for a while.\n\n"
            "When ready, you can open ViRead to continue: {app_url}\n\n"
            'You received this email because "Email alert when no reader is seen" is enabled. '
            "You can turn it off anytime in reading settings."
        ),
        "body_without_child": (
            "Hello parents,\n\n"
            "ViRead paused the reading session because no reader was seen in the frame for a while.\n\n"
            "When ready, you can open ViRead to continue: {app_url}\n\n"
            'You received this email because "Email alert when no reader is seen" is enabled. '
            "You can turn it off anytime in reading settings."
        ),
    },
    "zh-Hans": {
        "subject": "ViRead 已暂停阅读会话",
        "body_with_child": (
            "家长您好，\n\n"
            "由于一段时间未在画面中看到阅读者，ViRead 已暂停 {child_alias} 的阅读会话。\n\n"
            "准备好后，您可以打开 ViRead 继续阅读：{app_url}\n\n"
            "您收到此邮件是因为已开启“未看到阅读者时邮件提醒”。"
            "您可以随时在阅读设置中关闭此选项。"
        ),
        "body_without_child": (
            "家长您好，\n\n"
            "由于一段时间未在画面中看到阅读者，ViRead 已暂停本次阅读会话。\n\n"
            "准备好后，您可以打开 ViRead 继续阅读：{app_url}\n\n"
            "您收到此邮件是因为已开启“未看到阅读者时邮件提醒”。"
            "您可以随时在阅读设置中关闭此选项。"
        ),
    },
    "zh-Hant": {
        "subject": "ViRead 已暫停閱讀工作階段",
        "body_with_child": (
            "家長您好，\n\n"
            "由於一段時間未在畫面中看到閱讀者，ViRead 已暫停 {child_alias} 的閱讀工作階段。\n\n"
            "準備好後，您可以開啟 ViRead 繼續閱讀：{app_url}\n\n"
            "您收到這封郵件是因為已開啟「未看到閱讀者時郵件提醒」。"
            "您可以隨時在閱讀設定中關閉此選項。"
        ),
        "body_without_child": (
            "家長您好，\n\n"
            "由於一段時間未在畫面中看到閱讀者，ViRead 已暫停本次閱讀工作階段。\n\n"
            "準備好後，您可以開啟 ViRead 繼續閱讀：{app_url}\n\n"
            "您收到這封郵件是因為已開啟「未看到閱讀者時郵件提醒」。"
            "您可以隨時在閱讀設定中關閉此選項。"
        ),
    },
    "ja": {
        "subject": "ViRead は読書セッションを一時停止しました",
        "body_with_child": (
            "保護者の皆さまへ\n\n"
            "しばらく画面内に読み手が見えなかったため、ViRead は {child_alias} さんの読書セッションを一時停止しました。\n\n"
            "準備ができたら ViRead を開いて再開できます: {app_url}\n\n"
            "「読み手が見えないときにメールで通知する」が有効になっているため、このメールをお送りしています。"
            "読書設定からいつでもオフにできます。"
        ),
        "body_without_child": (
            "保護者の皆さまへ\n\n"
            "しばらく画面内に読み手が見えなかったため、ViRead は読書セッションを一時停止しました。\n\n"
            "準備ができたら ViRead を開いて再開できます: {app_url}\n\n"
            "「読み手が見えないときにメールで通知する」が有効になっているため、このメールをお送りしています。"
            "読書設定からいつでもオフにできます。"
        ),
    },
    "ko": {
        "subject": "ViRead가 독서 세션을 일시 중지했습니다",
        "body_with_child": (
            "학부모님 안녕하세요,\n\n"
            "잠시 동안 화면에 독자가 보이지 않아 ViRead가 {child_alias}의 독서 세션을 일시 중지했습니다.\n\n"
            "준비가 되면 ViRead를 열어 이어서 진행할 수 있습니다: {app_url}\n\n"
            "\"독자가 보이지 않을 때 이메일 알림\" 설정이 켜져 있어 이 메일이 발송되었습니다. "
            "독서 설정에서 언제든지 끌 수 있습니다."
        ),
        "body_without_child": (
            "학부모님 안녕하세요,\n\n"
            "잠시 동안 화면에 독자가 보이지 않아 ViRead가 독서 세션을 일시 중지했습니다.\n\n"
            "준비가 되면 ViRead를 열어 이어서 진행할 수 있습니다: {app_url}\n\n"
            "\"독자가 보이지 않을 때 이메일 알림\" 설정이 켜져 있어 이 메일이 발송되었습니다. "
            "독서 설정에서 언제든지 끌 수 있습니다."
        ),
    },
    "fr": {
        "subject": "ViRead a mis la séance de lecture en pause",
        "body_with_child": (
            "Bonjour,\n\n"
            "ViRead a mis la séance de lecture de {child_alias} en pause car aucun lecteur n'était visible dans le cadre pendant un moment.\n\n"
            "Lorsque vous êtes prêt, vous pouvez ouvrir ViRead pour reprendre : {app_url}\n\n"
            "Vous recevez cet e-mail car l'option « Alerte par e-mail lorsqu'aucun lecteur n'est visible » est activée. "
            "Vous pouvez la désactiver à tout moment dans les paramètres de lecture."
        ),
        "body_without_child": (
            "Bonjour,\n\n"
            "ViRead a mis la séance de lecture en pause car aucun lecteur n'était visible dans le cadre pendant un moment.\n\n"
            "Lorsque vous êtes prêt, vous pouvez ouvrir ViRead pour reprendre : {app_url}\n\n"
            "Vous recevez cet e-mail car l'option « Alerte par e-mail lorsqu'aucun lecteur n'est visible » est activée. "
            "Vous pouvez la désactiver à tout moment dans les paramètres de lecture."
        ),
    },
    "de": {
        "subject": "ViRead hat die Lesesitzung pausiert",
        "body_with_child": (
            "Hallo liebe Eltern,\n\n"
            "ViRead hat die Lesesitzung von {child_alias} pausiert, da eine Weile keine lesende Person im Bild zu sehen war.\n\n"
            "Wenn Sie bereit sind, können Sie ViRead öffnen, um fortzufahren: {app_url}\n\n"
            "Sie erhalten diese E-Mail, weil die Option „E-Mail-Benachrichtigung, wenn niemand im Bild ist“ aktiviert ist. "
            "Sie können sie jederzeit in den Leseeinstellungen deaktivieren."
        ),
        "body_without_child": (
            "Hallo liebe Eltern,\n\n"
            "ViRead hat die Lesesitzung pausiert, da eine Weile keine lesende Person im Bild zu sehen war.\n\n"
            "Wenn Sie bereit sind, können Sie ViRead öffnen, um fortzufahren: {app_url}\n\n"
            "Sie erhalten diese E-Mail, weil die Option „E-Mail-Benachrichtigung, wenn niemand im Bild ist“ aktiviert ist. "
            "Sie können sie jederzeit in den Leseeinstellungen deaktivieren."
        ),
    },
    "es": {
        "subject": "ViRead pausó la sesión de lectura",
        "body_with_child": (
            "Hola,\n\n"
            "ViRead pausó la sesión de lectura de {child_alias} porque no se vio a ningún lector en el encuadre durante un momento.\n\n"
            "Cuando estén listos, pueden abrir ViRead para continuar: {app_url}\n\n"
            "Recibes este correo porque activaste «Aviso por correo cuando no se vea al lector». "
            "Puedes desactivarlo en cualquier momento desde la configuración de lectura."
        ),
        "body_without_child": (
            "Hola,\n\n"
            "ViRead pausó la sesión de lectura porque no se vio a ningún lector en el encuadre durante un momento.\n\n"
            "Cuando estén listos, pueden abrir ViRead para continuar: {app_url}\n\n"
            "Recibes este correo porque activaste «Aviso por correo cuando no se vea al lector». "
            "Puedes desactivarlo en cualquier momento desde la configuración de lectura."
        ),
    },
    "pt": {
        "subject": "O ViRead pausou a sessão de leitura",
        "body_with_child": (
            "Olá,\n\n"
            "O ViRead pausou a sessão de leitura de {child_alias} porque nenhum leitor foi visto no enquadramento por um tempo.\n\n"
            "Quando estiver pronto, você pode abrir o ViRead para continuar: {app_url}\n\n"
            "Você recebeu este e-mail porque ativou \"Alerta por e-mail quando nenhum leitor for visto\". "
            "Você pode desativar isso a qualquer momento nas configurações de leitura."
        ),
        "body_without_child": (
            "Olá,\n\n"
            "O ViRead pausou a sessão de leitura porque nenhum leitor foi visto no enquadramento por um tempo.\n\n"
            "Quando estiver pronto, você pode abrir o ViRead para continuar: {app_url}\n\n"
            "Você recebeu este e-mail porque ativou \"Alerta por e-mail quando nenhum leitor for visto\". "
            "Você pode desativar isso a qualquer momento nas configurações de leitura."
        ),
    },
    "it": {
        "subject": "ViRead ha messo in pausa la sessione di lettura",
        "body_with_child": (
            "Ciao genitori,\n\n"
            "ViRead ha messo in pausa la sessione di lettura di {child_alias} perché per un po' non è stato visto alcun lettore nell'inquadratura.\n\n"
            "Quando siete pronti, potete aprire ViRead per continuare: {app_url}\n\n"
            "Hai ricevuto questa e-mail perché è attiva l'opzione \"Avviso via e-mail quando non si vede il lettore\". "
            "Puoi disattivarla in qualsiasi momento nelle impostazioni di lettura."
        ),
        "body_without_child": (
            "Ciao genitori,\n\n"
            "ViRead ha messo in pausa la sessione di lettura perché per un po' non è stato visto alcun lettore nell'inquadratura.\n\n"
            "Quando siete pronti, potete aprire ViRead per continuare: {app_url}\n\n"
            "Hai ricevuto questa e-mail perché è attiva l'opzione \"Avviso via e-mail quando non si vede il lettore\". "
            "Puoi disattivarla in qualsiasi momento nelle impostazioni di lettura."
        ),
    },
    "ru": {
        "subject": "ViRead приостановил сеанс чтения",
        "body_with_child": (
            "Здравствуйте!\n\n"
            "ViRead приостановил сеанс чтения для {child_alias}, так как некоторое время в кадре не было видно читающего.\n\n"
            "Когда будете готовы, вы можете открыть ViRead, чтобы продолжить: {app_url}\n\n"
            "Вы получили это письмо, потому что включена функция «Уведомлять по эл. почте, если читающий не виден в кадре». "
            "Вы можете отключить её в любое время в настройках чтения."
        ),
        "body_without_child": (
            "Здравствуйте!\n\n"
            "ViRead приостановил сеанс чтения, так как некоторое время в кадре не было видно читающего.\n\n"
            "Когда будете готовы, вы можете открыть ViRead, чтобы продолжить: {app_url}\n\n"
            "Вы получили это письмо, потому что включена функция «Уведомлять по эл. почте, если читающий не виден в кадре». "
            "Вы можете отключить её в любое время в настройках чтения."
        ),
    },
    "th": {
        "subject": "ViRead ได้หยุดพักเซสชันการอ่านชั่วคราว",
        "body_with_child": (
            "สวัสดีคุณพ่อคุณแม่,\n\n"
            "ViRead ได้หยุดพักเซสชันการอ่านของ {child_alias} ชั่วคราว เนื่องจากไม่เห็นผู้อ่านในกรอบภาพสักครู่\n\n"
            "เมื่อพร้อมแล้ว คุณสามารถเปิด ViRead เพื่อดำเนินการต่อได้ที่: {app_url}\n\n"
            "คุณได้รับอีเมลนี้เนื่องจากเปิดใช้งาน \"แจ้งเตือนทางอีเมลเมื่อไม่เห็นผู้อ่าน\" "
            "สามารถปิดได้ทุกเมื่อในการตั้งค่าการอ่าน"
        ),
        "body_without_child": (
            "สวัสดีคุณพ่อคุณแม่,\n\n"
            "ViRead ได้หยุดพักเซสชันการอ่านชั่วคราว เนื่องจากไม่เห็นผู้อ่านในกรอบภาพสักครู่\n\n"
            "เมื่อพร้อมแล้ว คุณสามารถเปิด ViRead เพื่อดำเนินการต่อได้ที่: {app_url}\n\n"
            "คุณได้รับอีเมลนี้เนื่องจากเปิดใช้งาน \"แจ้งเตือนทางอีเมลเมื่อไม่เห็นผู้อ่าน\" "
            "สามารถปิดได้ทุกเมื่อในการตั้งค่าการอ่าน"
        ),
    },
    "id": {
        "subject": "ViRead menjeda sesi membaca",
        "body_with_child": (
            "Halo Ayah dan Bunda,\n\n"
            "ViRead menjeda sesi membaca {child_alias} karena pembaca tidak terlihat di bingkai untuk sementara waktu.\n\n"
            "Saat siap, Anda dapat membuka ViRead untuk melanjutkan: {app_url}\n\n"
            "Anda menerima email ini karena fitur \"Notifikasi email saat pembaca tidak terlihat\" diaktifkan. "
            "Anda dapat menonaktifkannya kapan saja di pengaturan membaca."
        ),
        "body_without_child": (
            "Halo Ayah dan Bunda,\n\n"
            "ViRead menjeda sesi membaca karena pembaca tidak terlihat di bingkai untuk sementara waktu.\n\n"
            "Saat siap, Anda dapat membuka ViRead untuk melanjutkan: {app_url}\n\n"
            "Anda menerima email ini karena fitur \"Notifikasi email saat pembaca tidak terlihat\" diaktifkan. "
            "Anda dapat menonaktifkannya kapan saja di pengaturan membaca."
        ),
    },
    "ms": {
        "subject": "ViRead menjeda sesi bacaan",
        "body_with_child": (
            "Salam sejahtera ibu bapa,\n\n"
            "ViRead menjeda sesi bacaan {child_alias} kerana pembaca tidak kelihatan dalam bingkai buat seketika.\n\n"
            "Apabila bersedia, anda boleh membuka ViRead untuk meneruskan: {app_url}\n\n"
            "Anda menerima e-mel ini kerana pilihan \"Makluman e-mel apabila tiada pembaca kelihatan\" diaktifkan. "
            "Anda boleh mematikannya pada bila-bila masa dalam tetapan bacaan."
        ),
        "body_without_child": (
            "Salam sejahtera ibu bapa,\n\n"
            "ViRead menjeda sesi bacaan kerana pembaca tidak kelihatan dalam bingkai buat seketika.\n\n"
            "Apabila bersedia, anda boleh membuka ViRead untuk meneruskan: {app_url}\n\n"
            "Anda menerima e-mel ini kerana pilihan \"Makluman e-mel apabila tiada pembaca kelihatan\" diaktifkan. "
            "Anda boleh mematikannya pada bila-bila masa dalam tetapan bacaan."
        ),
    },
    "fil": {
        "subject": "Ipinagpaliban muna ng ViRead ang sesyon ng pagbasa",
        "body_with_child": (
            "Kumusta mga magulang,\n\n"
            "Ipinagpaliban muna ng ViRead ang sesyon ng pagbasa ni {child_alias} dahil walang nakitang mambabasa sa frame nang ilang sandali.\n\n"
            "Kapag handa na, maaari ninyong buksan ang ViRead upang magpatuloy: {app_url}\n\n"
            "Natanggap ninyo ang email na ito dahil naka-on ang \"Abiso sa email kapag walang nakikitang mambabasa\". "
            "Maaari ninyo itong i-off anumang oras sa mga setting ng pagbasa."
        ),
        "body_without_child": (
            "Kumusta mga magulang,\n\n"
            "Ipinagpaliban muna ng ViRead ang sesyon ng pagbasa dahil walang nakitang mambabasa sa frame nang ilang sandali.\n\n"
            "Kapag handa na, maaari ninyong buksan ang ViRead upang magpatuloy: {app_url}\n\n"
            "Natanggap ninyo ang email na ito dahil naka-on ang \"Abiso sa email kapag walang nakikitang mambabasa\". "
            "Maaari ninyo itong i-off anumang oras sa mga setting ng pagbasa."
        ),
    },
    "hi": {
        "subject": "ViRead ने पठन सत्र को रोका है",
        "body_with_child": (
            "नमस्ते माता-पिता,\n\n"
            "कुछ समय तक फ्रेम में कोई पाठक दिखाई न देने के कारण ViRead ने {child_alias} का पठन सत्र अस्थायी रूप से रोका है।\n\n"
            "तैयार होने पर, जारी रखने के लिए आप ViRead खोल सकते हैं: {app_url}\n\n"
            "आपको यह ईमेल इसलिए मिला क्योंकि \"जब कोई पाठक दिखाई न दे तो ईमेल सूचना\" चालू है। "
            "आप इसे किसी भी समय पठन सेटिंग्स में बंद कर सकते हैं।"
        ),
        "body_without_child": (
            "नमस्ते माता-पिता,\n\n"
            "कुछ समय तक फ्रेम में कोई पाठक दिखाई न देने के कारण ViRead ने पठन सत्र अस्थायी रूप से रोका है।\n\n"
            "तैयार होने पर, जारी रखने के लिए आप ViRead खोल सकते हैं: {app_url}\n\n"
            "आपको यह ईमेल इसलिए मिला क्योंकि \"जब कोई पाठक दिखाई न दे तो ईमेल सूचना\" चालू है। "
            "आप इसे किसी भी समय पठन सेटिंग्स में बंद कर सकते हैं।"
        ),
    },
    "bn": {
        "subject": "ViRead পাঠ সেশনটি সাময়িকভাবে বিরতি দিয়েছে",
        "body_with_child": (
            "প্রিয় অভিভাবক,\n\n"
            "কিছু সময় ফ্রেমে কোনো পাঠককে দেখা না যাওয়ায় ViRead {child_alias}-এর পাঠ সেশনটি সাময়িকভাবে বিরতি দিয়েছে।\n\n"
            "প্রস্তুত হলে, চালিয়ে যেতে আপনি ViRead খুলতে পারেন: {app_url}\n\n"
            "\"পাঠককে দেখা না গেলে ইমেইল সতর্কতা\" চালু থাকায় আপনি এই ইমেইলটি পেয়েছেন। "
            "আপনি যেকোনো সময় পাঠ সেটিংস থেকে এটি বন্ধ করতে পারেন।"
        ),
        "body_without_child": (
            "প্রিয় অভিভাবক,\n\n"
            "কিছু সময় ফ্রেমে কোনো পাঠককে দেখা না যাওয়ায় ViRead পাঠ সেশনটি সাময়িকভাবে বিরতি দিয়েছে।\n\n"
            "প্রস্তুত হলে, চালিয়ে যেতে আপনি ViRead খুলতে পারেন: {app_url}\n\n"
            "\"পাঠককে দেখা না গেলে ইমেইল সতর্কতা\" চালু থাকায় আপনি এই ইমেইলটি পেয়েছেন। "
            "আপনি যেকোনো সময় পাঠ সেটিংস থেকে এটি বন্ধ করতে পারেন।"
        ),
    },
    "ar": {
        "subject": "أوقف ViRead جلسة القراءة مؤقتاً",
        "body_with_child": (
            "مرحباً أيها الوالدان،\n\n"
            "أوقف ViRead جلسة القراءة الخاصة بـ {child_alias} مؤقتاً لعدم ظهور قارئ في الإطار لفترة قصيرة.\n\n"
            "عندما تكونون مستعدين، يمكنكم فتح ViRead للمتابعة: {app_url}\n\n"
            "تلقّيتم هذا البريد الإلكتروني لأن خيار \"تنبيه عبر البريد الإلكتروني عند عدم رؤية قارئ\" مفعّل. "
            "يمكنكم إيقافه في أي وقت من إعدادات القراءة."
        ),
        "body_without_child": (
            "مرحباً أيها الوالدان،\n\n"
            "أوقف ViRead جلسة القراءة مؤقتاً لعدم ظهور قارئ في الإطار لفترة قصيرة.\n\n"
            "عندما تكونون مستعدين، يمكنكم فتح ViRead للمتابعة: {app_url}\n\n"
            "تلقّيتم هذا البريد الإلكتروني لأن خيار \"تنبيه عبر البريد الإلكتروني عند عدم رؤية قارئ\" مفعّل. "
            "يمكنكم إيقافه في أي وقت من إعدادات القراءة."
        ),
    },
    "tr": {
        "subject": "ViRead okuma oturumunu duraklattı",
        "body_with_child": (
            "Merhaba ebeveynler,\n\n"
            "ViRead, bir süre çerçevede okuyucu görülmediği için {child_alias} adlı çocuğun okuma oturumunu duraklattı.\n\n"
            "Hazır olduğunuzda devam etmek için ViRead'i açabilirsiniz: {app_url}\n\n"
            "Bu e-postayı \"Okuyucu görülmediğinde e-posta ile bildir\" seçeneği açık olduğu için aldınız. "
            "Okuma ayarlarından istediğiniz zaman kapatabilirsiniz."
        ),
        "body_without_child": (
            "Merhaba ebeveynler,\n\n"
            "ViRead, bir süre çerçevede okuyucu görülmediği için okuma oturumunu duraklattı.\n\n"
            "Hazır olduğunuzda devam etmek için ViRead'i açabilirsiniz: {app_url}\n\n"
            "Bu e-postayı \"Okuyucu görülmediğinde e-posta ile bildir\" seçeneği açık olduğu için aldınız. "
            "Okuma ayarlarından istediğiniz zaman kapatabilirsiniz."
        ),
    },
    "nl": {
        "subject": "ViRead heeft de leessessie gepauzeerd",
        "body_with_child": (
            "Hallo ouders,\n\n"
            "ViRead heeft de leessessie van {child_alias} gepauzeerd omdat er even geen lezer in beeld te zien was.\n\n"
            "Wanneer u klaar bent, kunt u ViRead openen om verder te gaan: {app_url}\n\n"
            "U ontvangt deze e-mail omdat \"E-mailmelding wanneer er geen lezer in beeld is\" is ingeschakeld. "
            "U kunt dit op elk moment uitschakelen in de leesinstellingen."
        ),
        "body_without_child": (
            "Hallo ouders,\n\n"
            "ViRead heeft de leessessie gepauzeerd omdat er even geen lezer in beeld te zien was.\n\n"
            "Wanneer u klaar bent, kunt u ViRead openen om verder te gaan: {app_url}\n\n"
            "U ontvangt deze e-mail omdat \"E-mailmelding wanneer er geen lezer in beeld is\" is ingeschakeld. "
            "U kunt dit op elk moment uitschakelen in de leesinstellingen."
        ),
    },
    "sv": {
        "subject": "ViRead pausade lässessionen",
        "body_with_child": (
            "Hej föräldrar,\n\n"
            "ViRead pausade lässessionen för {child_alias} eftersom ingen läsare syntes i bildrutan under en stund.\n\n"
            "När ni är redo kan ni öppna ViRead för att fortsätta: {app_url}\n\n"
            "Du får detta mejl eftersom \"E-postavisering när ingen läsare syns\" är aktiverat. "
            "Du kan stänga av det när som helst i läsinställningarna."
        ),
        "body_without_child": (
            "Hej föräldrar,\n\n"
            "ViRead pausade lässessionen eftersom ingen läsare syntes i bildrutan under en stund.\n\n"
            "När ni är redo kan ni öppna ViRead för att fortsätta: {app_url}\n\n"
            "Du får detta mejl eftersom \"E-postavisering när ingen läsare syns\" är aktiverat. "
            "Du kan stänga av det när som helst i läsinställningarna."
        ),
    },
    "pl": {
        "subject": "ViRead wstrzymał sesję czytania",
        "body_with_child": (
            "Drodzy Rodzice,\n\n"
            "ViRead wstrzymał sesję czytania dziecka {child_alias}, ponieważ przez chwilę w kadrze nie było widać czytającego.\n\n"
            "Gdy będziecie gotowi, możecie otworzyć ViRead, aby kontynuować: {app_url}\n\n"
            "Otrzymujesz tę wiadomość, ponieważ włączono opcję „Powiadomienie e-mail, gdy czytający nie jest widoczny”. "
            "Możesz ją wyłączyć w dowolnym momencie w ustawieniach czytania."
        ),
        "body_without_child": (
            "Drodzy Rodzice,\n\n"
            "ViRead wstrzymał sesję czytania, ponieważ przez chwilę w kadrze nie było widać czytającego.\n\n"
            "Gdy będziecie gotowi, możecie otworzyć ViRead, aby kontynuować: {app_url}\n\n"
            "Otrzymujesz tę wiadomość, ponieważ włączono opcję „Powiadomienie e-mail, gdy czytający nie jest widoczny”. "
            "Możesz ją wyłączyć w dowolnym momencie w ustawieniach czytania."
        ),
    },
    "uk": {
        "subject": "ViRead призупинив сеанс читання",
        "body_with_child": (
            "Вітаємо, батьки!\n\n"
            "ViRead призупинив сеанс читання для {child_alias}, оскільки певний час у кадрі не було видно читача.\n\n"
            "Коли будете готові, відкрийте ViRead, щоб продовжити: {app_url}\n\n"
            "Ви отримали цей лист, оскільки увімкнено параметр «Повідомлення на е-пошту, коли читача не видно». "
            "Ви можете вимкнути його будь-коли в налаштуваннях читання."
        ),
        "body_without_child": (
            "Вітаємо, батьки!\n\n"
            "ViRead призупинив сеанс читання, оскільки певний час у кадрі не було видно читача.\n\n"
            "Коли будете готові, відкрийте ViRead, щоб продовжити: {app_url}\n\n"
            "Ви отримали цей лист, оскільки увімкнено параметр «Повідомлення на е-пошту, коли читача не видно». "
            "Ви можете вимкнути його будь-коли в налаштуваннях читання."
        ),
    },
    "el": {
        "subject": "Το ViRead έθεσε σε παύση τη συνεδρία ανάγνωσης",
        "body_with_child": (
            "Γεια σας γονείς,\n\n"
            "Το ViRead έθεσε σε παύση τη συνεδρία ανάγνωσης για το παιδί {child_alias} επειδή δεν φαινόταν αναγνώστης στο κάδρο για λίγο.\n\n"
            "Όταν είστε έτοιμοι, μπορείτε να ανοίξετε το ViRead για να συνεχίσετε: {app_url}\n\n"
            "Λάβατε αυτό το email επειδή έχετε ενεργοποιήσει την επιλογή «Ειδοποίηση email όταν δεν φαίνεται αναγνώστης». "
            "Μπορείτε να την απενεργοποιήσετε ανά πάσα στιγμή στις ρυθμίσεις ανάγνωσης."
        ),
        "body_without_child": (
            "Γεια σας γονείς,\n\n"
            "Το ViRead έθεσε σε παύση τη συνεδρία ανάγνωσης επειδή δεν φαινόταν αναγνώστης στο κάδρο για λίγο.\n\n"
            "Όταν είστε έτοιμοι, μπορείτε να ανοίξετε το ViRead για να συνεχίσετε: {app_url}\n\n"
            "Λάβατε αυτό το email επειδή έχετε ενεργοποιήσει την επιλογή «Ειδοποίηση email όταν δεν φαίνεται αναγνώστης». "
            "Μπορείτε να την απενεργοποιήσετε ανά πάσα στιγμή στις ρυθμίσεις ανάγνωσης."
        ),
    },
    "he": {
        "subject": "ViRead השהה את הפעלת הקריאה",
        "body_with_child": (
            "שלום הורים,\n\n"
            "ViRead השהה את הפעלת הקריאה של {child_alias} מאחר שלא נראה קורא במסגרת למשך זמן מה.\n\n"
            "כשתהיו מוכנים, תוכלו לפתוח את ViRead כדי להמשיך: {app_url}\n\n"
            "קיבלתם הודעה זו משום שהאפשרות \"התראה בדוא\"ל כאשר לא נראה קורא\" מופעלת. "
            "ניתן לכבות אותה בכל עת בהגדרות הקריאה."
        ),
        "body_without_child": (
            "שלום הורים,\n\n"
            "ViRead השהה את הפעלת הקריאה מאחר שלא נראה קורא במסגרת למשך זמן מה.\n\n"
            "כשתהיו מוכנים, תוכלו לפתוח את ViRead כדי להמשיך: {app_url}\n\n"
            "קיבלתם הודעה זו משום שהאפשרות \"התראה בדוא\"ל כאשר לא נראה קורא\" מופעלת. "
            "ניתן לכבות אותה בכל עת בהגדרות הקריאה."
        ),
    },
    "km": {
        "subject": "ViRead បានផ្អាកវគ្គអានជាបណ្តោះអាសន្ន",
        "body_with_child": (
            "សួស្តីមាតាបិតា,\n\n"
            "ViRead បានផ្អាកវគ្គអានរបស់ {child_alias} ជាបណ្តោះអាសន្ន ដោយសារមិនឃើញអ្នកអាននៅក្នុងស៊ុមមួយសន្ទុះ។\n\n"
            "ពេលរួចរាល់ មាតាបិតាអាចបើក ViRead ដើម្បីបន្ត៖ {app_url}\n\n"
            "អ្នកទទួលអ៊ីមែលនេះ ដោយសារបានបើក \"ជូនដំណឹងតាមអ៊ីមែលពេលមិនឃើញអ្នកអាន\"។ "
            "អ្នកអាចបិទវាបានគ្រប់ពេលក្នុងការកំណត់ការអាន។"
        ),
        "body_without_child": (
            "សួស្តីមាតាបិតា,\n\n"
            "ViRead បានផ្អាកវគ្គអានជាបណ្តោះអាសន្ន ដោយសារមិនឃើញអ្នកអាននៅក្នុងស៊ុមមួយសន្ទុះ។\n\n"
            "ពេលរួចរាល់ មាតាបិតាអាចបើក ViRead ដើម្បីបន្ត៖ {app_url}\n\n"
            "អ្នកទទួលអ៊ីមែលនេះ ដោយសារបានបើក \"ជូនដំណឹងតាមអ៊ីមែលពេលមិនឃើញអ្នកអាន\"។ "
            "អ្នកអាចបិទវាបានគ្រប់ពេលក្នុងការកំណត់ការអាន។"
        ),
    },
    "lo": {
        "subject": "ViRead ໄດ້ຢຸດຊົ່ວຄາວການອ່ານ",
        "body_with_child": (
            "ສະບາຍດີພໍ່ແມ່,\n\n"
            "ViRead ໄດ້ຢຸດຊົ່ວຄາວການອ່ານຂອງ {child_alias} ເນື່ອງຈາກບໍ່ເຫັນຜູ້ອ່ານຢູ່ໃນກອບພາບໄລຍະໜຶ່ງ.\n\n"
            "ເມື່ອພ້ອມແລ້ວ, ພໍ່ແມ່ສາມາດເປີດ ViRead ເພື່ອສືບຕໍ່ໄດ້ທີ່: {app_url}\n\n"
            "ທ່ານໄດ້ຮັບອີເມວນີ້ເນື່ອງຈາກໄດ້ເປີດໃຊ້ \"ແຈ້ງເຕືອນທາງອີເມວເມື່ອບໍ່ເຫັນຜູ້ອ່ານ\". "
            "ທ່ານສາມາດປິດໄດ້ທຸກເວລາໃນການຕັ້ງຄ່າການອ່ານ."
        ),
        "body_without_child": (
            "ສະບາຍດີພໍ່ແມ່,\n\n"
            "ViRead ໄດ້ຢຸດຊົ່ວຄາວການອ່ານ ເນື່ອງຈາກບໍ່ເຫັນຜູ້ອ່ານຢູ່ໃນກອບພາບໄລຍະໜຶ່ງ.\n\n"
            "ເມື່ອພ້ອມແລ້ວ, ພໍ່ແມ່ສາມາດເປີດ ViRead ເພື່ອສືບຕໍ່ໄດ້ທີ່: {app_url}\n\n"
            "ທ່ານໄດ້ຮັບອີເມວນີ້ເນື່ອງຈາກໄດ້ເປີດໃຊ້ \"ແຈ້ງເຕືອນທາງອີເມວເມື່ອບໍ່ເຫັນຜູ້ອ່ານ\". "
            "ທ່ານສາມາດປິດໄດ້ທຸກເວລາໃນການຕັ້ງຄ່າການອ່ານ."
        ),
    },
    "my": {
        "subject": "ViRead သည် စာဖတ်ခြင်းကို ခေတ္တရပ်နားထားပါသည်",
        "body_with_child": (
            "မင်္ဂလာပါ မိဘများခင်ဗျာ/ရှင်၊\n\n"
            "ဘောင်အတွင်း၌ စာဖတ်သူကို ခဏတာ မတွေ့ရသဖြင့် ViRead သည် {child_alias} ၏ စာဖတ်ခြင်းကို ခေတ္တရပ်နားထားပါသည်။\n\n"
            "အဆင်သင့်ဖြစ်သည့်အခါ ဆက်လက်ဖတ်ရှုရန် ViRead ကို ဖွင့်နိုင်ပါသည်- {app_url}\n\n"
            "\"စာဖတ်သူကို မတွေ့ရသည့်အခါ အီးမေးလ်ဖြင့် အကြောင်းကြားရန်\" ကို ဖွင့်ထားသောကြောင့် ဤအီးမေးလ်ကို ရရှိခြင်းဖြစ်ပါသည်။ "
            "စာဖတ်ခြင်း ဆက်တင်များတွင် အချိန်မရွေး ပြန်ပိတ်နိုင်ပါသည်။"
        ),
        "body_without_child": (
            "မင်္ဂလာပါ မိဘများခင်ဗျာ/ရှင်၊\n\n"
            "ဘောင်အတွင်း၌ စာဖတ်သူကို ခဏတာ မတွေ့ရသဖြင့် ViRead သည် စာဖတ်ခြင်းကို ခေတ္တရပ်နားထားပါသည်။\n\n"
            "အဆင်သင့်ဖြစ်သည့်အခါ ဆက်လက်ဖတ်ရှုရန် ViRead ကို ဖွင့်နိုင်ပါသည်- {app_url}\n\n"
            "\"စာဖတ်သူကို မတွေ့ရသည့်အခါ အီးမေးလ်ဖြင့် အကြောင်းကြားရန်\" ကို ဖွင့်ထားသောကြောင့် ဤအီးမေးလ်ကို ရရှိခြင်းဖြစ်ပါသည်။ "
            "စာဖတ်ခြင်း ဆက်တင်များတွင် အချိန်မရွေး ပြန်ပိတ်နိုင်ပါသည်။"
        ),
    },
    "ne": {
        "subject": "ViRead ले पठन सत्र रोकेको छ",
        "body_with_child": (
            "नमस्ते अभिभावकज्यू,\n\n"
            "केही बेर फ्रेममा पाठक नदेखिएकाले ViRead ले {child_alias} को पठन सत्र अस्थायी रूपमा रोकेको छ।\n\n"
            "तयार भएपछि, निरन्तरता दिन ViRead खोल्न सक्नुहुन्छ: {app_url}\n\n"
            "\"पाठक नदेखिँदा इमेल सूचना\" सक्षम पारिएकाले तपाईंले यो इमेल प्राप्त गर्नुभएको हो। "
            "तपाईंले पठन सेटिङमा जुनसुकै बेला यसलाई बन्द गर्न सक्नुहुन्छ।"
        ),
        "body_without_child": (
            "नमस्ते अभिभावकज्यू,\n\n"
            "केही बेर फ्रेममा पाठक नदेखिएकाले ViRead ले पठन सत्र अस्थायी रूपमा रोकेको छ।\n\n"
            "तयार भएपछि, निरन्तरता दिन ViRead खोल्न सक्नुहुन्छ: {app_url}\n\n"
            "\"पाठक नदेखिँदा इमेल सूचना\" सक्षम पारिएकाले तपाईंले यो इमेल प्राप्त गर्नुभएको हो। "
            "तपाईंले पठन सेटिङमा जुनसुकै बेला यसलाई बन्द गर्न सक्नुहुन्छ।"
        ),
    },
}


def render_reading_reminder_email(
    *,
    locale: str | None = None,
    child_alias: str,
    local_date: str,
    local_time: str,
    timezone_name: str,
    app_url: str,
) -> RenderedEmailTemplate:
    """Render a localized reading reminder email preserving schedule/timezone strings verbatim."""
    resolved = resolve_supported_locale(locale)
    template = READING_REMINDER_TEMPLATES.get(resolved) or READING_REMINDER_TEMPLATES["vi"]
    body = template["body"].format(
        child_alias=child_alias,
        local_date=local_date,
        local_time=local_time,
        timezone_name=timezone_name,
        app_url=app_url,
    )
    return RenderedEmailTemplate(locale=resolved, subject=template["subject"], body=body)


def render_reading_presence_email(
    *,
    locale: str | None = None,
    child_alias: str | None,
    app_url: str,
) -> RenderedEmailTemplate:
    """Render a localized neutral reading presence alert email."""
    resolved = resolve_supported_locale(locale)
    template = PRESENCE_ALERT_TEMPLATES.get(resolved) or PRESENCE_ALERT_TEMPLATES["vi"]
    if child_alias:
        body = template["body_with_child"].format(child_alias=child_alias, app_url=app_url)
    else:
        body = template["body_without_child"].format(app_url=app_url)
    return RenderedEmailTemplate(locale=resolved, subject=template["subject"], body=body)
