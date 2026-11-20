# Phase 5 · Kiểm chứng nhận dạng lời hát

Ngày đo 20/11/2026 trên Windows, dùng Chrome 158.0.8127.36 và Edge 157.0.4341.60. Ở lần đo cuối với track micro đã bắt đầu nghe thật sự, Chrome chấm **phần đã hát** của “Colours” và báo **chưa đủ dữ liệu** cho đoạn piano. Lần đo trước khi siết mốc bắt đầu đã trả điểm cả bài trên cùng bản thu. Các số dưới đây phân biệt hai lần đo. Điều kiện loa, tai nghe, giọng trẻ và các ngưỡng chấm theo nhãn người nghe vẫn chờ nghiệm thu.

## Đo bằng tệp âm thanh thật

[Bộ đo](../../frontend/scripts/benchmark-karaoke-mic.mjs) dựng hook và bộ chấm của ứng dụng, dùng đồng hồ của phần tử audio HTML. Sau thao tác bật micro và đếm ngược, trình duyệt nhận WAV từ thiết bị ảo. Bộ đo chỉ chấp nhận đầu vào mang nhãn thiết bị giả và lệnh nhận dạng nhận track tường minh. Trình nhận dạng của Chrome/Edge xử lý tín hiệu thật. Trang thử nằm trên loopback, không gọi API ứng dụng. Dịch vụ nhận dạng của trình duyệt có thể dùng mạng. Chỉ chọn bản công khai được phép xử lý theo cách này.

- **M** là số tiếng được bộ chấm xác nhận khớp ở đúng vị trí theo bằng chứng của nó. **E** là số tiếng có thể đánh giá. **N** là tổng số tiếng trong bản lời. Chấm cả bài cần E/N ≥ 80%. Số tiếng khớp trong bảng chưa được một người nghe gán nhãn độc lập.
- **Chốt** đo từ sự kiện nhạc kết thúc đến khi hook có kết quả. Thước đo này phản ánh xử lý trình duyệt và ứng dụng, chưa gồm độ trễ khung hình hiển thị trên thiết bị thật.
- Các lượt dưới đây có 0 lần mở nhận dạng từ nguồn mặc định. Số lượt mở track là các chu kỳ nhận dạng do hook điều khiển.

| Đầu vào | Trình duyệt | M / E / N | Kết quả | Số lượt mở track | Chốt |
| --- | --- | --- | --- | ---: | ---: |
| ELLA · Colours, bản có giọng, 25,35 giây | Chrome | 23 / 25 / 30 | Cả bài | 6 | 72 ms |
| Cùng tệp Colours | Edge | 0 / 0 / 30 | Chưa đủ dữ liệu | 5 | 464 ms |
| ELLA · Head, arms, legs and feet, 27 giây | Chrome | 7 / 8 / 41 | Phần đã hát | 5 | 80 ms |
| ELLA · Actions, 25,45 giây | Chrome | 3 / 3 / 13 | Phần đã hát | 5 | 81 ms |
| Colours, trích 5,6 giây từ mốc 2,3 giây | Chrome | 8 / 8 / 30 | Phần đã hát | 2 | 85 ms |
| Ngôi sao nhỏ, 16 giây đầu chỉ có piano | Chrome | 0 / 0 / 126 | Chưa đủ dữ liệu | 3 | 69 ms |
| Cùng tệp piano | Edge | 0 / 0 / 126 | Chưa đủ dữ liệu | 3 | 512 ms |

Đo thăm dò với cách gọi `start()` cũ cho E = 0 trên Colours ở cả hai trình duyệt. API cũ không cho biết track đầu vào nên lượt đó chỉ dùng để chẩn đoán. Với track tường minh trên Chrome, Colours đạt độ bao phủ 25/30 và điểm theo bằng chứng 23/25. Kết quả đó cũng cho thấy cùng một tệp có ca sĩ lọt vào mic vẫn có thể được chấm dù trẻ im lặng. Đường thu âm này không định danh được người hát. Cần tách kiểm thử bài có giọng hướng dẫn với bài chỉ có nhạc nền.

Trên ba bản nguyên có giọng ELLA, Chrome chỉ chấm cả bài ở một bản. Hai bản còn lại đạt độ bao phủ 8/41 và 3/13 với các bản mốc chưa duyệt. Bảy phép đo trong bảng đều trả kết quả dưới 3 giây trong phòng thử kỹ thuật. Để dùng thử có giám sát, giữ phản hồi theo phần đã nghe hoặc chưa đủ dữ liệu, tắt nhạc đệm loa mặc định khi chấm và chỉ bật khi người dùng xác nhận đeo tai nghe. Cần hoàn tất các lượt thử thiết bị và người nghe trước khi giới thiệu chức năng như một phép đánh giá đại trà.

### Đo lặp trên mã cuối

Chạy lại Chrome 158.0.8127.36 với cùng SHA-256 của WAV và tệp lời sau khi giới hạn cửa sổ chấm theo thời điểm `onstart` thật của từng chu kỳ nhận dạng.

| Đầu vào | M / E / N | Kết quả | Bắt đầu qua track / sự kiện cuối | Chốt |
| --- | --- | --- | ---: | ---: |
| Colours, nguyên bài có giọng | 20 / 22 / 30 | Phần đã hát | 6 / 6 | 115 ms |
| Ngôi sao nhỏ, 16 giây piano | 0 / 0 / 126 | Chưa đủ dữ liệu | 3 / 0 | 112 ms |

Cả hai lượt đều có 0 lần mở micro mặc định và 0 lỗi nhận dạng được báo. Độ bao phủ của Colours ở lần cuối là 73,3%, dưới ngưỡng 80% để chấm cả bài, so với 83,3% ở lần đầu. Thay đổi mã và độ biến thiên của dịch vụ nhận dạng có thể cùng ảnh hưởng kết quả. Hai lượt không đủ để tách riêng tác động của từng yếu tố. Đoạn piano giữ 0 tiếng khớp ở cả hai lần.

## Nguồn và chạy lại

- Ba đầu vào có giọng là MP3 của © 2026 Commonwealth of Australia, chuyển sang PCM mono cho phép thử. Tải bản gốc tại [Colours](https://www.ella.edu.au/media/bikjyxj1/app2_song_vietnamese.mp3), [Head, arms, legs and feet](https://www.ella.edu.au/media/ngzbpq4j/app5_song_vietnamese.mp3) và [Actions](https://www.ella.edu.au/media/tmtnymc2/app6_song_vietnamese.mp3). Điều khoản dùng cho đồ án phi thương mại và PDF lời in có trong [điều khoản ELLA](https://www.ella.edu.au/terms-of-use/) và [biên bản ELLA](../karaoke-auto-import/ELLA-CALIBRATION-20261119.md).
- Mỗi MP3 dùng đúng lời in của bài với mốc máy tạo chưa duyệt, trong cache nghiên cứu `ella-vietnamese-20261119/`. Đầu vào Colours lấy `calibration-ctc-v3/app-2/candidate-unapproved.json`, với một số mốc đầu còn trống. Với hai bài còn lại, dùng trường `candidate.lyrics` của `calibration-phowhisper-onnx/mapper-diagnostic/app-5-vocal-unapproved.json` và `app-6-original-unapproved.json`. Các bản mốc chỉ phục vụ kiểm thử nội bộ.
- Nhạc nền “Ngôi sao nhỏ” và lời v2 nằm trong [thư mục bài mẫu](../karaoke-demo/). Định danh các tệp đầu vào theo SHA-256 trong bảng dưới đây.
- Từ thư mục `frontend`, sau khi đã cài dependency và trình duyệt Chrome hoặc Edge, chạy hai dòng sau. Thêm đối số cuối là mốc bắt đầu tính bằng ms khi dùng đoạn trích. Kết quả JSON bao gồm hash WAV, phiên bản trình duyệt, số lần mở track, M/E/N, ID tiếng khớp, trạng thái và thời gian chốt.

```sh
ffmpeg -i ../docs/karaoke-demo/ngoi-sao-nho.mp3 -t 16 -ar 44100 -ac 1 piano16.wav
node scripts/benchmark-karaoke-mic.mjs chrome --reviewed-wav piano16.wav ../docs/karaoke-demo/ngoi-sao-nho-v2.json
```

| WAV PCM mono 44,1 kHz | SHA-256 |
| --- | --- |
| Colours | `4d78c2e2e4e2cf50c89dc3a74a3ba9405745b9d36cb14c39ac55093aafc763a8` |
| Trích Colours | `705c455ef7d201a037e52cb52d5325448fb941188553943c3d7b20c6cf49cd3d` |
| Head, arms, legs and feet | `5b4cd3ffe30caf23fc0dca04de0ef84be0bc7e6fbe3b79c55005ee61cd103454` |
| Actions | `caf3a98a147902f07a87f767425b37d1d19cb28928b249cac06272daeda2ea30` |
| Piano 16 giây | `4e64996c2e1ae4cb676d97459530ebe0efacc9366cf8ba6f05fb9fff29d7f520` |

## Thử phương án nhận dạng cục bộ

PhoWhisper-small ONNX INT8, revision `9b0cc3c44a701d6107b5ad0052e5546626e41bad`, chạy CPU 2 luồng và giải mã tự do tiếng Việt. Lời in chỉ được đưa vào hàm đối chiếu sau giải mã. Trên ba bản có giọng ELLA App 2/5/6, số tiếng chung tối đa theo đúng thứ tự lần lượt là 30/30, 12/41 và 5/13; thời gian suy luận 8,10, 8,74 và 5,79 giây, chưa tính 4,45 giây nạp mô hình. Khi chỉ có nhạc nền App 2, piano và im lặng 5 giây, mô hình vẫn xuất lần lượt 46, 15 và 12 tiếng. Một tiếng trên mẫu im lặng trùng với lời in. Đây chỉ là đối chiếu chuỗi, chưa xét đúng mốc hay người hát. Kết quả này chưa đủ để bật mô hình làm phương án chấm dự phòng.

Thử thêm checkpoint tiếng Việt chuyên lời hát `nguyenvulebinh/lyric-alignment`, revision `2d0b61d13e9da6cae03a6c01fe3eeebdb6e4b4ed`. Chỉ tính `LocalSingingAligner.emissions(audio)`, lấy argmax từng frame và giải mã CTC greedy trước khi đọc lời tham chiếu. Đường thử không gọi hàm căn lời cưỡng bức. Trên cùng các bài App 2/5/6, số tiếng chung theo thứ tự là 26/30, 12/41 và 5/13, thời gian CPU 79,74, 28,33 và 26,34 giây. Nhạc nền App 2, piano và im lặng cho lần lượt 28, 14 và 1 tiếng đầu ra, đều có 0 tiếng chung với tham chiếu trong phép thử. Nạp mô hình mất 16,94 giây; đo bằng CPU 2 luồng trên máy phát triển có các tác vụ chạy đồng thời. Chưa có căn cứ dùng model này làm đường chấm dự phòng trực tiếp. [Mã nạp mô hình và tính emissions](../../ai/karaoke_processing/ctc_engine.py)

## Phiếu thử thiết bị và giọng hát thật

1. Dùng **Hát vui → Ngôi sao nhỏ → Chấm điểm → Bắt đầu hát**. Ghi phiên bản bài, định dạng lời, hệ điều hành, trình duyệt, thiết bị, tai nghe/loa, mức âm lượng, tốc độ và loại giọng được phép thử. Người thử tự bật micro; ghi các mã vị trí và kết quả. Chỉ thu hoặc gửi bản ghi nếu đã có phép riêng.
2. Với tai nghe, hát lời đúng; hát nhỏ; kéo dài âm cuối; thay một tiếng; bỏ một tiếng giữa hai tiếng đúng; hát điệp khúc lặp; thử tốc độ 0,75×. Dùng một người nghe độc lập ghi các vị trí đúng/sai theo ID câu và chỉ số tiếng trước khi xem kết quả. Với từng lượt, ghi cả đoạn người nghe chưa thể gán nhãn.
3. Với loa, chạy đoạn chỉ có nhạc nền trong phòng yên lặng khi người thử im lặng. Lặp lại với bài có giọng hướng dẫn nếu hệ thống cho phép phát nền đó khi chấm. Ghi đường phát thật, số tiếng khớp và kết quả. Nếu chế độ chấm tắt nhạc loa, kiểm riêng phần tắt tiếng và điều kiện có thiết bị khác phát giọng.
4. Tạm dừng, tua qua một câu, vào lại, rút mic, hát nốt câu cuối khi nhạc kết thúc. Ghi mã lần hát, các khoảng đã phát và thời gian từ khi nhạc hết đến lúc thấy thẻ kết quả. Kiểm tra không tính trùng lần hát trước.
5. Tách nhóm giọng người lớn và giọng trẻ có đồng ý phù hợp, tách tai nghe và loa. Tổng hợp tử/mẫu như [ngưỡng Phase 1](PHASE1.md). Chỉ kết luận trên nhóm đã đo. Điều kiện thiết bị chưa có hoặc mẫu số bằng 0 ghi **chưa đo**.

| Mã lượt, thiết bị, trình duyệt | Bài / phiên bản, điều kiện | ID tiếng người nghe xác nhận đúng | ID tiếng ứng dụng nhận đúng | Xác nhận nhầm / tổng xác nhận | Bỏ lỡ / tổng hát đúng | Kết quả, ms sau nhạc hết |
| --- | --- | --- | --- | --- | --- | --- |
| Điền khi thử thực tế | Tai nghe / loa / nền có ca sĩ; tốc độ | Theo lần xuất hiện | Theo lần xuất hiện | Tử/mẫu | Tử/mẫu | Toàn bài / một phần / chưa đủ |

Mục tiêu là tối đa 5% xác nhận nhầm, tối đa 20% bỏ lỡ, 0 tiếng khớp khi chỉ có loa và ít nhất 95% lượt hiện kết quả trong 3 giây. Sự kiện giao diện và phép đo WAV không thay thế nghiệm thu lỗi gán giọng, chất lượng ở trẻ hoặc độ trễ trên thiết bị thật.
