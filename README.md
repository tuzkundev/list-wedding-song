# Nhạc cưới

Extension Chrome/Edge desktop và helper cục bộ để chuẩn bị nhạc cưới từ danh sách văn bản. Chỉ tải/xử lý nội dung bạn có quyền sử dụng.

## Website trên Cloudflare (Free Tier)

- **URL trực tiếp**: https://list-wedding-song.nguyenqq611.workers.dev
- **Dịch vụ sử dụng (100% Cloudflare Free)**:
  - **Cloudflare Workers + Static Assets** (`worker/index.ts`, `wrangler.jsonc`): phục vụ giao diện web và API `/api/*`.
  - **Cloudflare D1 Database** (`wedding-music-db` — `migrations/0001_init.sql`): lưu trữ danh sách nhạc cưới (`playlists_state`), metadata sóng nhạc (`cloud_assets`) và bộ nhớ đệm tìm kiếm YouTube (`search_cache`).
  - **Cloudflare Workers KV** (`WEDDING_KV`): lưu trữ file âm thanh đã chuẩn bị (`audio:<assetId>`) để phát lại trực tiếp từ Cloudflare.
  - Hỗ trợ cả 2 chế độ: tự động kết nối với `helper` chạy ngầm trên máy (`127.0.0.1:43127`) để tải YouTube bằng `yt-dlp`/`ffmpeg` rồi đồng bộ lên Cloudflare D1 + KV, hoặc chọn file nhạc trực tiếp từ máy (`📁 Chọn file nhạc`) và cắt/fade/xuất ZIP ngay trên trình duyệt bằng Web Audio API (`OfflineAudioContext`).
- **Lệnh deploy lại lên Cloudflare**:
  ```sh
  npm run deploy:cloudflare
  ```

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
2. Dán danh sách nhạc rồi nhấn **Phân tích danh sách**. Tên thư mục có thể không đánh số, có dấu `:`, tiêu đề Markdown (`#`, `**...**`), hoặc nhãn `Thư mục:` / `Folder:`. Bài hát có thể là dòng thường, đánh số `1.` / `1)`, hoặc gạch đầu dòng; giữ nguyên thứ tự và bài trùng.
3. Rà soát tiêu đề mục, tên bài, query và ghi chú, rồi nhấn **Tìm nhạc**. Danh sách chỉ có các bài đánh số được gom vào một thư mục; dòng không rõ vai trò được giữ để rà soát. Query tìm kiếm và tên bài/thư mục không bị chặn theo số ký tự; tên file ZIP vẫn được chuẩn hóa cho hệ điều hành.
4. Bấm thẻ ứng viên để nghe bằng video YouTube nhúng; có thể nhấn **Đúng bản này** ngay mà không cần tải âm thanh. Muốn cắt/fade, nhấn **Nghe thử** để mở waveform. Điểm kết thúc mặc định dùng thời lượng thật, không làm tròn tăng gây lỗi vượt nguồn; đoạn cắt sai hoặc fade vượt đoạn vẫn cần sửa.
5. Khi mọi bài nhạc đã xác nhận, nhấn **Tải tất cả theo thư mục (ZIP)** để nhận `nhac-cuoi.zip` có thư mục `01 - ...`, `02 - ...` và các file MP3 192 kbps đã cắt/fade.

Ví dụ không cần đánh số thư mục:

```text
Đón khách:
1. Hát cho em
2. Ba kể con nghe

MC dẫn:
Perfect (0:30–1:10) (bản gốc)
```

Cũng nhận `Đón khách 1. Hát cho em, 2. Ba kể con nghe. MC dẫn 1. Perfect.` hoặc `Đón khách: Hát cho em; Ba kể con nghe` trên cùng dòng. Dùng dấu `;` để tách bài sau dấu `:`; dấu phẩy, `&`, dấu gạch trong tên bài được giữ nguyên. Khoảng thời gian hỗ trợ `(m:ss–m:ss)`, phần lẻ giây và `h:mm:ss`; khoảng ở bài ưu tiên hơn khoảng ở mục. Chú thích được tách khỏi query, không bỏ nhầm bài có số như `Mambo No. 5` hoặc `Love 2.0`.


## Phát triển & API

`npm run dev:extension` mở Vite trên `http://localhost:5173`. Để kiểm tra UI web, chạy `WEDDING_DEV_ORIGIN=http://localhost:5173 npm run dev:helper`. Chỉ chế độ Vite development dùng `localStorage` thay `chrome.storage.local`; bản build `apps/extension/dist` không có fallback này. Web preview không thay thế bước kiểm tra Load unpacked trên Chrome/Edge.

API cục bộ (`packages/shared/src/api.ts`, mọi lỗi `{error:{code,message}}`): `GET /api/health`, `POST /api/search`, `POST /api/assets`, `GET /api/jobs/:id`, `GET /api/assets/:id`, `GET /api/assets/:id/audio`, `POST /api/exports`, `GET /api/exports/:id/download`.
