# Nhạc cưới

Extension Chrome/Edge desktop và helper cục bộ để chuẩn bị nhạc cưới từ danh sách văn bản. Chỉ tải/xử lý nội dung bạn có quyền sử dụng.

## Cài đặt

Cần Node.js 22+, npm, yt-dlp, FFmpeg/ffprobe và Deno (khuyến nghị) hoặc Node.js 22+ làm JavaScript runtime của yt-dlp. Trên macOS: `brew install yt-dlp ffmpeg deno`.

```sh
npm install
npm run build
# Chạy helper trực tiếp trong Terminal:
npm run dev:helper
# Hoặc cài tự chạy ngầm mỗi khi bật máy macOS (không cần mở Terminal nữa):
npm run helper:autostart
```

Mở `chrome://extensions` hoặc `edge://extensions`, bật **Developer mode**, nhấn **Load unpacked** và chọn thư mục `apps/extension/dist`. Nhấn biểu tượng **Nhạc cưới** để mở tab làm việc — tiện ích **tự động kết nối** với helper tại `127.0.0.1:43127`, hoàn toàn **không cần nhập token**.

Dữ liệu âm thanh và bản xuất nằm trong `~/.wedding-music`. Helper chỉ nhận yêu cầu từ loopback `127.0.0.1:43127` và chỉ cho phép origin `chrome-extension://...` (cùng `http://localhost:5173` khi dev), chặn mọi trang web bên ngoài.

## Sử dụng

1. Đánh dấu xác nhận chỉ tải/xử lý nội dung có quyền sử dụng.
2. Dán danh sách nhạc có mục đánh số `1.` / `1)` và khoảng thời gian `(m:ss–m:ss)`, nhấn **Phân tích danh sách**.
3. Rà soát tiêu đề mục, tên dòng, query, đổi dòng ghi chú (như MC), rồi nhấn **Tìm nhạc**.
4. Chọn ứng viên YouTube, nhấn **Nghe thử** để helper tải MP3 và dựng waveform, chỉnh điểm đầu/cuối, fade-in/fade-out (bật lên mặc định 3 giây), rồi nhấn **Đúng bản này**.
5. Khi mọi bài nhạc đã xác nhận, nhấn **Tải tất cả theo thư mục (ZIP)** để nhận `nhac-cuoi.zip` có thư mục `01 - ...`, `02 - ...` và các file MP3 192 kbps đã cắt/fade.

## Phát triển & API

`npm run dev:extension` mở Vite trên `http://localhost:5173`. Để kiểm tra UI web, chạy `WEDDING_DEV_ORIGIN=http://localhost:5173 npm run dev:helper`. Chỉ chế độ Vite development dùng `localStorage` thay `chrome.storage.local`; bản build `apps/extension/dist` không có fallback này. Web preview không thay thế bước kiểm tra Load unpacked trên Chrome/Edge.

API cục bộ (`packages/shared/src/api.ts`, mọi lỗi `{error:{code,message}}`): `GET /api/health`, `POST /api/search`, `POST /api/assets`, `GET /api/jobs/:id`, `GET /api/assets/:id`, `GET /api/assets/:id/audio`, `POST /api/exports`, `GET /api/exports/:id/download`.
