-- ============================================================
-- 005 — FAQ moves into the database, rewritten in Thu's voice
--
-- The .md file was the only source of product answers, which meant the farm
-- could not fix a typo without a code push, and an edited answer still had
-- the old file text sitting behind it. From here the database is the single
-- source: these rows are editable at /admin, and the .md block is switched
-- off (app_state.faq_md_disabled) so nothing contradicts them.
--
-- Facts, figures and cautions are carried over unchanged from
-- Product/FAQ_Nuoc_Nghe_Len_Men_Claude_Agent.md. Only the voice changed.
-- ============================================================

INSERT INTO bot_lessons (question, answer, note) VALUES

('Nước nghệ lên men là gì?',
'Là nghệ, gừng, riềng organic cùng vài loại gia vị tự nhiên, ủ lên men thủ công với probiotic có lợi.
Men làm cái hăng của nghệ dịu lại, và nâng đỡ đường tiêu hoá tốt hơn so với nghệ tươi thường.',
'FAQ NGM'),

('Nước nghệ lên men uống có ngon không, vị thế nào?',
'Chua nhẹ tự nhiên từ men, thơm mùi gừng - nghệ - gia vị, hậu vị thanh.
Farm có thêm chút mật ong tự nhiên để cân bằng, nên dễ uống hơn nước nghệ truyền thống nhiều.',
'FAQ NGM'),

('Vì sao nước nghệ lên men dễ uống hơn nghệ tươi?',
'Nghệ tươi mùi nồng, vị hăng mạnh.
Qua quá trình lên men, mùi vị dịu lại, thơm hơn, uống vào có cảm giác fresh chứ không gắt.',
'FAQ NGM'),

('Sản phẩm có đường không?',
'Có khoảng 3% mật ong tự nhiên, để nâng vị và nuôi quá trình lên men.
Farm không dùng đường tinh luyện công nghiệp.',
'FAQ NGM'),

('Probiotic trong nước nghệ lên men là gì?',
'Là những lợi khuẩn tốt cho đường ruột.
Trong quá trình lên men tự nhiên, các lợi khuẩn này sinh sôi, góp phần giữ cân bằng hệ vi sinh đường ruột.',
'FAQ NGM'),

('Uống nước nghệ lên men có giúp giữ dáng không?',
'Sản phẩm hợp với lối sống healthy, eat-clean và giữ dáng. Nhiều khách chọn dùng thay cho nước ngọt hoặc đồ uống nhiều đường.
Farm xin nói rõ: đây không phải là thuốc và không thay thế thuốc chữa bệnh.',
'FAQ NGM — giữ nguyên cảnh báo'),

('Uống nước nghệ lên men có đẹp da không?',
'Nghệ và gừng là hai nguyên liệu tự nhiên được nhiều người yêu thích trong chăm sóc sức khoẻ và làm đẹp.
Đi cùng một nếp sinh hoạt hợp lý, cơ thể sẽ khoẻ và tươi hơn.',
'FAQ NGM — không hứa hiệu quả'),

('Ai phù hợp uống nước nghệ lên men?',
'Người thích đồ organic, làm thủ công.
Người theo lối sống healthy.
Người muốn bớt đường lại.
Người quan tâm giữ dáng và chăm sóc cơ thể theo cách tự nhiên.
Người thích các món lên men.',
'FAQ NGM'),

('Người lớn tuổi uống được không?',
'Dạ được.
Nếu cô chú có bệnh lý đặc biệt, hoặc đang dùng thuốc điều trị dài ngày, farm mong cô chú hỏi thêm ý kiến bác sĩ cho yên tâm.',
'FAQ NGM — giữ nguyên khuyến nghị'),

('Phụ nữ uống được không?',
'Dạ hoàn toàn phù hợp, nhất là với những ai thích sản phẩm tự nhiên và nếp sống healthy.',
'FAQ NGM'),

('Có cần bảo quản lạnh không?',
'Dạ có.
Đây là sản phẩm lên men tự nhiên, farm không dùng chất bảo quản mạnh công nghiệp, nên để lạnh sẽ giữ được chất lượng tốt nhất.',
'FAQ NGM'),

('Hạn sử dụng bao lâu?',
'Tuỳ từng mẻ sản xuất, farm ghi rõ trên chai.
Sau khi mở nắp, mình dùng trong thời gian khuyến nghị để giữ được vị ngon nhất.',
'FAQ NGM'),

('Vì sao có cặn dưới đáy chai?',
'Cặn đó đến từ nghệ, gừng, gia vị, hoặc từ chính quá trình lên men tự nhiên.
Với đồ làm thủ công, đây là chuyện bình thường.',
'FAQ NGM'),

('Vì sao mỗi lần mua màu và vị hơi khác nhau?',
'Farm dùng nguyên liệu tự nhiên theo mùa và làm thủ công từng mẻ.
Nên màu hay vị có thể nhích nhẹ giữa các mẻ. Đó là dấu vết của mùa, không phải lỗi.',
'FAQ NGM'),

('Đây có phải nước detox không?',
'Nước nghệ lên men là thức uống lên men tự nhiên từ nghệ và thảo mộc.
Nhiều khách dùng như một phần trong nếp sống healthy mỗi ngày.',
'FAQ NGM — không dùng chữ detox như claim'),

('Uống lúc nào là phù hợp nhất?',
'Nhiều khách chọn những lúc này:
Buổi sáng sau khi ăn nhẹ.
Trước bữa ăn.
Sau bữa nhiều dầu mỡ.
Sau buổi tập nhẹ.',
'FAQ NGM'),

('Một ngày nên uống bao nhiêu?',
'Tuỳ cơ địa và nhu cầu mỗi người.
Thường thì khách dùng một lượng vừa phải mỗi ngày, như một thức uống healthy bình thường thôi.',
'FAQ NGM'),

('Sản phẩm có chất bảo quản không?',
'Farm ưu tiên nguyên liệu tự nhiên và quy trình thủ công.
Thông tin thành phần chi tiết được ghi trên nhãn sản phẩm.',
'FAQ NGM'),

('Nguyên liệu lấy từ đâu?',
'Nghệ, gừng, riềng và phần lớn nguyên liệu khác, farm ưu tiên nguồn organic hoặc canh tác tự nhiên.',
'FAQ NGM'),

('Dốc Mơ Farm khác gì so với nơi khác?',
'Làm thủ công ngay tại eco-farm.
Ưu tiên nguyên liệu organic.
Có probiotic sinh ra từ lên men tự nhiên.
Vị dễ uống hơn nghệ truyền thống.
Và hướng về một nếp sống healthy, bền vững.',
'FAQ NGM'),

('Vì sao giá cao hơn sản phẩm cùng loại?',
'Vì farm ưu tiên nguyên liệu organic, lên men thủ công, và làm từng mẻ nhỏ để giữ đúng chất lượng tự nhiên.',
'FAQ NGM'),

('Sản phẩm này có phải thuốc không?',
'Dạ không.
Đây là thức uống lên men tự nhiên, không phải thuốc và không thay thế thuốc chữa bệnh.',
'FAQ NGM — giữ nguyên, tuyệt đối không đổi')

ON CONFLICT DO NOTHING;

-- Turn off the .md block: the database is now the only source of FAQ answers,
-- so an edited answer can no longer be shadowed by the old file text.
INSERT INTO app_state (key, value) VALUES ('faq_md_disabled', 'true')
ON CONFLICT (key) DO UPDATE SET value = 'true', updated_at = NOW();

-- The welcome message the farm saved by hand had typos ("du cầu", "ọrder lập
-- lại", "sơ xuất") and read as a disclaimer. Same information, same promise
-- about "ngưng BOT", written the way Thu writes.
UPDATE bot_lessons
SET answer =
'Dạ, Dốc Mơ Farm chào bạn.

Farm mình làm thủ công các sản phẩm organic: đồ uống lên men, snack healthy, và đồ chăm sóc cơ thể từ thiên nhiên.

Để trả lời bạn nhanh nhất, farm để trợ lý tự động tiếp chuyện trước, nhất là với những câu hỏi và đơn hàng quen thuộc. Có chỗ nào chưa tròn ý, mong bạn thông cảm giùm.

Bất cứ lúc nào bạn muốn nói chuyện với người thật, chỉ cần nhắn "ngưng bot" — farm sẽ tiếp bạn ngay.

Bạn đang quan tâm sản phẩm nào, cho farm biết nhen.',
    updated_at = NOW()
WHERE answer LIKE '%du c%u%' OR answer LIKE '%s%xu%t%' OR answer LIKE '%rder l%p l%i%';
