# Hai bản hát công khai — diagnostic nội bộ, chưa nghiệm thu

Lượt17/11 bên dưới là bằng chứng lịch sử. Lỗi tách Cháu đi mẫu giáo đã được
tái hiện và sửa vào19/11; bài đã tách được stems nhưng vẫn chưa khớp lời.
Xem [CLOCK-FIX-20261119.md](CLOCK-FIX-20261119.md), không diễn giải kết quả cũ
thành trạng thái hiện tại hoặc quality gate đã đạt.

Đợt tiếp tục theo yêu cầu chủ dự án tự tìm bài, gợi ý Con cò bé bé hoặc Cháu
lên ba. Đã tải MP3 thật, kiểm định bytes/duration bằng parser hiện có và chạy
model offline đã pin. Không dùng Supabase, không đổi application source/config,
không upload/publish/commit. Các bản thu chưa được xác nhận quyền sử dụng;
**không coi tải công khai là giấy phép hoặc positive benchmark đủ điều kiện**.

## Nguồn và file gốc

| Case                            | Trang nguồn                                                        |   Bytes | Duration ms | Quyền / annotation                                |
| ------------------------------- | ------------------------------------------------------------------ | ------: | ----------: | ------------------------------------------------- |
| Mẹ yêu không nào (Con cò bé bé) | https://bcdcnt.net/bai-hat/me-yeu-khong-nao-con-co-be-be-5909.html | 2711743 |      169456 | Chưa xác nhận quyền, chưa nghe kiểm lời/reference |
| Cháu đi mẫu giáo (Cháu lên ba)  | https://bcdcnt.net/bai-hat/chau-di-mau-giao-14261.html             | 1941733 |      121313 | Chưa xác nhận quyền, chưa nghe kiểm lời/reference |

SHA256 bản gốc:

- Con cò: `27b08929e0e7b38a4e8d11084d9e9016e7efa9d99d1729d36caac35fd56d25cf`.
- Cháu đi mẫu giáo: `6377fcea903cb270fa2f2321b704b68076970217df25bfe888ed80d62dfc74f5`.

Chỉ dùng cache nghiên cứu private trên máy, ngoài repo app. Không đưa raw audio,
lời đầy đủ hoặc derivatives vào Git, không đưa vào kho bài hát của trẻ. Không
đăng nhập/scrape tài khoản, lấy cookies, vượt paywall/captcha, hoặc lấy stream
YouTube. Các tệp được kiểm Content-Type, dung lượng tối đa20 MiB, redirect cùng
origin và MP3/duration; không ghi đè kết quả trước.

Lời hiển thị trang nguồn được giữ nguyên như input chưa xác minh, không tự nhân
lặp và không thay bằng ASR. Không có reference start/end do người nghe xác nhận.

## Model và kết quả nguyên bài

Demucs4.0.1/htdemucs pin hiện có, aligner revision
`2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed`, boundary-v2. Môi trường AI riêng;
không nâng dependencies của backend OCR hoặc sửa model để ép kết quả.

### Con cò bé bé

- Separation297,7152s; alignment224,1378s; tổng521,9956s.
- Hai stems MP3 mỗi file4.067.621 byte. Clock encode vocal2 anchors, nền3 anchors,
  offset0ms ở anchors đo được; đây không là đánh giá chất lượng nghe/căn lời.
- Input4 dòng/33 tiếng, decode độc lập184 tiếng; transcript agreement0,2396.
  Không gọi agreement là accuracy hoặc kết luận transcript nhận dạng là đúng.
- Raw15/33 cặp start/end; mapper từ chối **toàn case** `LYRICS_NOT_MATCHED`.
  Không có candidate/applied/review/published. Không tính15 cặp thô thành coverage
  được chấp nhận, không dùng input chưa khớp để kết luận chất lượng alignment.
- Nhạc nền/giọng tách chỉ để nghe diagnostic, chưa được người dùng duyệt.
- SHA256 report: `355a3293c1ce3b6ffad8546810922884751b379f316246f91545ebd9eec1a2e4`.

### Cháu đi mẫu giáo

- Input5 dòng/39 tiếng, chưa xác minh đủ các lượt hát.
- Dừng tại SEPARATE_STEMS sau227,8317s: **INVALID_PROVIDER_RESULT**.
  Chưa xác định exception nội bộ chi tiết; không gọi đây là safe negative đúng.
- Có vocal tạm, không có stems result được adapter chấp nhận; không hiển thị
  tệp tạm như kết quả tách thành công. Chưa chạy alignment/mapper.
- Không có candidate/applied/review/published.
- SHA256 report: `153bb358c1f191c1aad87a547c79daba9cea4211f32b9e1a0b5bf0d753564981`.

## Timeout và giới hạn phép đo

Config riêng script nghiên cứu420s/bước; default ứng dụng180s và `.env` thật
không đổi. Cả separation và alignment bài Con cò đều vượt180s; separation của
Cháu đi mẫu giáo cũng vượt180s trước khi lỗi. Cần đo theo máy worker và đặt
timeout hữu hạn phù hợp trước vận hành CPU, không cam kết bài5 phút chạy180s.

Peak RAM toàn cây process, chất lượng stems, onset/end error, manual correction
time và chi phí vận hành vẫn unknown/null. Không có reference người nghe thì
không có accuracy. External inference calls=0, không suy ra chi phí máy/hosting=0.

## Nguồn có thông báo giáo dục miễn phí, chưa lấy được file gốc

[Hội Âm nhạc TP.HCM](https://hoiamnhactphcm.vn/nhac-si-nguyen-quang-vinh-tai-dac-cu-chu-tich-hoi-am-nhac-thanh-pho-ho-chi-minh-nhiem-ky-2026-2031.html)
công bố audio master/nhạc nền cho cộng đồng, trường học dùng miễn phí. Không
diễn giải thành CC/quyền thương mại hoặc quyền với file từ website khác.

Đã xác định kênh `https://www.youtube.com/@hoiamnhactp.hochiminh988`, playlist
thiếu nhi `PL8-KPKVYDtZF9MB5tHwzQhZQwFBbryWRj`. Hai mô tả public đã kiểm
(`FNHs5aNHcKQ`, `cTKtFHjz9Xo`) trống, chưa tìm được link MP3/Drive do chủ
kênh cung cấp. Chưa tải media từ kênh này hoặc tự liên hệ bên ngoài.

Sáu link MP3 vocal của thư viện thieunhivietnam.vn kiểm HEAD đều chuyển về
homepage HTML; không lưu HTML thành MP3 hoặc tính là tải thành công. Link file
Cháu lên ba tại trang Trường MN Phúc Đồng timeout ở các request hữu hạn, nên
dùng nguồn thay thế ở trên. Không thử né nguồn cũ bị403/429.

## Artifact local và nghe thử

Cache root của lần chạy: `D:\Project\capstone1_readalong_vesiion\.cache\karaoke-benchmark`.

- `private-research-con-co-20261117/{source-provenance,pipeline-research-result}.json`.
- `private-research-chau-di-mau-giao-20261117/{source-provenance,pipeline-research-result}.json`.
- `listen-private-20261117.html`: Con cò có bản gốc/vocal/nền; Cháu đi mẫu giáo
  chỉ bản gốc và thông báo lỗi. Không tự phát/đánh dấu duyệt, một audio tại một
  thời điểm, không có backend/analytics/request mạng.
- Browser smoke cuối đạt trên trang file local:4 players, phát chồng bị chặn,
  nguồn nhạc đọc được,0 page errors,0 external requests, mobile390px không tràn.
  Đã xem screenshot. Không coi browser phát được audio là người đã nghe duyệt.
- Bản nháp xin file/phạm vi sử dụng ở workspace
  `handoff/karaoke-music-permission-request-DRAFT.md`; chưa gửi/liên hệ.

**Số positive benchmark đủ quyền+lời khớp+annotation+nghe duyệt vẫn0.** Hai lượt
diagnostic này không thay gate5–10 bài/held-out, không hoàn tất Phase1/3/5/6.
Tiếp theo cần file/quyền phù hợp, lời đúng bản thu; điều tra lỗi stems case2,
sau đó annotation/benchmark và nghe stems. Không giảm gate hoặc dựng timestamps.
