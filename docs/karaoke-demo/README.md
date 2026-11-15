# Ngôi sao nhỏ — bộ nội dung nghiệm thu karaoke

Đây là nội dung để **admin chủ động tải lên qua giao diện**, không phải mock
được ứng dụng tự chèn khi database/API trống. Các bài khác vẫn thêm qua cùng
giao diện, không phải sửa source hoặc chạy SQL theo từng bài.

## Nhạc và quyền sử dụng

- Tên bản nhạc gốc: **Twinkle Twinkle Little Star Song**.
- Nghệ sĩ: **Alexander Blu**, Orange Free Sounds.
- [Trang nguồn và giấy phép](https://orangefreesounds.com/twinkle-twinkle-little-star-song/).
- [File MP3 do trang nguồn cung cấp](https://www.orangefreesounds.com/wp-content/uploads/2016/10/Twinkle-twinkle-little-star-piano.mp3).
- Giấy phép nguồn công bố: [CC BY 4.0](https://creativecommons.org/licenses/by/4.0/).
  Giữ ghi công, nguồn, giấy phép khi phân phối; không ngụ ý tác giả bảo trợ dự án.
- `ngoi-sao-nho.mp3` giữ nguyên bytes tải về, không cắt, lặp, tách giọng hoặc phối lại.
- SHA-256: `47ebba49be8b7bc776db49c7918b88f0dedfd52f8ccb21e35f6a16e7cb9cbfd6`.
- Metadata thực tế: 2.480.796 byte, MPEG Layer III, khoảng 103.367 ms,
  44.100 Hz, 192 kbps. Không lấy thông số 320 kbps trên trang web làm kết quả đo.

Bản John Casale/Wikimedia được đề xuất trước đó không nằm trong bộ này: máy
nhận HTTP 429 khi tải. Đã chọn nguồn thay thế cùng giai điệu, có giấy phép rõ
ràng và tải được; không dùng file lỗi hoặc lách đăng nhập/giới hạn truy cập.

## Lời và mốc

Lời Việt mới dưới đây được soạn riêng cho bộ thử, không chép lời Việt của bản
thu thương mại khác. Phần lời mới trong bộ này được cung cấp theo CC BY 4.0,
ghi công “Lời Việt mới — bộ thử ViRead”. Không khẳng định đây là bản dịch chính
thức hoặc bài hát của Alexander Blu.

```text
Ngôi sao nhỏ sáng trên trời
Lung linh soi khắp muôn nơi
Em nhìn lên ánh sao xa
Mỉm cười vui hát ngân nga
Ngôi sao nhỏ sáng trên trời
Lung linh soi khắp muôn nơi
```

Giai điệu trong MP3 lặp ba lượt; file nhập có 18 dòng tương ứng. Mốc đi theo
biên câu của đúng file MP3 này, không chia đều toàn bộ thời lượng. Cuối file có
đoạn ngân nhạc không ép nổi bật lời. Cần nghe bản preview để duyệt cảm nhận
nhịp/lời trước khi dùng với trẻ; kiểm tra hợp lệ thời gian không thay cho duyệt
nội dung bằng tai.

- `ngoi-sao-nho.txt`: lời thuần; nhập TXT sẽ **không có mốc**.
- `ngoi-sao-nho.lrc`: mốc bắt đầu; trình nhập gợi ý mốc kết thúc, cần kiểm tra lại.
- `ngoi-sao-nho.json`: mốc bắt đầu/kết thúc và ID dòng đầy đủ, dùng để nghiệm thu.
- `song.json`: metadata để điền form; không chứa khóa, ID tài khoản hoặc signed URL.

Giữ nguyên trường tác giả trong `song.json` khi xuất bản bộ thử: trường này
hiển thị cho người nghe cả ghi công, URL nguồn và giấy phép. `source_note` và
`usage_note` chỉ admin thấy, không dùng chúng thay cho ghi công công khai.

## Thao tác

1. Admin mở **Bài hát → Tạo bài hát**, nhập metadata từ `song.json` và lưu.
2. Tải `ngoi-sao-nho.mp3`; ảnh bìa không bắt buộc.
3. Nhập `ngoi-sao-nho.json`, lưu lời và thời gian.
4. Kiểm tra điều kiện xuất bản, tải bản nghe thử và bấm Phát; kiểm tra các câu.
5. Xuất bản; parent chọn bé lớp 1–5, mở **Hát vui → Ngôi sao nhỏ**.

Không tự seed trong startup, không ghi vào bảng lịch sử/tiến bộ đọc và không
thu âm giọng trẻ. Cách triển khai migration/bucket xem `KARAOKE_SETUP.md` ở root.
