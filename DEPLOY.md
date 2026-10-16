# Triển khai API lên VPS

Stack: **Caddy** (HTTPS tự động) → **api** (Node + Pikafish) → **PostgreSQL**, chạy bằng Docker Compose, chỉ Caddy mở cổng ra ngoài.
Website (repo **xiangqi-client**) deploy riêng lên Cloudflare Pages; xem DEPLOY.md của repo đó.

## 1. Chuẩn bị

- VPS **x86-64** (bản Pikafish dùng ở đây chỉ có binary Linux x86-64), Ubuntu 22.04+ hoặc Debian 12, **tối thiểu 2 vCPU / 2 GB RAM** (khuyên 4 GB). Mỗi process Pikafish tốn ~100 MB RAM và một lõi CPU khi đang tính.
- Cài Docker + plugin compose. Mở cổng **80, 443 (TCP+UDP)**.
- Chọn VPS gần người chơi (ví dụ Singapore nếu người chơi ở Việt Nam): độ trễ quan trọng với game online.
- Một **tên miền của bạn**, dùng hai host trên cùng domain: `app.example.com` (website) và `api.example.com` (API, bản ghi **A** trỏ về IP của VPS, tạo trước khi chạy để Caddy xin được chứng chỉ).

> **Vì sao phải cùng domain:** đăng nhập và nhận diện khách dùng cookie do API đặt. Trình duyệt chỉ gửi chúng kèm request khi website và API cùng *registrable domain*. Website để ở `xxx.pages.dev` thì cookie bị coi là cross-site và đăng nhập sẽ hỏng.

## 2. Google OAuth Client ID (cho nút đăng nhập)

1. [Google Cloud Console](https://console.cloud.google.com/) → chọn/tạo project → **APIs & Services → OAuth consent screen**: loại *External*, điền tên app và email, **Publish app** (để Testing thì chỉ tài khoản test đăng nhập được).
2. **Credentials → Create credentials → OAuth client ID → Web application**.
3. **Authorized JavaScript origins**: origin của **website** `https://app.example.com` (không phải của API), và `http://localhost:5173` nếu muốn thử khi dev. **Không cần** redirect URI (luồng popup của Google Identity Services).
4. Copy **Client ID** vào `.env`.

Bỏ trống `GOOGLE_CLIENT_ID` thì nút đăng nhập ẩn; chơi với máy và online vẫn bình thường.

## 3. Triển khai

```bash
git clone <repo> xiangqi-server && cd xiangqi-server
cp .env.example .env
openssl rand -hex 24                          # dán vào POSTGRES_PASSWORD
nano .env                                     # điền API_DOMAIN, APP_ORIGIN, POSTGRES_PASSWORD, GOOGLE_CLIENT_ID

docker compose up -d --build
docker compose logs -f api                    # đợi "Server listening"
curl https://api.example.com/api/health       # {"status":"ok"}
```

Build trên máy Apple Silicon thì thêm `--platform linux/amd64` (hoặc build thẳng trên VPS). Migration database chạy tự động khi `api` khởi động.

## 4. Vận hành

| Việc | Lệnh |
|---|---|
| Cập nhật API | `git pull && docker compose up -d --build` |
| Xem log | `docker compose logs -f api` |
| Backup | `docker compose exec -T db pg_dump -U xiangqi xiangqi \| gzip > backup-$(date +%F).sql.gz` (đặt vào cron, và chép ra ngoài VPS) |
| Khôi phục | `gunzip -c backup.sql.gz \| docker compose exec -T db psql -U xiangqi xiangqi` |

**Lưu ý khi cập nhật:** các ván đang chơi lưu trong RAM của `api`, nên khởi động lại sẽ làm mất những ván đó (ván đã kết thúc thì đã lưu vào DB). Nên deploy vào giờ ít người chơi. Hiện chỉ chạy **một** instance `api`; muốn chạy nhiều instance phải chuyển trạng thái phòng sang Redis hoặc tương tự.

**Đổi giao thức (`shared/`):** deploy API và website cùng lúc, hoặc giữ tương thích ngược, vì hai phía phải hiểu nhau.

**Chỉnh tải engine:** `ENGINE_POOL_SIZE × ENGINE_THREADS` nên ≤ số vCPU. Khi quá tải, API trả 503 và client tự chuyển sang minimax cục bộ.

## 5. Bảo mật

- Bật tường lửa chỉ cho phép 22, 80, 443. Tắt đăng nhập SSH bằng mật khẩu.
- Giữ `.env` ngoài git (đã nằm trong `.gitignore`).
- `APP_ORIGIN` chỉ nên là origin của website thật; đây là danh sách duy nhất được phép gọi API kèm cookie.

## 6. Giấy phép

Pikafish là GPL-3.0. File mạng `pikafish.nnue` **cấm dùng thương mại nếu chưa được phép**: nếu dự định kiếm tiền từ dịch vụ, cần xin phép tác giả hoặc đổi sang mạng CC0 của Fairy-Stockfish.
