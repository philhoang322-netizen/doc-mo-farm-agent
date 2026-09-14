/**
 * How to address a customer in Vietnamese: "anh Tuấn", "chị Lan", or "bạn".
 *
 * Getting this wrong is rude, so the rule is: only commit to anh/chị when we
 * actually know. Three sources, in order of trust:
 *   1. Zalo OA profile (user_gender) — the only hard signal we get
 *   2. The name itself — "Thị"/"Văn" markers and unambiguous given names
 *   3. The customer telling us, which the agent asks for once
 * Anything uncertain stays "bạn", which is polite and safe.
 */

function strip(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/đ/gi, 'd')
    .toLowerCase().trim();
}

/** Vietnamese given name is the LAST syllable: "Nguyễn Văn Tuấn" → "Tuấn". */
function givenName(fullName) {
  const parts = String(fullName || '').trim().split(/\s+/).filter(Boolean);
  return parts.length ? parts[parts.length - 1] : null;
}

// Only names that are unambiguous in practice. Unisex names (Minh, Bảo, An,
// Ngọc, Khánh, Hà, Giang, Tâm, Bình, Xuân, Phương, Hoàng...) are deliberately
// absent — a wrong "anh"/"chị" is worse than a neutral "bạn".
const MALE = new Set(['tuan','hung','dung','nam','long','son','hai','duc','quan','thang',
  'trung','cuong','khoa','huy','kien','vu','tung','dat','thanh','hieu','nghia','phong',
  'quang','tai','thinh','vinh','loc','duy','toan','phuoc','truong','kiet','luan','nhat',
  'sang','tien','tin','trong','viet','dang','manh','hoàng','baỏ']);

const FEMALE = new Set(['lan','huong','hoa','mai','linh','trang','thao','hanh','nga',
  'nhung','oanh','quyen','thu','thuy','trinh','tuyet','van','yen','chi','dung̉',
  'diep','huyen','khue','ly','my','nhu','nhi','tham','uyen','loan','hue','nguyet',
  'suong','thuong','tien̉','trieu','tuyen','hong','cuc','dao','le','lieu','man']);

/** Guess from the name. Returns 'male' | 'female' | null (don't know). */
function guessFromName(fullName) {
  const raw = String(fullName || '');
  if (!raw.trim()) return null;

  // Middle-name markers are the strongest textual signal.
  const words = strip(raw).split(/\s+/);
  if (words.includes('thi')) return 'female';
  if (words.includes('van') && words.length >= 3 && words[words.length - 1] !== 'van') return 'male';

  const g = strip(givenName(raw));
  if (!g) return null;
  if (MALE.has(g)) return 'male';
  if (FEMALE.has(g)) return 'female';
  return null;
}

/** Zalo OA user_gender: 1 = nam, 2 = nữ, anything else unknown. */
function fromZaloGender(v) {
  const n = Number(v);
  if (n === 1) return 'male';
  if (n === 2) return 'female';
  return null;
}

/** "anh Tuấn" / "chị Lan" / "bạn" — what the agent should call them. */
function addressFor(customer) {
  if (!customer) return 'bạn';
  const name = givenName(customer.full_name || customer.display_name);
  const g = customer.gender;
  if (g === 'male') return name ? `anh ${name}` : 'anh';
  if (g === 'female') return name ? `chị ${name}` : 'chị';
  return name ? `bạn ${name}` : 'bạn';
}

/** The instruction block injected into the system prompt. */
function promptBlock(customer) {
  const known = customer && (customer.gender === 'male' || customer.gender === 'female');
  const name = givenName(customer?.full_name || customer?.display_name);

  if (known) {
    return `\nXƯNG HÔ: gọi khách là "${addressFor(customer)}". Dùng đúng như vậy suốt cuộc trò chuyện, ` +
           `xưng "em". Không đổi sang "bạn" nữa.`;
  }
  if (name) {
    return `\nXƯNG HÔ: đã biết tên khách là "${name}" nhưng CHƯA biết nam hay nữ. ` +
           `Tạm gọi "bạn ${name}", xưng "em". Khi có dịp tự nhiên (lúc chốt đơn hoặc xin số điện thoại), ` +
           `hỏi nhẹ một lần: "Dạ em gọi anh hay chị cho phải ạ?". ` +
           `Khách trả lời rồi thì gọi tool save_memory với memory_key = "gioi_tinh", ` +
           `memory_value = "nam" hoặc "nu", rồi gọi "anh ${name}"/"chị ${name}" từ đó về sau.`;
  }
  return `\nXƯNG HÔ: chưa biết tên lẫn giới tính khách. Tạm gọi "bạn", xưng "em". ` +
         `Hỏi tên một cách tự nhiên, và hỏi "em gọi anh hay chị cho phải ạ?" khi phù hợp. ` +
         `Biết rồi thì lưu bằng save_memory: memory_key "ten_khach", và "gioi_tinh" ("nam"/"nu").`;
}

/** Parse what a customer said into a stored gender value. */
function parseGenderValue(v) {
  const s = strip(v);
  if (/(^|\s)(nam|anh|male|m|trai|ong|chu|a)(\s|$)/.test(s)) return 'male';
  if (/(^|\s)(nu|nủ|chi|female|f|gai|ba|co|c)(\s|$)/.test(s)) return 'female';
  return null;
}

module.exports = {
  givenName, guessFromName, fromZaloGender, addressFor, promptBlock, parseGenderValue,
};
