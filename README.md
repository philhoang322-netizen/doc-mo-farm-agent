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

Stickers, unclear photos, empty messages, jokes, and any turn whose intent confidence is below `AI_CONFIDENCE_MIN` do not become a normal sales draft. The pipeline pauses the bot, notifies the farm on the existing handoff card, and holds one short waiting line for staff.

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
