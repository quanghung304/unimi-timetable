# UniMi Timetable

Web xem/sửa thời khóa biểu theo tuần cho sinh viên Unimi. Đăng nhập bằng email + mật khẩu. Web tĩnh (HTML + ES modules, không cần build) + Supabase (Auth + Postgres).

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
4. **Authentication → Sign In / Providers → Email** (đăng nhập bằng email + mật khẩu, **không gửi email nào**):
   - bật *Enable Email provider* và *Allow new users to sign up*
   - **tắt *Confirm email*** — để đăng ký xong là vào app ngay
   - **tắt *Secure password change*** — để người dùng đổi mật khẩu mà không cần email xác nhận
   - *Minimum password length*: 6
5. **Tạo tài khoản admin**: mở app → *Create account* bằng `hung.cao@studenti.unimi.it`, rồi chạy trong SQL Editor:
   ```sql
   insert into public.admins (user_id)
   select id from auth.users where email = 'hung.cao@studenti.unimi.it';
   ```
   Đăng nhập lại → *Profile* sẽ có mục **Admin · reset a user's password**.
   Làm bước này **trước khi** chia sẻ link, để không ai đăng ký trước bằng email của bạn.

**Quên mật khẩu**: sinh viên liên hệ admin → admin vào *Profile → Admin* nhập email + mật khẩu tạm → báo cho sinh viên → sinh viên đăng nhập và đổi ở *Profile → Change password*.

**Admin tự quên mật khẩu**: đăng nhập <https://supabase.com/dashboard> → project → **SQL Editor**, chạy (thay mật khẩu tạm):
```sql
update auth.users
   set encrypted_password = extensions.crypt('MatKhauTam123', extensions.gen_salt('bf')),
       updated_at = now()
 where email = 'hung.cao@studenti.unimi.it';
```
Đăng nhập app bằng mật khẩu tạm rồi đổi lại ở *Profile → Change password*. Cách này dùng được cho mọi tài khoản.
Vì tài khoản Supabase (hoặc GitHub dùng để đăng nhập Supabase) là "chìa khóa tổng", hãy bật **xác minh 2 bước** cho nó.

> Lưu ý: vì không xác minh email, về lý thuyết một người có thể đăng ký bằng địa chỉ `@studenti.unimi.it` của người khác (nếu người đó chưa có tài khoản). Dữ liệu ở đây chỉ là thời khóa biểu nên rủi ro thấp; khi cần chặt hơn thì bật lại *Confirm email* + cấu hình SMTP.

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

## Lịch lặp lại (cả kỳ)

*+ Add lesson* → tick **Repeat weekly** → chọn thứ (có thể nhiều thứ), ngày bắt đầu và **Until** (ngày cuối). App tạo từng buổi riêng (tối đa 200) và gắn chung một `series_id`.
Khi sửa/xóa một buổi trong chuỗi: chọn **This lesson only** hoặc **This and all following lessons** — môn, giờ, phòng, giảng viên, loại áp dụng cho các buổi từ buổi đó trở đi; ngày và ghi chú chỉ áp dụng cho buổi đang mở.
Ngày nghỉ lễ (vd. Natale) không tự bỏ qua — xóa riêng từng buổi đó với *This lesson only*.

> Cập nhật từ bản trước: chạy lại `supabase/schema.sql` trong SQL Editor (thêm cột `series_id`).

## Quy tắc import

- Đọc sheet đầu tiên, tìm dòng tiêu đề `Weekday | Day | Hour | Course | Lecturer | … | Room | Notes`.
- Buổi có thời lượng là **bội số của 2 giờ** (4h, 6h…) được tách thành các ô 2h liên tiếp; buổi 2h, 3h… giữ nguyên.
- Mỗi ô có khóa `ngày_giờ_môn`. Import lại: ô mới được thêm, ô chưa sửa được cập nhật (giữ ghi chú), ô đã sửa được giữ nguyên, ô biến mất khỏi file (chưa sửa, không ghi chú) bị xóa.
- Ghi chú hướng dẫn in PDF trong cột Notes của file export bị bỏ qua.
- 3 dòng đầu file (năm học, ngành, năm) được điền vào hồ sơ nếu hồ sơ còn trống.
