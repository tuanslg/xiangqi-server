# xiangqi-server

Backend của game Cờ Tướng: API cờ máy (Pikafish), đăng nhập Google, phòng chơi online (WebSocket), PostgreSQL.
Frontend nằm ở repo riêng **xiangqi-client**.

## Cách hoạt động

- **Chơi với máy:** `POST /api/bestmove` nhận FEN + mức độ, chạy một pool process Pikafish (UCI). 4 mức: Dễ, Trung bình, Khó, Siêu khó (`src/engine/levels.ts`).
- **Chơi online:** WebSocket `/ws`. Server là nguồn sự thật: kiểm tra nước đi, đồng hồ, chiếu dai/lặp nước, rớt mạng (90 giây để vào lại). Khách được nhận diện bằng cookie `gid`, không cần đăng nhập.
- **Đăng nhập:** Google Identity Services. Server xác thực ID token + nonce rồi cấp session cookie `httpOnly`. Chỉ để lưu ván.
- **Bảo mật:** CORS theo `ALLOWED_ORIGINS`, kiểm tra Origin cho request ghi và WebSocket, giới hạn tốc độ, session chỉ lưu hash.

## Chạy khi phát triển

Yêu cầu: Node 20+ (khuyên dùng 22). PostgreSQL chỉ cần nếu muốn thử đăng nhập/lưu ván.

```bash
npm install
npm run engine:fetch     # tải Pikafish (kiểm tra checksum) vào ./engine
npm run dev              # API trên :3001
```

Bật đăng nhập và lưu ván bằng biến môi trường:

```bash
DATABASE_URL=postgres://user:pass@localhost:5432/xiangqi \
GOOGLE_CLIENT_ID=xxxx.apps.googleusercontent.com \
ALLOWED_ORIGINS=http://localhost:5173 \
npm run dev
```

`ALLOWED_ORIGINS` là origin của frontend (dev: `http://localhost:5173`). Các biến khác nằm trong `src/config.ts`.

## Kiểm thử

```bash
npm test
npm run typecheck
```

Test dùng Postgres chạy khi có `TEST_DATABASE_URL` (tên database **phải kết thúc bằng `_test`**, vì test xóa sạch schema):

```bash
TEST_DATABASE_URL=postgres://user@localhost:5432/xiangqi_test npm test
```

Test Pikafish thật tự bỏ qua nếu chưa chạy `npm run engine:fetch`. Kiểm tra độ mạnh các mức: `npm run selfplay`.

## Thư mục `shared/`

Luật cờ, FEN/UCI và giao thức WebSocket được **sao chép** vào cả hai repo (`shared/`, khai báo `"@xiangqi/shared": "file:./shared"`).
**Repo này là nơi gốc.** Sửa ở đây, rồi đồng bộ sang client:

```bash
npm run shared:push      # ghi đè ../xiangqi-client/shared bằng bản ở đây
npm run shared:check     # kiểm tra hai bản có lệch nhau không (exit 1 nếu lệch)
```

Hai repo phải nằm cạnh nhau (`../xiangqi-client`) để dùng hai lệnh trên. Đổi giao thức thì phải deploy cả hai phía.

## Triển khai

Xem [DEPLOY.md](DEPLOY.md).

## Giấy phép các thành phần bên thứ ba

- **Pikafish** (GPL-3.0), chạy như một process riêng.
- **`pikafish.nnue`**: **không được dùng thương mại nếu chưa được phép** (xem `NNUE-License.md` trong thư mục `engine/` sau khi tải). Nếu định kiếm tiền, hãy xin phép tác giả hoặc đổi sang mạng CC0 của Fairy-Stockfish.
