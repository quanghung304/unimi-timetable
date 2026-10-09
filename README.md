# UniMi Timetable

Web xem/sửa thời khóa biểu theo tuần cho sinh viên Unimi. Web tĩnh (HTML + ES modules, không cần build) + Supabase (Auth + Postgres).

```
timetable-app/
├─ index.html          giao diện (login, grid, dialog sửa buổi, hồ sơ)
├─ css/style.css
├─ js/
│  ├─ config.js        ← điền URL + anon key của Supabase
│  ├─ supabase.js      client + "Keep me signed in"
│  ├─ api.js           mọi lệnh gọi server (auth, profile, sessions)
│  ├─ importer.js      đọc .xls của Unimi, tách buổi 4h/6h thành ô 2h, gộp khi import lại
│  ├─ grid.js          vẽ grid tuần
│  ├─ dates.js
│  └─ app.js           điều phối UI
├─ supabase/schema.sql bảng, RLS, trigger giới hạn @studenti.unimi.it, xóa tài khoản
└─ _headers            security headers cho Cloudflare Pages
```

## 1. Supabase (miễn phí)

1. Tạo project tại <https://supabase.com> — **Region: Central EU (Frankfurt)**.
2. **SQL Editor** → dán toàn bộ `supabase/schema.sql` → Run.
3. **Project Settings → API**: copy `Project URL` và `anon public` key vào `js/config.js`.
4. **Authentication → Sign In / Providers → Email**: bật Email, bật *Allow new users to sign up*. Email OTP length: 6.
5. **Authentication → URL Configuration**:
   - Site URL: `https://<tên-dự-án>.pages.dev` (hoặc domain riêng)
   - Redirect URLs: thêm URL trên và `http://localhost:8000/**` để chạy thử.
6. **Authentication → Emails → Templates**: sửa cả **Magic Link** và **Confirm signup** để email có cả mã và link:
   ```html
   <h2>Your UniMi Timetable sign-in code</h2>
   <p style="font-size:24px;letter-spacing:4px"><b>{{ .Token }}</b></p>
   <p>Or <a href="{{ .ConfirmationURL }}">click here to sign in</a> (open it in the same browser).</p>
   ```
7. **SMTP riêng (bắt buộc khi chạy thật)** — SMTP mặc định của Supabase chỉ gửi cho thành viên project và giới hạn rất thấp.
   - Tạo tài khoản **Brevo** (300 email/ngày miễn phí) hoặc **Resend** (3.000/tháng), xác minh domain gửi.
   - **Authentication → Emails → SMTP Settings**: điền host/port/user/password, sender `no-reply@<domain>`.
   - **Authentication → Rate Limits**: tăng "emails sent per hour" cho phù hợp (vd. 100).

"Ghi nhớ đăng nhập": phiên lưu trong `localStorage`, refresh token tự gia hạn — mặc định Supabase không giới hạn thời gian phiên, nên người dùng giữ đăng nhập đến khi bấm *Sign out*. Nếu bỏ tick *Keep me signed in*, phiên chỉ sống đến khi đóng trình duyệt.

## 2. Chạy thử trên máy

```bash
python -m http.server 8000   # chạy ở thư mục gốc repo
# mở http://localhost:8000
```
(Phải chạy qua http, không mở trực tiếp file:// vì ES modules bị chặn.)

## 3. Deploy lên Cloudflare Pages (miễn phí)

1. Đẩy code lên GitHub.
2. Cloudflare Dashboard → **Workers & Pages → Create → Pages → Connect to Git** → chọn repo.
3. Build settings: *Framework preset* None, *Build command* để trống, *Build output directory* `/` (gốc repo).
4. Deploy → nhận URL `https://<tên>.pages.dev`. Cập nhật lại Site URL ở bước 1.5.
5. (Tùy chọn) Gắn domain riêng ở tab *Custom domains*.

## 4. Vận hành

- **Free tier bị pause** sau 7 ngày không có request (thường là nghỉ hè). Vào dashboard bấm *Restore*, hoặc nâng Pro ($25/tháng) khi có nhiều người dùng.
- Theo dõi dung lượng: Dashboard → Database → usage (giới hạn free 500 MB). Mỗi user bị giới hạn 3.000 buổi (trigger trong schema).
- Backup: free tier không có backup tự động — định kỳ chạy `pg_dump` hoặc Dashboard → Database → Backups (Pro).

## Quy tắc import

- Đọc sheet đầu tiên, tìm dòng tiêu đề `Weekday | Day | Hour | Course | Lecturer | … | Room | Notes`.
- Buổi có thời lượng là **bội số của 2 giờ** (4h, 6h…) được tách thành các ô 2h liên tiếp; buổi 2h, 3h… giữ nguyên.
- Mỗi ô có khóa `ngày_giờ_môn`. Import lại: ô mới được thêm, ô chưa sửa được cập nhật (giữ ghi chú), ô đã sửa được giữ nguyên, ô biến mất khỏi file (chưa sửa, không ghi chú) bị xóa.
- Ghi chú hướng dẫn in PDF trong cột Notes của file export bị bỏ qua.
- 3 dòng đầu file (năm học, ngành, năm) được điền vào hồ sơ nếu hồ sơ còn trống.
