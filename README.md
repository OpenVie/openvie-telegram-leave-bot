# Telegram Leave Bot

Repository độc lập này nhận đơn nghỉ phép từ Telegram, tạo `leave_requests` qua OpenVie HTTP API và nhắn kết quả duyệt/từ chối trở lại đúng chat đã gửi đơn. Không cần sửa OpenVie: workflow OpenVie tự chạy hook `onCreate` khi record được tạo.

Bot dùng Node.js 22+, JavaScript ESM và `fetch` có sẵn, không có npm dependency. Nó dùng Telegram long-polling, vì vậy không cần webhook hay URL public.

## Bảo mật

Không commit hoặc gửi token vào chat/BotFather. `.env`, `submissions.json` và trạng thái offset Telegram đều đã được `.gitignore`. Runtime tạo các file trạng thái với quyền chỉ owner được đọc/ghi (`0600`). Bot không ghi Telegram token hay OpenVie API key vào log, và cũng không đưa chúng vào tin nhắn Telegram.

Token Telegram chỉ được dùng gọi `https://api.telegram.org/bot<TOKEN>/...`. OpenVie API key chỉ được gửi qua `Authorization: Bearer <ovk_...>` tới OpenVie.

## Tạo Telegram bot

1. Mở Telegram, tìm **@BotFather**, gửi `/newbot` và làm theo hướng dẫn để đặt tên bot.
2. BotFather trả về token bot một lần. Lưu token đó vào `TELEGRAM_BOT_TOKEN` trong `.env`; không gửi OpenVie API key cho BotFather.
3. Mở chat với bot mới và gửi `/start`, sau đó dùng `/leave`.

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
  "workspaceId": "73940cfb-f2fa-43fb-b3de-18b4b0015a95",
  "role": "WORKSPACE_ADMIN"
}
```

Response chỉ trả `ovk_...` một lần. Lưu ngay giá trị đó vào `OPENVIE_API_KEY` trong `.env`, không commit hay chia sẻ nó.

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
OPENVIE_APP_KIND=hint-leave-management
OPENVIE_ENTITY=leave_requests
POLL_INTERVAL_MS=5000
```

## Luồng sử dụng

`/leave` lần lượt hỏi họ tên, email (có kiểm tra), loại nghỉ (inline keyboard), ngày bắt đầu/kết thúc (`YYYY-MM-DD`), số ngày dương và lý do. Bot tạo record bằng:

```text
POST /api/v1/bizapp-data/hint-leave-management/leave_requests
```

Payload được bọc trong `{ "payload": ... }`; bot không gọi endpoint `/submit`. Sau khi thành công bot trả `recordId`, `processId` và thông báo chờ admin duyệt trên Yaak.

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

Sau khi tạo đơn, bot lưu `recordId -> chatId` trong `submissions.json`. Cứ mỗi `POLL_INTERVAL_MS`, bot đọc record từ:

```text
GET /api/v1/bizapp-data/hint-leave-management/leave_requests/{recordId}
```

Khi `runtime.approvalStatus` là `APPROVED` hoặc `REJECTED`, bot báo kết quả tới chat đã gửi và xóa mapping sau khi gửi thành công. Khi restart, bot đọc lại file này nên các đơn chờ vẫn được theo dõi.
