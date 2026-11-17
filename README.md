# Telegram Leave Bot

Repository này biến Telegram thành một cửa sổ OpenVie Chat: mỗi Telegram chat có một OpenVie chat session riêng. Người dùng nhắn tự nhiên, ví dụ `Tôi muốn xin nghỉ`; bot chuyển tin nhắn sang OpenVie và trả lại câu trả lời/form của assistant vào Telegram. Khi OpenVie trả action tạo đơn hợp lệ, bot hiển thị nút **Xác nhận gửi đơn**; đơn chỉ được tạo sau khi người dùng bấm nút đó.

Bot dùng Node.js 22+, JavaScript ESM và `fetch` có sẵn, không có npm dependency. Nó dùng Telegram long-polling, vì vậy không cần webhook hay URL public.

## Bảo mật

Không commit hoặc gửi token vào chat/BotFather. `.env`, `submissions.json`, `chat-sessions.json` và trạng thái offset Telegram đều đã được `.gitignore`. Runtime tạo các file trạng thái với quyền chỉ owner được đọc/ghi (`0600`). Bot không ghi Telegram token hay OpenVie API key vào log, và cũng không đưa chúng vào tin nhắn Telegram.

Token Telegram chỉ được dùng gọi `https://api.telegram.org/bot<TOKEN>/...`. OpenVie API key chỉ được gửi qua `Authorization: Bearer <ovk_...>` tới OpenVie.

## Tạo Telegram bot

1. Mở Telegram, tìm **@BotFather**, gửi `/newbot` và làm theo hướng dẫn để đặt tên bot.
2. BotFather trả về token bot một lần. Lưu token đó vào `TELEGRAM_BOT_TOKEN` trong `.env`; không gửi OpenVie API key cho BotFather.
3. Mở chat với bot mới, gửi `/start`, sau đó nhắn `Tôi muốn xin nghỉ` như khi dùng OpenVie Chat. Dùng `/new` để tạo cuộc trò chuyện mới; `/leave` là lối tắt gửi câu `Tôi muốn xin nghỉ`; `/status` hiển thị trạng thái các đơn đã gửi trong chat đó.

## Tạo OpenVie API key

Manifest của app hiện yêu cầu API key role `WORKSPACE_ADMIN` để tạo leave request. Dùng access token của `ORG_OWNER` để tạo key:

```yaml
POST {BASE}/api/v1/admin/api-keys
Authorization: Bearer <ORG_OWNER-access-token>
Content-Type: application/json
```

```json
{
  "name": "Telegram leave demo",
  "workspaceId": "<workspace-id-của-OpenVie-Chat>",
  "role": "WORKSPACE_ADMIN"
}
```

Response chỉ trả `ovk_...` một lần. Lưu ngay giá trị đó vào `OPENVIE_API_KEY` trong `.env`, không commit hay chia sẻ nó.

API key phải thuộc cùng workspace với OpenVie Chat/Leave Request Management. Admin cần chuyển Yaak sang workspace này trước khi xem và duyệt task.

## Chạy bot

```bash
cp .env.example .env
# Điền TELEGRAM_BOT_TOKEN và OPENVIE_API_KEY trong .env
node bot.mjs
```

Các biến cấu hình đều chỉ được đọc từ `.env`:

```env
TELEGRAM_BOT_TOKEN=
OPENVIE_API_KEY=
OPENVIE_BASE_URL=https://premonumental-melita-uncontained.ngrok-free.dev
OPENVIE_APP_KIND=leave-requests
OPENVIE_ENTITY=leave_requests
POLL_INTERVAL_MS=5000
```

## Luồng sử dụng

Bot dùng ba API OpenVie:

```text
POST /api/v1/chat/sessions
POST /api/v1/chat/sessions/{sessionId}/messages
POST /api/v1/chat/actions/execute
```

Hai API đầu dùng assistant mặc định của workspace và trả cùng nội dung/action card như OpenVie Chat. Telegram hiển thị nội dung card dưới dạng tin nhắn, kèm bản xem lại các trường đã trích xuất. Khi action có trạng thái `PROPOSED` (hoặc `VALID`), Telegram hiện `Xác nhận gửi đơn` và `Sửa lại`; nút sửa xóa preview cũ và yêu cầu người dùng gửi thông tin cần chỉnh. Chỉ nút xác nhận mới gọi API execute, nên một tin nhắn chưa đủ thông tin sẽ không tạo bản ghi nghỉ phép.

Admin duyệt thủ công trong Yaak, không qua Telegram:

```text
GET  /api/v1/workflow/engine/tasks
POST /api/v1/workflow/engine/tasks/{taskId}/claim
```

Sau đó complete task với một trong hai quyết định:

```json
{
  "variables": {
    "decision": "APPROVE",
    "decidedBy": "<OpenVie-admin-user-id>"
  }
}
```

Hoặc đổi `APPROVE` thành `REJECT`. Bot không có nút Approve/Reject và không tự claim/complete task.

Sau khi tạo đơn, bot tự xóa các tin preview/nút xác nhận của chính bot và lưu `recordId -> chatId` trong `submissions.json`. Cứ mỗi `POLL_INTERVAL_MS`, bot đọc record từ:

```text
GET /api/v1/bizapp-data/leave-requests/leave_requests/{recordId}
```

Khi `runtime.approvalStatus` là `APPROVED` hoặc `REJECTED`, bot báo kết quả tới chat đã gửi. Mapping được giữ lại để `/status` có thể trả `ĐANG CHỜ DUYỆT`, `ĐÃ DUYỆT`, hoặc `ĐÃ TỪ CHỐI` cho các đơn của chat đó. Khi restart, bot đọc lại file này nên các đơn vẫn tra cứu được.
