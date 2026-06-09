import { productChat as baseProductChat, contentAI } from './aiController.js';
import { successResponse } from '../utils/response.js';
import { normalizeVietnameseText } from '../services/chatIntentService.js';

const IN_SCOPE_TERMS = [
  'nuoc hoa',
  'perfume',
  'mui huong',
  'mui',
  'huong',
  'scent',
  'chai',
  'san pham',
  'thuong hieu',
  'brand',
  'dior',
  'chanel',
  'versace',
  'gucci',
  'tom ford',
  'ysl',
  'mont blanc',
  'montblanc',
  'creed',
  'lancome',
  'decant',
  'chiet',
  'mini size',
  'fullbox',
  'full box',
  'ml',
  'gia',
  'don hang',
  'ma don',
  'giao hang',
  'van chuyen',
  'ship',
  'thanh toan',
  'momo',
  'zalopay',
  'cod',
  'doi tra',
  'hoan tien',
  'chinh hang',
  'authentic',
  'hotline',
  'lien he',
];

const OUT_OF_SCOPE_GROUPS = [
  {
    key: 'medical',
    label: 'y tế',
    terms: [
      'bac si',
      'y te',
      'kham benh',
      'chan doan',
      'benh',
      'trieu chung',
      'dau dau',
      'dau bung',
      'di ung',
      'phat ban',
      'kho tho',
      'uong thuoc',
      'don thuoc',
      'thuoc gi',
      'thuoc nao',
      'huyet ap',
      'tieu duong',
      'ung thu',
      'tram cam',
      'tam than',
    ],
  },
  {
    key: 'legal',
    label: 'pháp luật',
    terms: [
      'luat su',
      'phap luat',
      'kien tung',
      'khoi kien',
      'toi pham',
      'di tu',
      'hop dong lao dong',
      'ly hon',
    ],
  },
  {
    key: 'finance',
    label: 'tài chính/đầu tư',
    terms: [
      'dau tu',
      'chung khoan',
      'co phieu',
      'coin',
      'crypto',
      'bitcoin',
      'forex',
      'vay tien',
      'lai suat ngan hang',
      'mua vang',
    ],
  },
];

function includesPhrase(text, phrase) {
  return new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(text);
}

function hasAnyTerm(text, terms) {
  return terms.some((term) => includesPhrase(text, term));
}

function detectOutOfScopeGroup(question) {
  const normalized = normalizeVietnameseText(question);
  return OUT_OF_SCOPE_GROUPS.find((group) => hasAnyTerm(normalized, group.terms)) || null;
}

function hasStoreContext(question) {
  const normalized = normalizeVietnameseText(question);
  return hasAnyTerm(normalized, IN_SCOPE_TERMS);
}

function getChatQuestion(req) {
  return String(req.body?.q || req.body?.question || '').trim();
}

function buildSuggestedQuestions() {
  return [
    'Tư vấn nước hoa cho nam dưới 1 triệu',
    'Mùi đi học/đi làm nên chọn gì?',
    'Decant 10ml còn những mùi nào?',
  ];
}

function buildOutOfScopePayload(group) {
  return {
    answer: `Xin lỗi, HuyPerfume chỉ hỗ trợ tư vấn nước hoa, sản phẩm, decant, đơn hàng và chính sách mua hàng. Nội dung bạn hỏi thuộc nhóm ${group.label}, nên mình không tự ý tư vấn chuyên môn. Bạn nên liên hệ chuyên gia phù hợp để được hỗ trợ chính xác. Nếu cần chọn nước hoa theo phong cách, giới tính, ngân sách hoặc dịp sử dụng, mình sẵn sàng hỗ trợ.`,
    intent: 'out_of_scope',
    needMoreInfo: false,
    suggestedQuestions: buildSuggestedQuestions(),
    products: [],
    actions: [],
    filters: {},
    provider: 'scope_guard',
  };
}

function buildPerfumeSafetyPayload() {
  return {
    answer: 'Mình không thể tư vấn y tế hoặc chẩn đoán triệu chứng. Nếu bạn bị đau đầu, dị ứng, khó thở hoặc khó chịu khi dùng nước hoa, bạn nên ngưng sử dụng và liên hệ bác sĩ/cơ sở y tế khi cần. Trong phạm vi HuyPerfume, mình có thể gợi ý các mùi nhẹ, sạch, ít nồng như citrus, fresh, aquatic hoặc musk nhẹ để bạn tham khảo.',
    intent: 'perfume_safety_limited',
    needMoreInfo: false,
    suggestedQuestions: ['Tư vấn mùi nhẹ đi học/đi làm', 'Nước hoa fresh dưới 1 triệu', 'Decant mùi sạch dễ dùng'],
    products: [],
    actions: [],
    filters: {},
    provider: 'scope_guard',
  };
}

export async function productChat(req, res) {
  const question = getChatQuestion(req);
  const outOfScopeGroup = detectOutOfScopeGroup(question);
  const hasPerfumeOrStoreContext = hasStoreContext(question);

  if (outOfScopeGroup && !hasPerfumeOrStoreContext) {
    return successResponse(res, 'Chatbot từ chối câu hỏi ngoài phạm vi', buildOutOfScopePayload(outOfScopeGroup));
  }

  if (outOfScopeGroup?.key === 'medical') {
    return successResponse(res, 'Chatbot giới hạn tư vấn an toàn', buildPerfumeSafetyPayload());
  }

  return baseProductChat(req, res);
}

export { contentAI };
