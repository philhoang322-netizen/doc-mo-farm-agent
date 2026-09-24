# Dốc Mơ Farm agent

Zalo OA and Bot assistant for the farm. Inbound messages share `services/pipeline.js`.

## Human approval (HITL)

Customer-facing replies are held for review on `/admin` unless you explicitly turn the gate off. That includes AI answers, canned replies, the system fallback, and follow-up nudges. Approving a draft still sends through `services/drafts.js` → `deliver()` (`approval_status` `PENDING_REVIEW` until then).

| Variable | Default | Meaning |
|---|---|---|
| `HITL_REQUIRE_APPROVAL` | on when unset | `true`: save a `PENDING_REVIEW` draft and do not send that text to Zalo. `false`, `0`, `no`, or `off`: send immediately (emergency only). |
| `HITL_ACK_MESSAGE` | unset | Optional exact text sent while a draft waits. Blank or unset sends nothing. There is no built-in ack. |

Set both on Railway. Open `/admin` (password `ADMIN_PASSWORD`) to approve and send. The name typed on that page is stored as `manager:<tên>` on each edit, approval, and send.

## Audit log

`/admin/audit` lists the chain for a conversation or order: customer message summary, the AI draft, manager edits (before/after), approve/send, and the KiotViet push or a staff status change on the farm dashboard. Rows go to Postgres table `audit_logs` when `DATABASE_URL` is set (migration `014_audit_logs.sql`). The table is append-only. Token, password, and secret fields are redacted before insert. `GET /admin/api/audit` accepts `conversation`, `order`, `from`, `to`, `action`, `entity_type`, and `entity_id`.

## Facebook Messenger

Page messages use the same draft queue as Zalo. A customer text becomes `approval_status` `PENDING_REVIEW` with `channel` `messenger`. Nothing is sent on Facebook until a manager uses **Duyệt và gửi** on `/admin`. That includes the case where `HITL_REQUIRE_APPROVAL` is off: Messenger still waits. There is no ack on this channel.

Webhook URL (Meta App → Messenger → Webhooks):

`https://<host>/messenger/webhook`

Production host today: `https://doc-mo-farm-agent-production.up.railway.app/messenger/webhook`

Subscribe the Page to **`messages`** and **`messaging_postbacks`**. Echoes, delivery receipts, and read receipts are ignored.

| Variable | Default | Meaning |
|---|---|---|
| `MESSENGER_ENABLED` | off | `true`, `1`, `yes`, or `on` accepts inbound events and allows Graph send. Anything else (including unset) answers POST with `200` and does not draft or send. |
| `FB_VERIFY_TOKEN` | required to verify | Shared secret you invent. Meta sends it as `hub.verify_token` on GET. Same value in the Meta webhook form and on Railway. |
| `FB_APP_SECRET` | required when enabled | App secret (App settings → Basic). POST must carry a valid `X-Hub-Signature-256`. A bad signature is HTTP 403 `{ "ok": false, "error": "bad_signature" }`. Railway logs `messenger_bad_signature` with `reason`, `rawBodyLength` (0 if the body was missing), and `signatureHeaderPresent`. The secret, the signature value, and the body are not logged. |
| `FB_PAGE_ACCESS_TOKEN` | required to send | Page token with `pages_messaging`. Approve & Send calls `POST https://graph.facebook.com/v21.0/me/messages`. |
| `FB_PAGE_ID` | optional | Numeric Page id. Events whose sender is this id are ignored. |

`customer_user_id` on a Messenger draft is `fb_<PSID>`. Do not commit tokens. Copy the names into Railway → Variables. See `.env.example`.

Meta setup:

1. Create a Business app at developers.facebook.com and add the Messenger product.
2. Connect the farm Facebook Page. In development mode only app roles can message the Page; switch the app to Live when the Page is ready for customers.
3. Create a Page access token (`pages_messaging`, and `pages_manage_metadata` so the webhook can be subscribed). Put it in `FB_PAGE_ACCESS_TOKEN`. Put the Page id in `FB_PAGE_ID`.
4. Choose a long random `FB_VERIFY_TOKEN`. Set the callback URL above, paste that token, and verify. Meta calls `GET /messenger/webhook`.
5. Copy the App Secret into `FB_APP_SECRET`.
6. Subscribe the Page webhook fields `messages` and `messaging_postbacks`.
7. Set `MESSENGER_ENABLED=true` and redeploy. Send a Page message, open `/admin`, confirm the row says **FB / Messenger** and is **Chờ duyệt**, edit if needed, then **Duyệt và gửi**.

Graph standard messaging works for about 24 hours after the customer's last message. If Approve & Send is later than that, Facebook rejects the call and the draft stays `APPROVED` with `send_error` so it can be retried or handled by hand.

PII: `services/piiHook.js` masks the model copy when `services/pii.js` is on the tree (Module 3). That file is not on `main` yet. Until it lands, the hook is a no-op and stored messages are unchanged. Land Module 3 first for masking; this channel does not need it to hold drafts.

## Three stations

These run inside the agent. They do not call Make.com, and they do not send the model text to the customer.

1. **Filter and routing** (`services/stations.js` → `filterAndRoute`). On every inbound Zalo or Messenger text, before the draft is saved, the step reads the question and picks `sales`, `faq`, `needs-human`, or `other`. The draft stores that as `assigned_department` (Sales, FAQ, Người thật, Khác) and as `customer_intent` (`[sales] Hỏi giá — …`). A request for a person, or a step-aside, is forced to `needs-human`. This step does not call a model and does not send.
2. **Prompt station.** The suggested reply still comes from the existing farm agent (sales rules, prices, KiotViet stock, taught lessons). The system prompt starts with: "Bạn là bộ lọc thông minh. Hãy đọc câu hỏi của khách, trích xuất nhu cầu chính và viết câu trả lời ngắn gọn, lịch sự bằng tiếng Việt." The current turn also carries the route and the main need. The reply is saved as `PENDING_REVIEW`. Messenger stays in that state even if `HITL_REQUIRE_APPROVAL` is off.
3. **Response station** (`services/drafts.js` → `deliver()`). Only **Duyệt và gửi** on `/admin` sends the approved text. Messenger calls Graph `me/messages` with the PSID in `fb_<PSID>`. Zalo OA and Zalo Bot keep their existing send paths and user ids.

## Inbox triage (Nóng / Khẩn / Thường)

`services/triage.js` reads every inbound Zalo OA, Zalo Bot, and Messenger text before a model draft. The four station routes stay (`sales`, `faq`, `needs-human`, `other`). The draft also stores `triage_level` and a Vietnamese label:

| Level | Label | What it is |
|---|---|---|
| `hot` | Nóng | Buy intent, an order, a price together with a quantity, or checkout |
| `urgent` | Khẩn | Complaint, return, exchange, refund, anger, or “gặp người thật” about a problem |
| `normal` | Thường | Product, price, or shipping questions that are not an order |

`/admin` shows the label as a badge and filters the queue with Nóng / Khẩn / Thường.

A price or how-to question can still become a short polite draft. That draft is `PENDING_REVIEW` until **Duyệt và gửi**. Urgent rows are held even when `HITL_REQUIRE_APPROVAL` is off, and no ack is sent for them.

Returns, exchanges, and refunds do not go to the model. The canned draft only says the request was received and asks for the order code, phone, product, and reason. It does not say the request was approved. The route is `needs-human`, ticket status is `NEEDS_HUMAN`, and the existing roster handover assigns whoever is on shift.

## Stock check before chốt đơn

`create_order` reads live KiotViet stock before it inserts an order or pushes one. Sellable qty is `onHand` minus `reserved` at `KIOTVIET_BRANCH_ID` (or the first branch). The call is `GET /products/code/{sku}` and, if that payload has no inventories, `GET /products/{id}` then `GET /productOnHands`. The product-list cache is not the number we sell against.

`KIOTVIET_RETAILER` is the shop code on the `Retailer` header (this farm: `nongsansachdn`). Client id and secret stay in `KIOTVIET_CLIENT_ID` and `KIOTVIET_CLIENT_SECRET`. Do not commit those values.

| Variable | Default | Meaning |
|---|---|---|
| `STOCK_LOW_THRESHOLD` | `5` when unset | Sellable qty at or above this, and enough for the requested qty: the draft/order path continues (the reply still waits as `PENDING_REVIEW`). Qty from 1 up to the threshold minus 1: do not confirm; the draft warns that the item is sắp hết and Sales will check stock. `0`, or less than the requested qty: do not create the order and do not push KiotViet. The draft warns and asks; it does not invent availability. |
| `KIOTVIET_RETAILER` | required for the API | Shop code. Without client id, secret, and retailer, the live check is skipped. |
| `KIOTVIET_BRANCH_ID` | first branch | Branch whose on-hand is checked and used when pushing an order. |

A low or zero result is flagged for Sales (`PENDING_REVIEW`, ticket “Cần đối soát kho”) and is not sent to Zalo, including when `HITL_REQUIRE_APPROVAL` is off. Pushing the order checks stock again and refuses when the gate is not `ok`.

## Low confidence and non-text

Stickers, unclear photos, empty messages, jokes, and any turn whose intent confidence is below `AI_CONFIDENCE_MIN` do not become a normal sales draft. The pipeline notifies the farm on the existing handoff card and holds one short waiting line for staff. It does not set `bot_paused`. Only an explicit “gặp người thật” / stop phrase (`ops.wantsHuman`), or the owner `/dung` command, pauses the bot. While paused, later messages still become `PENDING_REVIEW` cards and are not auto-sent. `POST /admin/api/customers/resume` with `{ "external_key": "fb_…" }` is the `/mo` equivalent.

That draft stays `PENDING_REVIEW`. It is not sent to Zalo, including when `HITL_REQUIRE_APPROVAL` is off. `HITL_ACK_MESSAGE` is not sent on these turns either. Ticket status is `NEEDS_HUMAN` (“Cần human hỗ trợ khẩn cấp”). A stock warning still wins when the model was actually trying to place an order and KiotViet came back low or short.

The model reports confidence with the `report_intent_confidence` tool (0–1, or a percent). Obvious junk is rejected before that call.

| Variable | Default | Meaning |
|---|---|---|
| `AI_CONFIDENCE_MIN` | `0.6` when unset | Minimum intent confidence. `0.6`, `60`, and `60%` are the same threshold. A score below it follows the human fallback above. `0` turns the gate off. An unreadable value uses `0.6`. |

## Staff roster and handover

Hard claims and “I want a real person” are assigned to someone on shift, not left on the owner chat alone. Shifts are edited under Omni Sale DMF at `/admin/roster` (same `ADMIN_PASSWORD` as draft review). Each shift has a name, an optional Zalo Bot chat id, and a window in **Asia/Ho_Chi_Minh**.

Window examples: `1-5 08:00-17:00`, `mon-fri 8-17`, `* 09:00-21:00`, overnight `6 22:00-06:00`. End time is exclusive. `online` is the presence flag on that row (there is no separate presence feed). Selection prefers an on-shift person who is online; otherwise anyone on shift; otherwise the next shift; if the roster is empty, the owner (`OWNER_DISPLAY_NAME`, default “Chủ farm”).

The internal card still goes out through `services/notify.js` → `zaloBotService.sendMessage`. That is the only alert channel in this repo (no Telegram). The assignee’s chat id receives it when set, and `ALERT_BOT_CHAT_ID` still receives a copy when it is different. Blank or `owner` uses only the owner chat.

Assignment runs when:

- the customer asks for a human (`ops.wantsHuman`, before the model)
- the model calls `request_human`, or drift steps aside (existing `notify.handoff`)
- a draft is created or updated with ticket status containing `NEEDS_HUMAN`, `needsHuman: true`, or `claim: true` on the approve API
- a low-confidence or non-text turn is held as `NEEDS_HUMAN`

`services/handover.js` → `escalate()` / `classifyHumanNeed()` assigns those human turns. A normal sales draft is not assigned. HITL is unchanged: AI sales text stays `PENDING_REVIEW` and is not sent until someone approves it.

## PII masking before the model

Customer text is masked in `services/pii.js` before it is sent to Claude or OpenAI. The saved message and the HITL draft still keep the original (phones, emails, and so on) on this server. Placeholders the model sees: `[PHONE]`, `[EMAIL]`, `[CCCD]`, `[CMND]`, `[BANK]`, `[VIETQR]`, `[ADDRESS]`. Product names, quantities, and order codes (`ORD-…`, `HD0…`) stay readable. OpenAI calls set `store: false`. Anthropic's Messages API has no per-request training flag; commercial API data is not used for training.

| Variable | Default | Meaning |
|---|---|---|
| `PII_MASKING_ENABLED` | on when unset | `false`, `0`, `no`, or `off` sends prompts in the clear. Leave unset in production. |

A draft note (no raw value) appears on `/admin` when a model call ran.
