# Nhận dạng và chấm lời hát của bé · Phase 1

Đường vào sản phẩm là **Hát vui → chọn bài → Chấm điểm → Bắt đầu hát**. Điểm đo số tiếng tiếng Việt mà ứng dụng có thể đối chiếu với lời đã xuất bản trong lượt hát. Mỗi lượt gắn với bé, phiên bản bài và các khoảng nhạc thực sự đã phát. Dữ liệu nhận dạng của lượt chỉ cần giữ đến khi rời màn hình.

## Bài dùng để nghiệm thu

Đối chiếu danh mục ngày 20/11/2026 bằng truy vấn chỉ đọc. **Ngôi sao nhỏ** đang xuất bản ở phiên bản nội dung số **3**, định dạng lời **v2**, có 18 câu, 126 tiếng và thời lượng 103.366 ms. Bài có điệp khúc lặp, nhạc piano và mốc theo cả câu lẫn tiếng. Mở bài từ thư viện của bé để kiểm tra đường sử dụng thật. Nếu bài được xuất bản lại, ghi phiên bản mới trong biên bản nghe.

Danh mục kiểm tra chưa có bản v1 đang xuất bản có cả nhạc và lời. Dùng [lời v1, 18 câu](../karaoke-demo/ngoi-sao-nho.json) với [cùng bản piano](../karaoke-demo/ngoi-sao-nho.mp3) trong bộ test tương thích. Đối chiếu với [lời v2](../karaoke-demo/ngoi-sao-nho-v2.json). Các câu ngắn trong bảng dưới là dữ liệu kiểm thử độc lập.

## Điểm xuất phát

Đối chiếu mã ở commit `29a67b59`, cùng [test màn hát](../../frontend/test/karaoke-stage.test.tsx) và [test chấm lời](../../frontend/tests/karaoke/singing-score.test.ts). Các quan sát về micro dưới đây dựa trên đường xử lý hiện tại và test thuật toán. Phép đo với giọng thật thuộc Phase 5.

| Thao tác | Hành vi hiện tại và điểm cần kiểm chứng |
| --- | --- |
| Bật chấm điểm và bắt đầu | Nút xuất hiện khi trình duyệt có SpeechRecognition. Sau đếm ngược, màn hát yêu cầu nhận dạng vi-VN và phát nhạc. |
| Tạm dừng và hát tiếp | Nút tạm dừng gọi trình phát. Nhánh này chưa yêu cầu micro dừng nghe nên có thể thu cả lời nói giữa hai đoạn. |
| Tua hoặc luyện lại | Trình phát có tua, lặp và tốc độ 0,75×. Hàm chấm cả bài hiện chỉ nhận một chuỗi chữ, không mang vị trí nhạc hay lần xuất hiện. |
| Hết bài | Màn hát chốt khi chuyển sang trạng thái kết thúc và bộ nghe còn hoạt động. Hook hủy nhận dạng rồi lấy phần chữ đã thu. Transcript rỗng hiện có thể nhận 0 điểm. |
| Xem chi tiết | Đếm tổng đúng có thể chính xác nhưng ánh xạ sai tiếng. K01 tái hiện trực tiếp lỗi này. |

## Quy tắc cho một lượt hát

Đơn vị chấm là một **tiếng** trong lời tại một vị trí cụ thể. Dùng [bộ tách tiếng của màn đọc](../../frontend/lib/reading/vietnamese-text.ts) để chuẩn hóa Unicode NFC, chữ hoa và dấu câu, giữ dấu thanh và chữ đ. Với v1 dùng ID câu và vị trí tiếng trong câu. Với v2 dùng ID câu và mốc/ID tiếng, giữ vị trí token nếu một đơn vị chứa nhiều tiếng. Hai câu có chữ giống nhau vẫn là hai lần xuất hiện khác nhau.

| Trạng thái | Khi nào ghi nhận | Tính điểm |
| --- | --- | --- |
| Khớp | Kết quả cuối đáng tin, đối chiếu được đúng tiếng, đúng thứ tự và đúng lần xuất hiện. | Tử số và mẫu số |
| Khác lời | Nghe rõ tiếng khác, vị trí thay thế được xác định trong câu. | Chỉ mẫu số |
| Bỏ qua | Có đoạn nhận dạng rõ đi qua vị trí này, ví dụ thiếu một tiếng giữa hai tiếng đã xác nhận cùng câu. | Chỉ mẫu số |
| Chưa đủ dữ liệu | Mất mic, tín hiệu không rõ, chỉ có kết quả tạm, đoạn bị tua qua, không xác định được vị trí, hoặc chưa phân biệt được giọng với nhạc phát. | Ghi vào độ bao phủ |

Với bản chấm cả bài, đặt **N** là tổng số tiếng trong lời, **E** là số tiếng khớp + khác lời + bỏ qua, **M** là số tiếng khớp. Mỗi vị trí chỉ đóng góp một lần. Độ bao phủ là E/N. Khi đủ điều kiện, điểm đúng lời bằng **round(100 × M/E)**. Chỉ làm tròn khi hiển thị. Điểm tổng dùng số tiếng của toàn bài, không lấy trung bình phần trăm từng câu.

Quy ước nghiệm thu ban đầu cho bản thử:

- **Cả bài** khi nhạc kết thúc, E > 0 và độ bao phủ từ **80%** trở lên. Kiểm trên tỷ lệ gốc, trước khi làm tròn. Hiện thêm số tiếng đã đánh giá trên tổng số tiếng.
- **Một phần** khi E > 0 nhưng chưa đạt ngưỡng toàn bài, hoặc người dùng đang luyện riêng một câu. Với lượt hát cả bài, thẻ hiện **Điểm phần đã nghe** bằng `round(100 × M/E)` trên thang 100, kèm độ bao phủ E/N. Lượt luyện riêng vẫn hiện số tiếng khớp của câu.
- **Chưa nghe rõ** khi E = 0 hoặc bài không có tiếng hợp lệ. Có thể có điểm 0 khi nghe rõ mà hát khác toàn bộ lời trong một lượt đủ bao phủ. Transcript rỗng tự nó chỉ cho biết chưa đủ dữ liệu.

Ví dụ, trong bài 20 tiếng, M=12 và E=16 cho **75/100 điểm đúng lời**, bao phủ **16/20**. M=15 và E=15 cho **100/100 điểm phần đã nghe**, bao phủ **15/20**. Khi E=0, hiển thị lời nhắc kiểm tra mic. Thao tác luyện lặp một câu giữ kết quả riêng. Tua qua một câu để nguyên trạng thái chưa đủ dữ liệu. Hát lại cả bài mở một lượt mới.

## Ca nghiệm thu

| Mã | Đầu vào / thao tác | Kết quả cần quan sát | Cách kiểm và phase phụ trách |
| --- | --- | --- | --- |
| K01 | Câu “Bé đi học”, nghe rõ “bé học” xuyên suốt câu. | Vị trí khớp là 1 và 3. Tiếng giữa bị bỏ qua. M=2, E=3, điểm câu 67. | Test vị trí chạy ngay ở Phase 1, hoàn thiện trạng thái ở Phase 3. |
| K02 | Câu “Bé lá”, kết quả cuối “BÉ LÀ” ở Unicode NFD. | Khớp “bé”. “là” khác “lá”. M=1, E=2 khi nghe rõ cả câu. | Test phân biệt dấu ở Phase 1, kiểm trạng thái ở Phase 3. |
| K03 | Câu 1 và câu 5 giống nhau. Bé tua tới câu 5 và hát câu đó. | Chỉ câu 5 được xác nhận. Câu 1 chưa đủ dữ liệu. Bài dài chỉ hiện kết quả phần đã hát. | Phát lại sự kiện theo đồng hồ nhạc, cả v1 và v2, Phase 3–4. |
| K04 | Hát câu đầu, tạm dừng, nói lời câu kế, phát tiếp và hát câu cuối. | Lời nói lúc tạm dừng không xuất hiện trong điểm. Giữ được phần đã hát trước khi dừng. | Test vòng đời micro + trình phát, Phase 2. |
| K05 | Kết thúc nhạc rồi nhận kết quả cuối, sau đó trình duyệt gửi lại cùng kết quả. | Nhận câu cuối đúng một lần, hiện một thẻ kết quả. Sự kiện quá hạn không sửa điểm đã chốt hoặc lọt vào lượt mới. | Test thứ tự sự kiện và thời hạn chốt, Phase 2 và 4. |
| K06 | Từ chối micro trước khi hát, hoặc mất mic giữa lượt. | Trước khi hát: vẫn phát nhạc và giải thích cách bật mic. Giữa lượt: giữ bằng chứng đã có, đánh dấu khoảng mất tín hiệu là chưa đủ dữ liệu. | Giả lập quyền, ngắt mic và thử thiết bị, Phase 2 và 5. |
| K07 | Chạy bài với phòng yên lặng, chỉ có nhạc từ loa. Lặp lại với một bản có giọng ca mẫu. | Bé không hát: không xác nhận tiếng từ loa, không cấp điểm. Ghi lại riêng trường hợp giọng mẫu lọt vào mic. | Mic và loa thật, Phase 5. |
| K08 | Nghe rõ bé hát toàn câu khác nghĩa và khác toàn bộ tiếng trong bài thử một câu. | Trả điểm 0 nếu có bằng chứng cho từng vị trí. Phân biệt với K06, K07. | Test đúng/sai và thiếu bằng chứng ở Phase 3–4. |
| K09 | Hát, chuyển sang luyện lặp câu ở 0,75× rồi hát lại cả bài. | Lần luyện gắn đúng câu theo đồng hồ nhạc. Số lần lặp không tăng điểm cả bài. Lượt mới không mang điểm cũ. | Test trình phát và lượt hát, Phase 2–4. |
| K10 | Bài 20 tiếng với các cặp (M,E)=(12,16), (15,15), (0,0). | Lần lượt trả 75 điểm cả bài, nhận xét phần đã hát, và chưa nghe rõ. | Test ranh giới độ bao phủ, Phase 4. |
| K11 | Lời cuối câu về khi màn hình đã chuyển sang câu sau; mic trả cả bản tạm và bản cuối. | Giữ đúng câu gốc. Chỉ bản cuối có thể đóng góp điểm, vị trí mơ hồ giữ trạng thái chưa đủ dữ liệu. | Test cuối câu và lần nhận kết quả, Phase 3. |

## Xác minh và ngưỡng nghe thật

Từ thư mục `frontend`, chạy `npm exec -- vitest run tests/karaoke test/karaoke-stage.test.tsx`. Ở Phase 1, K01 tái hiện lỗi ghi nhận vị trí **1, 2**. Từ Phase 3, test yêu cầu đúng vị trí **1, 3**. Các test màn hát kiểm cả kết quả cuối, độ bao phủ và lượt luyện riêng.

Để so sánh trước và sau ở Phase 5, người nghe ghi đúng câu và vị trí từng tiếng cho mỗi lượt. Ghi thiết bị, trình duyệt, tai nghe/loa, định dạng lời, tốc độ, số tiếng kỳ vọng, số tiếng nhận đúng vị trí và độ trễ từ lúc nhạc hết đến khi hiện kết quả. Tách báo cáo giọng người lớn và giọng trẻ nếu có mẫu được phép sử dụng.

| Phép đo | Mục tiêu thử nghiệm ban đầu |
| --- | --- |
| Tiếng đã xác nhận nhầm / tổng tiếng ứng dụng xác nhận | Tối đa 5% trên tập lượt hát thật được gán nhãn. Ghi cả tử số và mẫu số. |
| Tiếng bé hát đúng mà ứng dụng bỏ lỡ / tổng tiếng người nghe xác nhận bé hát đúng | Tối đa 20% trên cùng tập. Báo riêng điều kiện tai nghe và loa. |
| Lượt chỉ có âm thanh phát ra từ loa | 0 tiếng được cộng nhầm trong các ca đối chứng. |
| Thời gian hiện kết quả | Mục tiêu 95% lượt trong 3 giây sau khi nhạc kết thúc; ghi thời gian từng lượt và số lượt đạt/tổng. |

Các ngưỡng trên là quyết định thiết kế để thử, chưa phải kết quả đo. Với mẫu số bằng 0 ghi “chưa đo được”. Ghi bất kỳ thay đổi ngưỡng nào trước lượt đánh giá tiếp theo để hai kết quả so sánh được với nhau.
