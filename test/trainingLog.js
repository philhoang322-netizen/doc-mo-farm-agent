/**
 * Store a training pair only when Approve & Send changes the AI draft,
 * and put that correction into the model context for a similar question.
 */
const fs = require('fs');
const path = require('path');

const dir = fs.mkdtempSync(path.join('/tmp', 'training-log-'));
process.env.DRAFTS_JSON_PATH = path.join(dir, 'drafts.json');
process.env.TRAINING_LOG_PATH = path.join(dir, 'training_logs.json');
delete process.env.DATABASE_URL;

const drafts = require('../services/drafts');
const training = require('../services/trainingLog');
const aiAgent = require('../services/aiAgent');

function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}

(async () => {
  const created = await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_query: 'Giá nước gừng bao nhiêu',
    customer_name: 'Khách OA',
    draft_reply: 'Dạ 160K/chai ạ',
    approval_status: 'SENT',
    send: true,
  });
  assert(created.approval_status === 'PENDING_REVIEW', 'new draft must stay PENDING_REVIEW');
  assert(created.ops_status === 'pending', 'ops pending');
  assert(created.ai_draft_version === 'Dạ 160K/chai ạ', 'frozen AI draft');
  assert(created.customer_query === 'Giá nước gừng bao nhiêu', 'query stored');

  const saved = await drafts.updateDraft(created.id, {
    draft_reply: 'Dạ nước gừng lên men 160K/chai ạ. Mình uống thử không?',
  });
  assert(saved.draft.approval_status === 'PENDING_REVIEW', 'save does not approve');
  assert((await training.listRecent()).length === 0, 'save without send stores nothing');

  const sent = await drafts.updateDraft(created.id, { send: true });
  assert(sent.draft.approval_status !== 'SENT' || sent.send.sent, 'send path ran');
  const logs = await training.listRecent();
  assert(logs.length === 1, 'one training pair, got ' + logs.length);
  const pair = logs[0];
  assert(pair.action === 'STORE_AS_FEW_SHOT_EXAMPLE', pair.action);
  assert(pair.customer_original_query === 'Giá nước gừng bao nhiêu', pair.customer_original_query);
  assert(pair.ai_draft_version === 'Dạ 160K/chai ạ', pair.ai_draft_version);
  assert(
    pair.manager_corrected_version === 'Dạ nước gừng lên men 160K/chai ạ. Mình uống thử không?',
    pair.manager_corrected_version
  );
  assert(pair.created_at, 'timestamp');

  await drafts.updateDraft(created.id, { send: true });
  assert((await training.listRecent()).length === 1, 'second send does not duplicate');

  const unchanged = await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_query: 'Còn dầu gội không',
    draft_reply: 'Dạ còn hàng ạ',
  });
  assert(unchanged.approval_status === 'PENDING_REVIEW', 'second draft held');
  const same = await drafts.updateDraft(unchanged.id, {
    draft_reply: '  Dạ còn hàng ạ  ',
    send: true,
  });
  assert(same.draft.draft_reply === 'Dạ còn hàng ạ', 'trim');
  const afterSame = await training.listRecent();
  assert(afterSame.length === 2, 'unchanged approval stored at lower weight, got ' + afterSame.length);
  const approved = afterSame.find(row => row.customer_original_query === 'Còn dầu gội không');
  assert(approved && approved.example_kind === 'approved', 'approved kind');
  assert(approved.example_weight === 0.35, 'lower weight');
  assert(approved.action === 'STORE_AS_FEW_SHOT_EXAMPLE', approved.action);

  const quiet = await drafts.createDraft({
    channel: 'zalo',
    sales_channel: 'farm',
    customer_query: 'Còn trứng không',
    draft_reply: 'Dạ còn trứng ạ',
  });
  await drafts.updateDraft(quiet.id, { draft_reply: 'Dạ hết trứng ạ', send: true, learn: false });
  assert((await training.listRecent()).length === 2, 'learn off stores nothing');

  const block = await training.promptBlock('Cho hỏi giá nước gừng với', 'farm');
  assert(block.includes('Mình uống thử không'), 'similar query injects the correction');
  assert(block.includes('Giá nước gừng bao nhiêu'), 'similar query keeps the customer line');
  assert(block.includes('Dạ 160K/chai ạ'), 'similar query keeps the original AI draft');

  const miss = await training.promptBlock('Ship hàng ra nước ngoài được không', 'farm');
  assert(miss === '', 'unrelated query injects nothing');

  const blocks = await aiAgent.systemBlocks(null, [], [], [], 'Giá nước gừng bao nhiêu vậy', 'farm');
  assert(blocks[0].cache_control && blocks[0].cache_control.type === 'ephemeral', 'static block stays cached');
  assert(!blocks[0].text.includes('Mình uống thử không'), 'correction is not in the cached prefix');
  assert(blocks[1].text.includes('Mình uống thử không'), 'correction is in the model context');
  assert(blocks[1].text.includes('Quản lý gửi'), 'few-shot label');

  console.log(JSON.stringify({
    ok: true,
    stored: training.trainingLog(pair),
    skippedUnchanged: false,
    injected: true,
  }));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
