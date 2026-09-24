# Dốc Mơ Farm agent

Zalo OA and Bot assistant for the farm. Inbound messages share `services/pipeline.js`.

## Human approval (HITL)

Customer-facing replies are held for review on `/admin` unless you explicitly turn the gate off. That includes AI answers, canned replies, the system fallback, and follow-up nudges. Approving a draft still sends through `services/drafts.js` → `deliver()` (`approval_status` `PENDING_REVIEW` until then).

| Variable | Default | Meaning |
|---|---|---|
| `HITL_REQUIRE_APPROVAL` | on when unset | `true`: save a `PENDING_REVIEW` draft and do not send that text to Zalo. `false`, `0`, `no`, or `off`: send immediately (emergency only). |
| `HITL_ACK_MESSAGE` | unset | Optional exact text sent while a draft waits. Blank or unset sends nothing. There is no built-in ack. |

Set both on Railway. Open `/admin` (password `ADMIN_PASSWORD`) to approve and send.
