/**
 * "Viết lại theo giọng Thu" — runs inside the web admin.
 *
 * The van-thu skill lives on the farm's laptop; the server can't read it. What
 * it can do is carry the same instructions and call Claude. The rules below are
 * a faithful, condensed form of that skill, plus the one constraint that
 * matters most here: this is a FAQ, so facts, figures and health cautions must
 * come through untouched. A prettier sentence that changes "3% mật ong" or
 * drops "không phải là thuốc" is a failure, not a rewrite.
 *
 * Nothing is saved from here. The proposal goes back to the browser for the
 * farm to read and approve.
 */
const Anthropic = require('@anthropic-ai/sdk');
const llm = require('./llm');

const claude = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const VOICE = `Bạn viết lại văn bản theo VĂN PHONG CỦA THU — người viết của Dốc Mơ Farm.

CỐT LÕI GIỌNG
- Viết như một người đang chăm sóc, không phải đang bán hay đang giảng.
- Bắt đầu từ cảm giác hoặc một cảnh thật, không từ kết luận hay thông số.
- Cảm quan cụ thể thay cho mỹ từ. Một quan sát thật hơn mười tính từ.
- Chậm, có khoảng thở. Câu ngắn để lặng, câu dài để cuốn. Nhịp có lên xuống.
- Khiêm cung: nói đúng quy mô, không tự phong mình cứu rỗi điều gì lớn lao.
- Con người và thiên nhiên nuôi nhau; đứng cùng chứ không đứng trên sự sống.

XƯNG HÔ
- Tự xưng "farm" hoặc "tụi mình". Tránh "chúng tôi" lạnh.
- Hạn chế gọi thẳng người đọc, vì hệ thống sẽ tự chèn "anh/chị + tên" tuỳ khách.
- Hạt cuối câu Nam Bộ dùng vừa phải: "nhen", "nhé", "ạ".

TRÁNH
- Sáo ngữ quảng cáo: "sốc", "số 1", "đỉnh cao", "tuyệt vời", "vô cùng đặc biệt".
- Mỹ từ chồng đống. Giật tít. Chữ IN HOA giữa câu.
- Emoji: tối đa một cái, và chỉ khi thật hợp. Thường là không có.
- Không mặc định giọng "nữ tính"; giọng này dịu và giàu chăm sóc, không giới hạn giới tính.

RANH GIỚI TUYỆT ĐỐI — quan trọng hơn mọi điều ở trên
- KHÔNG đổi, KHÔNG bỏ, KHÔNG thêm bất kỳ sự thật, con số, tỉ lệ, tên nguyên liệu nào.
  "3% mật ong tự nhiên" phải còn nguyên là "3% mật ong tự nhiên".
- KHÔNG bỏ hay làm nhẹ đi các cảnh báo sức khoẻ. Những câu như
  "không phải là thuốc và không thay thế thuốc chữa bệnh",
  "hỏi thêm ý kiến bác sĩ" phải được giữ, có thể đổi cách đặt câu nhưng giữ nguyên ý và độ rõ.
- KHÔNG thêm công dụng, hiệu quả, chứng nhận, cam kết mà bản gốc không có.
- KHÔNG bịa cảnh, bịa chi tiết cảm quan mà bản gốc không nói tới.
- Đây là câu trả lời cho khách trên Zalo: giữ NGẮN. Thường 2-5 dòng.
  Nếu bản gốc là danh sách, giữ dạng danh sách.

ĐẦU RA
Chỉ trả về đúng phần văn bản đã viết lại. Không mở đầu, không giải thích, không ngoặc kép bao ngoài.`;

/**
 * @param {string} text  the answer as it stands
 * @param {string} [question]  the question it answers, for context
 * @returns {{ok:boolean, text?:string, error?:string, tokens?:number}}
 */
async function toThuVoice(text, question = '') {
  const source = String(text || '').trim();
  if (!source) return { ok: false, error: 'Chưa có nội dung để viết lại' };
  if (!process.env.ANTHROPIC_API_KEY) return { ok: false, error: 'Thiếu ANTHROPIC_API_KEY' };

  try {
    const { response: res } = await llm.anthropicCreate(claude, {
      model: 'claude-sonnet-4-6',
      max_tokens: 1200,
      system: VOICE,
      messages: [{
        role: 'user',
        content:
          (question ? `Câu hỏi của khách: ${question}\n\n` : '') +
          `Viết lại đoạn dưới đây theo văn phong Thu, giữ nguyên mọi sự thật và cảnh báo:\n\n${source}`,
      }],
    });

    const out = res.content.filter(b => b.type === 'text').map(b => b.text).join('').trim();
    if (!out) return { ok: false, error: 'Không nhận được bản viết lại' };

    return {
      ok: true,
      text: out,
      tokens: (res.usage?.input_tokens || 0) + (res.usage?.output_tokens || 0),
      warnings: checkFacts(source, out),
    };
  } catch (e) {
    console.error('Rewrite failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * Cheap safety net: flag numbers or health cautions that vanished in the
 * rewrite, so the farm sees a warning above the proposal instead of having
 * to spot it themselves.
 */
function checkFacts(before, after) {
  const warn = [];

  const nums = (s) => (String(s).match(/\d+([.,]\d+)?\s*%?/g) || []).map(x => x.trim());
  const lost = nums(before).filter(n => !after.includes(n));
  if (lost.length) warn.push(`Con số biến mất: ${[...new Set(lost)].join(', ')}`);

  const guards = [
    ['không phải là thuốc', 'cảnh báo "không phải là thuốc"'],
    ['thay thế thuốc', 'cảnh báo "không thay thế thuốc chữa bệnh"'],
    ['bác sĩ', 'khuyến nghị hỏi bác sĩ'],
  ];
  const lc = (s) => String(s).toLowerCase();
  for (const [needle, label] of guards) {
    if (lc(before).includes(needle) && !lc(after).includes(needle.split(' ')[needle.split(' ').length - 1])) {
      warn.push(`Thiếu ${label}`);
    }
  }
  return warn;
}

module.exports = { toThuVoice, checkFacts };
