# Nguồn âm thanh và thử nghiệm engine — 2026-11-17

Đây là ghi nhận nghiên cứu, không phải danh sách bài đã xuất bản hoặc chứng nhận
quyền thương mại. Không tải dữ liệu này lên Supabase hay đưa raw corpus vào Git.

Đợt tự tìm nhạc thiếu nhi tiếp theo đã tải và chạy diagnostic hai bản hát đầy đủ;
chưa đủ quyền/nghe duyệt để nghiệm thu. Kết quả/lỗi thật, timeout và hash nằm ở
[PUBLIC-SONG-DIAGNOSTIC-20261117.md](PUBLIC-SONG-DIAGNOSTIC-20261117.md).

## ViCa — corpus hiệu chuẩn sơ bộ

- Nguồn tác giả: https://github.com/apleGitHub/ViCa, release v1.0.
- Tệp: ViCa_Dataset.zip, 99.488.439 byte.
- SHA256: `82bea209b730583bce0645a8481fdd2947dee1dad1dbf1e250fc3e8200f69692`.
- Ghi công: aple (tác giả, giọng, nhãn); alex floarea (nhãn).
- README ghi CC BY 4.0 và có điều khoản bổ sung: được nghiên cứu, không phân phối
  lại raw files, không chuyển đổi/clone giọng bằng SVC. Task chỉ phân tích alignment
  local, không huấn luyện hay biến đổi giọng.
- 477 WAV + 477 LAB đã tải/extract local với kiểm tra traversal/kích thước.
- Đây là corpus âm vị, không phải 477 bài hát. Tác giả tự ghi cách phát âm chưa
  thành thạo; không dùng làm nguồn duy nhất hoặc bài karaoke phát cho trẻ.

## Model thử riêng

- Model card: https://huggingface.co/nguyenvulebinh/lyric-alignment.
- Revision: `2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed`.
- SHA256 pytorch_model.bin:
  `0c25b2cd0aaea6417a0ed325493300d1a46799c2e123dafd73412cafa1886123`.
- Weights CC-BY-NC-4.0; code nguồn Apache-2.0. Không suy giấy phép weights từ code.
  Chưa phê duyệt sử dụng thương mại.
- Chạy trong venv riêng: torch/torchaudio 2.8.0 CPU, transformers 4.57.6,
  numpy 2.2.6, scipy 1.16.3, soundfile 0.13.1, imageio-ffmpeg 0.6.0,
  demucs 4.0.1. Không cài vào backend OCR environment.
- Stock Wav2Vec2ForCTC không đủ kiến trúc checkpoint: phải có feature_transform
  đã huấn luyện. Loader hiện kiểm missing/unexpected/mismatched keys.
- Đã chạy stem separation thật trên composite kỹ thuật ngắn ở phần dưới;
  chưa có đánh giá chất lượng stems trên bài đại diện hoặc người dùng nghe duyệt.

## Kết quả preflight thực tế

Phần dưới là mốc envelope-v1 lịch sử. Phép đo boundary-v2 sau đó, có phân biệt
raw engine với output được mapper chấp nhận, ở [QUALITY-20261117.md](QUALITY-20261117.md).

Input là 5 utterances ViCa, mỗi clip 2 tiếng, **không phải 5 bài hát**. Reference lấy
nhãn LAB có sẵn, chưa có người nghe kiểm lại; cả 5 thuộc hiệu chuẩn sơ bộ, không
gắn nhãn held-out. Không thay đổi lời theo transcript nhận dạng.

| Case   | Sai onset 2 tiếng (ms) | Sai end có evidence (ms) | End thiếu |
| ------ | ---------------------- | ------------------------ | --------- |
| -ba_ba | 122 / 150              | 29 (tiếng 2)             | tiếng 1   |
| -ma_ma | 144 / 97               | 12 (tiếng 2)             | tiếng 1   |
| -na_na | 100 / 70               | 9 (tiếng 2)              | tiếng 1   |
| -la_la | 80 / 100               | 14 (tiếng 2)             | tiếng 1   |
| -va_va | 133 / 81               | 5 (tiếng 2)              | tiếng 1   |

CTC thô kết thúc tại spike đầu nguyên âm nên có thể hụt tiếng ngân hơn 800ms.
Bước envelope mới chỉ nhận cuối tiếng khi có vùng lặng hoặc energy valley đủ rõ;
không có evidence thì end=null, không kéo dài đến đầu tiếng kế tiếp.

Chỉ 5/10 tiếng có cặp mốc: coverage=0,5. Theo quy tắc evaluator cần cặp mốc hợp lệ,
onset hit-rate toàn reference chỉ 5/10, **không phải 100%** dù cả 10 onset thô
nằm trong 250ms. Nhận dạng “ma ma” thành “na na”, “va va” thành “gà rà” cũng cho
thấy cần kiểm mismatch và hiệu chuẩn support. Không gọi support là % chính xác.

**Quality gate chưa đạt.** Chưa có 5–10 bài đại diện, annotation nghe kiểm lại,
held-out, nhạc nền đã tách được nghe duyệt, hoặc phép đo correction time/peak RAM.
Không bật READY tự động hoặc production trên cơ sở các số này.

## Composite kỹ thuật và worker thật (không phải song benchmark)

Demucs 4.0.1, checkpoint htdemucs 84.141.911 byte từ máy chủ chính thức,
SHA256 `8726e21a993978c7ba086d3872e7608d7d5bfca646ca4aca459ffda844faa8b4`.
Đã nạp weights_only=True với allowlist tối thiểu, không tải pickle tùy ý.
Nguồn implementation/model list:
[Demucs v4.0.1](https://github.com/facebookresearch/demucs/tree/v4.0.1).

Ghép riêng local một utterance ViCa với đoạn đầu piano Ngôi sao nhỏ đã có quyền
dùng, chỉ để thử đường xử lý. Không phát hành raw/derivative corpus, không upload
Supabase hoặc dùng làm bài cho trẻ:

- Composite “ba ba”: SHA256
  `98d26f7c678c9ba2832ce0d3a860b83c63c8da6bbaa4a15077b90cded3ceff2b`.
  Tách/encode thành công nhưng nhận dạng “ma ma”, support thấp, thiếu một end.
  Việc script smoke chạy xong không có nghĩa candidate qua guard khớp lời.
- Composite “la la”: SHA256
  `394b6ecb503152b1854036725e8900b9ac1865057434de4b699f96e7cab37ef0`.
  Transcript “la la”; onset 880/1920ms, end null/3000ms.
  Vẫn thiếu 1/2 end, không đạt tiêu chuẩn tự động hoàn chỉnh.
- Hai stems MP3 ở cả hai case có clock đo tại 3 anchor: offset0ms, minimum
  waveform correlation so với PCM trước encode ít nhất0,9999. Đây chỉ là kiểm
  timeline/codec, **không phải** SDR/MOS hoặc chất lượng tách nhạc được nghe duyệt.
- Ca opt-in worker + Demucs/CTC thật + PostgreSQL disposable + Storage bộ nhớ
  dùng composite “la la” đã đạt: staging → apply v2 → publish/review bị chặn
  vì timing chưa đủ. Tổng test80,616s gồm setup SQL và model startup/inference,
  không suy ra RTF của bài dài hoặc chi phí vận hành.

Đây là calibration/preflight kỹ thuật. Chưa có benchmark 5–10 bài hoàn chỉnh,
held-out/annotation nghe kiểm lại và review của chủ dự án. Quality gate vẫn chưa đạt.

## Nguồn bài hát đã khảo sát nhưng chưa sử dụng

- [Xuân an bình — Nhiêu Lộc](https://commons.wikimedia.org/wiki/File:Xuan_an_binh.ogg):
  trang tác giả khai báo CC BY-SA 3.0; file dài 342,408s, vượt giới hạn 5 phút.
  Download trả 429 ở lần trước; không né rate limit. Chưa có file để benchmark.
- [Hát trống quân — Đỗ Văn Thâm](https://commons.wikimedia.org/wiki/File:Hát_trống_quân_-_Đỗ_Văn_Thâm.mp3):
  bản thu lịch sử, nguồn BnF; download Wikimedia trả 429, BnF trả 403.
  Không vượt chặn truy cập. Chưa có file/lời chuẩn để thử.
- [Âm nhạc Trường Việt Anh](https://truongvietanh.com/am-nhac/):
  điều khoản chỉ cho tải/dùng tự do trong phạm vi cộng đồng trường, dùng/phối
  lại bên ngoài cần xin phép. Không tải cho ứng dụng này, không sao chép lời.
- VietnameseLyricsTranscription/song_dataset: dữ liệu gated hoặc nguồn thương mại
  không kèm quyền bản thu phù hợp. Không chấp nhận gate thay người dùng, không
  scrape nhạc rồi coi license metadata là license audio.

Tiếp tục tìm nguồn có quyền phù hợp; không dùng nguyên liệu không rõ quyền để
đánh dấu hoàn thành benchmark hay xuất bản bài mẫu.

### Rà soát bổ sung khi tiếp tục — chưa tải hoặc duyệt sử dụng

- [Những Hạt Giống Mới — Tranhungdaohp](https://commons.wikimedia.org/wiki/File:Những_Hạt_Giống_Mới.ogg):
  trang file khai báo own work, CC BY-SA 3.0, 2 phút 55 giây, 990 KB.
  Đây mới là ứng viên dưới giới hạn duration: chưa nghe kiểm tra có vocal/lời
  chính xác, độ phù hợp trẻ em hoặc tách đầy đủ quyền bản thu/tác phẩm. Chưa tải,
  chưa benchmark, chưa thêm vào ứng dụng; không tính là một bài đã được duyệt.
  Lần tải media sau khảo sát trả429; không tải được file, không thử né rate limit.
- [Lên ngàn — Nguyễn Thanh Tùng](https://commons.wikimedia.org/wiki/File:Len_ngan_-_Thanh_Tung.ogg):
  trang ghi CC BY 3.0, 3 phút 48 giây, nhưng mô tả tác phẩm độc tấu đàn bầu.
  Không dùng làm positive-case căn lời hát; chưa tải hoặc benchmark.
- [SMAD model card](https://huggingface.co/duclvQ/smad): có nhận diện singing,
  không phải aligner; tác giả tự ghi test synthetic, còn nhầm singing/no-voice
  và upstream training audio có hạn chế NC/không có license grant. Không cài thêm
  model này hoặc coi nhãn MIT của repo là quyền âm thanh upstream. Không dùng
  số liệu của model card làm kết quả của pipeline dự án.

Các nguồn này không khắc phục việc thiếu tập 5–10 bài Việt phù hợp đã được
nghe/annotate. Không thay đổi quyết định chưa bật production.
