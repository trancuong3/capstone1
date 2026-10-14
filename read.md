


This document summarizes all features, technical improvements, and bug fixes that have been implemented and pushed to the `tu` branch.

---

## 1. “Read Sample” Feature (Text-to-Speech - TTS)

- **Previous issues**: The sample reading feature did not pronounce Vietnamese accurately or was not stably integrated with the ElevenLabs API.
- **Solutions & improvements**:
  - Integrated the standard ElevenLabs Text-to-Speech workflow with multilingual Vietnamese support using the `eleven_multilingual_v2` / `eleven_flash_v2_5` models.
  - Configured a Voice ID and stable audio settings to provide natural Vietnamese pronunciation with clear intonation, accurately reflecting the content of the book page [...]
  - Optimized audio caching and streaming to improve response time when users click the **“Read Sample”** button.

---

## 2. Speech Recognition for Children’s Reading (Speech-to-Text - STT)

- **Previous issues**:
  - The STT system could not detect children’s voices or only counted the number of words without displaying the content the child had read.
  - Users had to manually click each word instead of having the system automatically listen and recognize speech in real time.
- **Solutions & improvements**:
  - **Voice Activity Detection (VAD) & Automatic Utterance Segmentation**:
    - Used the Web Audio API to analyze microphone audio levels, with a silence detection threshold of approximately 500 ms.
    - Automatically separates the child’s spoken segments and sends them to the STT backend without requiring the microphone to be manually turned off and on repeatedly.
  - **Real-time Speech Recognition**:
    - Standardized the Vietnamese language code as `vie` for ElevenLabs Scribe STT.
    - Immediately displays the word or sentence spoken by the child in the status banner: `Child is reading: [spoken words]`.
    - Automatically matches the child’s speech with the book page content and highlights the corresponding words on screen.
  - **Detailed Reading Results**:
    - At the end of a reading session, the results dialog allows users to view a detailed list of all words successfully read by the child during the session.

---

## 3. Major Improvements to the Book Text Scanning System (OCR Engine)

- **Previous issues**:
  - Book images captured by cameras or mobile phones had a small resolution of approximately 554 × 554 px, with very small characters whose height was only 8–10 px.
  - The previous Tesseract OCR pipeline using CLAHE preprocessing could not properly recognize Vietnamese tone marks, including acute, grave, hook, tilde, dot below, and Vietnamese characters such as â, ă, and ê. This resulted in fragmented and inaccurate text [...]
    > *Before the fix*: `"sách. vòng cho. xăng, nếu không chốt chỉ thức để thấu hiểu cuộc mới nhận nếu không hiển Bì XÂ cuộc bạo nhiêu..."`

- **Solutions & improvements**:
  - **Adaptive Cubic Upscaling**:
    - Automatically checks the resolution of uploaded book images. If the largest dimension is less than 1400 px, the system applies `cv2.INTER_CUBIC` interpolation with an optimized scaling factor [...]
    - Increases the character height from approximately 8–10 px to the standard **25–30 px** range, similar to a 300 DPI scan, enabling Tesseract to recognize Vietnamese tone marks and diacritics more accurately.
  - **Otsu Binarization**:
    - Applies adaptive Otsu thresholding using `cv2.THRESH_BINARY + cv2.THRESH_OTSU`.
    - Clearly separates black printed text from the paper background, reducing shadows, uneven lighting, and decorative noise around the edges of the book.
  - **Normalized Bounding Boxes `[x, y, w, h] ∈ [0, 1]`**:
    - Normalizes the bounding-box coordinates of each word to the `[0, 1]` range based on the dimensions of the upscaled image.
    - Because the image is enlarged proportionally, these coordinates remain fully aligned with the original image, ensuring that the word highlight boxes accurately surround the text on the reading screen [...]
  - **Automatic `TESSDATA_PREFIX` Configuration & Vietnamese Model Support**:
    - Automatically detects the `backend/tessdata` directory path and supports both the `vie` and `vie_best` language models.

- **Comparison results using real-world images**:
  - Accuracy increased significantly from less than 15% to more than 91%.
  - The system successfully recognized the complete and continuous book passage:
    > *“When I was young, I often believed that if I did not read diligently, I would never have enough knowledge to understand life. Only much later did I realize that, if [...]”*

---

## 4. Testing & Quality Assurance Results

- **Backend Unit & Integration Tests**:
  - Ran `pytest`: **126 / 126 tests passed** (100%).
  - Added test cases for the Vietnamese model fallback and image preprocessing metadata.
- **Frontend Unit & Component Tests**:
  - Ran `npm test`: **417 / 417 tests passed** (100%).
- **Production Build**:
  - Ran `npm run build`: Next.js 16 successfully compiled all static pages and dynamic routes.

---

## 5. Git Workflow

- All commits were pushed exclusively to the **`tu`** branch.
- No changes were merged into the `main` branch.
```
