(function () {
  const listEl = document.getElementById('list');
  const noteEl = document.getElementById('note');
  const qEl = document.getElementById('q');
  const fileEl = document.getElementById('file');
  const previewBtn = document.getElementById('preview');
  const confirmBtn = document.getElementById('confirm');
  const rulesEl = document.getElementById('rules');
  const rulesMeta = document.getElementById('rules-meta');
  const editor = document.getElementById('editor');
  const editorTitle = document.getElementById('editor-title');
  const answerEl = document.getElementById('answer');
  const FLAG = {
    TU_DONG: 'Tự động',
    CHUYEN_NGUOI: 'Chuyển người',
    LIVE: 'Tra cứu',
    CHUA_BAT: 'Chưa bật',
  };
  let csvText = '';
  let editing = null;

  function note(text) { noteEl.textContent = text || ''; }

  async function api(url, opts) {
    const res = await fetch(url, Object.assign({ credentials: 'same-origin' }, opts || {}));
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Không tải được');
    return data;
  }

  function diffText(data) {
    return `Thêm ${data.added}, sửa ${data.updated}, gỡ ${data.removed}, giữ ${data.unchanged} (tổng ${data.total}).`;
  }

  function row(item) {
    const card = document.createElement('article');
    card.className = 'card';
    const line = document.createElement('div');
    line.className = 'faq-row';
    const open = document.createElement('button');
    open.type = 'button';
    open.className = 'faq-open';
    const code = document.createElement('span');
    code.className = 'faq-code';
    code.textContent = item.code;
    const question = document.createElement('span');
    question.className = 'faq-q';
    question.textContent = item.question;
    const flag = document.createElement('span');
    flag.className = 'faq-flag' + (item.action_flag === 'CHUA_BAT' ? ' off' : '');
    flag.textContent = FLAG[item.action_flag] || item.action_flag;
    const verify = document.createElement('span');
    verify.className = 'faq-verify';
    verify.textContent = item.verify_status === 'verified' ? 'Đã' : 'Chưa';
    open.append(code, question, flag, verify);
    open.addEventListener('click', () => {
      editing = item.code;
      editor.hidden = false;
      editorTitle.textContent = item.code;
      answerEl.value = item.answer || '';
      answerEl.focus();
    });
    const toggle = document.createElement('button');
    toggle.type = 'button';
    toggle.className = 'switch' + (item.enabled ? ' on' : '');
    toggle.textContent = item.enabled ? 'Bật' : 'Tắt';
    toggle.setAttribute('aria-pressed', item.enabled ? 'true' : 'false');
    toggle.addEventListener('click', async () => {
      try {
        await api('/admin/api/faq/' + encodeURIComponent(item.code), {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ enabled: !item.enabled }),
        });
        await load();
      } catch (err) {
        note(err.message);
      }
    });
    line.append(open, toggle);
    card.appendChild(line);
    return card;
  }

  async function load() {
    const q = qEl.value.trim();
    const data = await api('/admin/api/faq' + (q ? ('?q=' + encodeURIComponent(q)) : ''));
    listEl.textContent = '';
    if (!data.items.length) {
      const empty = document.createElement('p');
      empty.className = 'empty';
      empty.textContent = 'Chưa có mục FAQ.';
      listEl.appendChild(empty);
      return;
    }
    data.items.forEach(item => listEl.appendChild(row(item)));
  }

  async function loadRules() {
    const data = await api('/admin/api/faq/rules');
    rulesEl.value = data.body || '';
    rulesMeta.textContent = data.version
      ? ('Phiên bản ' + data.version)
      : 'Chưa lưu. Đây là quy tắc mặc định, chưa ghi vào cơ sở dữ liệu.';
  }

  document.getElementById('filters').addEventListener('submit', (ev) => {
    ev.preventDefault();
    load().catch(err => note(err.message));
  });

  fileEl.addEventListener('change', () => {
    const file = fileEl.files && fileEl.files[0];
    csvText = '';
    previewBtn.disabled = true;
    confirmBtn.disabled = true;
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      csvText = String(reader.result || '');
      previewBtn.disabled = !csvText.trim();
      note(file.name);
    };
    reader.readAsText(file);
  });

  previewBtn.addEventListener('click', async () => {
    try {
      const data = await api('/admin/api/faq/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, confirm: false }),
      });
      confirmBtn.disabled = false;
      note('Xem trước: ' + diffText(data) + ' Bấm Thay toàn bộ để ghi.');
    } catch (err) {
      confirmBtn.disabled = true;
      note(err.message);
    }
  });

  confirmBtn.addEventListener('click', async () => {
    try {
      const data = await api('/admin/api/faq/import', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ csv: csvText, confirm: true }),
      });
      confirmBtn.disabled = true;
      note('Đã thay. ' + diffText(data));
      await load();
    } catch (err) {
      note(err.message);
    }
  });

  document.getElementById('save-rules').addEventListener('click', async () => {
    try {
      const data = await api('/admin/api/faq/rules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body: rulesEl.value }),
      });
      rulesMeta.textContent = 'Phiên bản ' + data.version;
      note('Đã lưu quy tắc.');
    } catch (err) {
      note(err.message);
    }
  });

  document.getElementById('save-answer').addEventListener('click', async () => {
    if (!editing) return;
    try {
      await api('/admin/api/faq/' + encodeURIComponent(editing), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ answer: answerEl.value }),
      });
      note('Đã lưu ' + editing);
      await load();
    } catch (err) {
      note(err.message);
    }
  });

  loadRules().catch(err => note(err.message));
  load().catch(err => note(err.message));
})();
