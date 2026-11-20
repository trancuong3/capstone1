# Negative-case thực và sửa shutdown worker — 2026-11-17

Đây là bằng chứng bổ sung cho Phase 1/3, không phải nghiệm thu Phase 5/6.
Giữ nguyên yêu cầu benchmark bài Việt có vocal và nghe duyệt. Chủ dự án xác nhận
hiện không có bộ bài để cung cấp; không coi xác nhận phi thương mại là cho phép
bỏ quality gate hoặc sử dụng bản thu không rõ quyền.

## Engine thật: không có vocal phải từ chối

Đã chạy adapter subprocess local thật, Demucs 4.0.1 với checkpoint
`955717e8-8726e21a.th` được kiểm hash; engine alignment pin
`2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed:ctc-delimiter-envelope-v2`.
Hai ca đều được đưa vào với 126 tiếng lời đang có của bộ thử, không sửa lời
theo output model để tạo kết quả thành công.

| Case    | Đầu vào                             | Thời lượng MP3 đo được | Wall time  | Kết quả thật                    |
| ------- | ----------------------------------- | ---------------------- | ---------- | ------------------------------- |
| silence | Im lặng sinh local, chỉ là negative | 3.527 ms               | 14,2999 s  | `NO_USABLE_VOCALS` ở separation |
| piano   | Bản piano nguyên file đã có quyền   | 103.366 ms             | 174,4361 s | `NO_USABLE_VOCALS` ở separation |

Không ca nào tạo candidate hoặc timestamps. CTC/mapping không được chạy tiếp
sau khi bước separation từ chối. Ca piano dùng nguyên MP3, không cắt thành clip
ngắn để làm đẹp thời gian; nguồn/ghi công CC BY 4.0 ở
[bộ thử gốc](../karaoke-demo/README.md#nhạc-và-quyền-sử-dụng).
Đây là một bản **instrumental** hoàn chỉnh, không phải positive Vietnamese song.
File im lặng sinh local cũng không được tính thành bài hát hoặc human annotation.

Input SHA256:

- Silence: `7c613fbde94502d9c454ada8e31777608714bcbd75fef994f67223ea19228534`.
- Piano: `47ebba49be8b7bc776db49c7918b88f0dedfd52f8ccb21e35f6a16e7cb9cbfd6`.

Report local `negative-v2-20261117-r2.json`, SHA256
`1730b2b425ed2ab6a7c143e40c4a0215db7044dd7675d4ca1cff24501543cac1`.
Không có Supabase, provider trả phí, upload, publication hoặc giọng trẻ trong
lượt này. Chi phí máy/điện/hosting, peak RAM toàn pipeline, chất lượng stems được
nghe và correction time vẫn chưa đo; không ghi chúng thành 0.

Lượt đo trước đó mất native session và không còn tiến trình tương ứng khi kiểm
tra. Temp artifact của tài khoản cũ không đọc được; không nới ACL và không ghi
lượt đó thành pass. Lượt r2 tạo input bằng đúng tài khoản chạy, lưu report vào
cache kế thừa quyền bên ngoài private temp và đã quan sát exit 0.

### Hệ quả vận hành từ phép đo

Một bước separation cho file 103 giây đã mất khoảng 174 giây CPU, khá sát timeout
mặc định 180 giây. Không suy ra hỗ trợ mọi file 5 phút trong 180 giây hoặc hứa ETA.
Trước rollout phải đo bài có vocal trên máy đích và đặt timeout riêng có giới hạn
qua `KARAOKE_PROVIDER_TIMEOUT_SECONDS`, concurrency và caps phù hợp. Không tự đổi
`.env` thật hay tăng quota để che giới hạn. Job timeout vẫn phải báo lỗi/retry theo
ledger, không chuyển thành kết quả thành công hoặc gọi dịch vụ trả phí thay thế.

## Worker shutdown

Lượt SQL trước đã quan sát `CancelledError` khi đóng connection. Worker cũ đặt
finished rồi lập tức cancel heartbeat, có thể cắt ngang asyncpg context exit.
Đã sửa **chỉ worker karaoke**:

- Đặt finished để heartbeat idle thức dậy ngay; cho heartbeat đang có SQL tối đa
  5 giây hoàn tất và đóng connection tự nhiên.
- Nếu hết grace hoặc worker bị hủy trong lúc chờ, cancel/reap đúng task sở hữu,
  không nuốt cancellation của caller hoặc đổi kết quả job thành success.
- Nested finally vẫn dọn đúng thư mục temp của job kể cả hủy trong shutdown;
  không quét/xóa project, model cache, media dùng chung hoặc DB.

5 unit checks mới bao gồm process wiring, cancellation đúng lúc đóng connection,
timeout/reap, caller cancellation và heartbeat đã failed/cancelled. Lượt worker /
pipeline SQL / lease / shutdown gồm 16 checks đạt, 82,807 giây, trên PostgreSQL tạm
127.0.0.1:55447. Output lượt đó không còn lỗi connection-close cancellation.
Không dùng kiểm thử này để khẳng định đã nghiệm thu mọi sự cố database/network.

Sau sửa cuối đã chạy full backend discovery: **1.050 tests, OK, 38 skipped**,
234,328 giây, exit 0. Không cộng 16 focused hoặc 5 unit riêng vào tổng này.
Full log có 0 dòng `Exception closing connection`. App DATABASE_URL là loopback
port 1, Supabase/provider dùng credentials giả, chỉ integration karaoke trỏ DB
tạm. Ca model/composite opt-in được đo riêng, không tính skip của discovery thành
đã chạy model. Container PostgreSQL test đã dừng sau kiểm chứng, không xóa volume.

## Nguồn bổ sung đã kiểm, chưa có bộ positive hợp lệ

- [VietLyrics, bài báo tác giả](https://www.apsipa.org/proceedings/2025/papers/APSIPA2025_P116.pdf):
  mô tả phát hành metadata, link và scraper từ nhạc streaming. Không lấy metadata
  hoặc lập luận nghiên cứu trong bài báo làm quyền tải/phân phối mọi bản thu;
  không scrape, dùng VPN, chấp nhận điều khoản hộ chủ dự án hoặc publish nhạc này.
- [VFMC, README tác giả](https://github.com/yeenci/vfmc-datasets): mô tả 11.000 đoạn
  5 giây phục vụ phân loại. Không thay chúng cho 5–10 bài hoàn chỉnh có reference
  start/end; license code không được suy thành quyền với tất cả bản thu nguồn.
- [Danh sách corpus của OpenVPI](https://github.com/openvpi/MakeDiffSinger/wiki/Public-datasets):
  mục Vietnamese trỏ ViCa, chính là corpus âm vị đã dùng; không là nguồn bài hát
  hoàn chỉnh mới hoặc một bộ held-out độc lập.
- [SingStyle111, bản ghi của nhóm tác giả](https://zenodo.org/records/10265401):
  mô tả ba ngôn ngữ English/Chinese/Italian. Không dùng để thay benchmark tiếng Việt.
- [Audio.com, Tập thể dục buổi sáng](https://audio.com/thi-kieu-my-phan/audio/nhac-thieu-nhi-vui-nhon-cho-be-tap-the-duc-buoi-sang):
  trang hiển thị 6:21, vượt giới hạn đầu vào 5 phút. Không tải/cắt để coi là bài
  đầy đủ đạt giới hạn; nhãn CC0 trên trang chưa được dùng để kết luận quyền toàn bài.
- [MUSAN, nguồn OpenSLR](https://www.openslr.org/17/): corpus music/speech/noise,
  gói 11 GB. Chưa xác minh được bộ bài Việt kèm lời/reference phù hợp; không tải
  cả gói lớn hoặc tính speech/noise thành positive song benchmark.

Danh sách này chưa cung cấp bộ positive mới có ground truth và nghe duyệt.
ViCa đã có local từ lượt hiệu chuẩn trước, không được tính lại thành nguồn bài
hát mới. Các nguồn cũ bị 403/429 không được thử né hạn chế truy cập.

## Gate vẫn còn mở

Cần 5–10 bản có vocal tiếng Việt và lời đúng bản thu, đủ quyền nghiên cứu/xử lý;
annotation được nghe kiểm lại, calibration/held-out riêng, phép đo toàn bài và
nghe stems. Sau đó mới chốt chất lượng, nghiệm thu thật và xin quyền rollout.
Không có bộ bài không được biến thành việc giảm mục tiêu, tạo giọng hát AI,
dùng piano + demo timing làm positive, hoặc báo mọi phase đã xong.
