import { errorResponse, successResponse } from '../utils/response.js';
import { getBrands } from '../models/brandModel.js';
import { getProductById, getProductsPaged, searchProducts } from '../models/productModel.js';
import { normalizeVietnameseText, parseChatIntent } from '../services/chatIntentService.js';

function cleanText(value) {
  return String(value || '').trim();
}

function toPrice(product) {
  return product.effectivePrice ?? (product.discountPrice > 0 ? product.discountPrice : product.price);
}

function selectDisplayProductOption(product, filters = {}) {
  const minPrice = Number(filters.minPrice);
  const maxPrice = Number(filters.maxPrice);
  const hasMinPrice = filters.minPrice !== null && filters.minPrice !== undefined && Number.isFinite(minPrice);
  const hasMaxPrice = filters.maxPrice !== null && filters.maxPrice !== undefined && Number.isFinite(maxPrice);
  if ((!hasMinPrice && !hasMaxPrice) || !Array.isArray(product.variants) || !product.variants.length) {
    return product;
  }

  const matchingVariants = product.variants
    .filter((variant) => {
      const price = toPrice(variant);
      if (!variant.isAvailable || !Number.isFinite(price)) return false;
      return (!hasMinPrice || price >= minPrice) && (!hasMaxPrice || price <= maxPrice);
    })
    .sort((left, right) => toPrice(left) - toPrice(right));

  if (!matchingVariants.length) return product;
  const selectedVariant = matchingVariants[0];
  return {
    ...product,
    price: selectedVariant.price,
    originalPrice: selectedVariant.originalPrice,
    discountPrice: selectedVariant.discountPrice,
    effectivePrice: selectedVariant.effectivePrice,
    volumeMl: selectedVariant.volumeMl ?? product.volumeMl,
    selectedVariant,
  };
}

function summarizeProduct(product, filters = {}) {
  const displayProduct = selectDisplayProductOption(product, filters);
  const effectivePrice = toPrice(displayProduct);
  const originalPrice = displayProduct.originalPrice ?? displayProduct.price ?? effectivePrice;
  const discountPrice = displayProduct.discountPrice ?? displayProduct.salePrice ?? null;
  return {
    id: displayProduct.id,
    name: displayProduct.name,
    brand: displayProduct.brand?.name || '',
    price: effectivePrice,
    priceOriginal: displayProduct.originalPrice ?? displayProduct.price,
    originalPrice,
    discountPrice,
    salePrice: discountPrice,
    effectivePrice,
    volumeMl: displayProduct.volumeMl ?? null,
    gender: displayProduct.gender || null,
    scentGroup: displayProduct.scentGroup || '',
    scentNotes: displayProduct.scentNotes || '',
    topNotes: displayProduct.topNotes || '',
    middleNotes: displayProduct.middleNotes || '',
    baseNotes: displayProduct.baseNotes || '',
    description: displayProduct.description || '',
    image: displayProduct.image || '',
    detailUrl: `/products/${displayProduct.id}`,
    isInStock: Boolean(displayProduct.isInStock ?? displayProduct.stock > 0),
    stock: displayProduct.stock,
    category: displayProduct.category?.name || '',
    isDecant: displayProduct.isDecant,
    hasDecantOptions: Array.isArray(displayProduct.decantOptions) && displayProduct.decantOptions.length > 0,
    availableVolumeMl: displayProduct.availableVolumeMl ?? null,
    decantOptions: Array.isArray(displayProduct.decantOptions)
      ? displayProduct.decantOptions.map((option) => ({
        id: option.id,
        volumeMl: option.volumeMl,
        price: option.price,
        status: option.status !== false,
      }))
      : [],
    status: displayProduct.status,
    selectedVariant: displayProduct.selectedVariant
      ? {
        id: displayProduct.selectedVariant.id,
        label: displayProduct.selectedVariant.label,
        volumeMl: displayProduct.selectedVariant.volumeMl ?? null,
        type: displayProduct.selectedVariant.type || '',
        effectivePrice: displayProduct.selectedVariant.effectivePrice ?? null,
        stock: displayProduct.selectedVariant.stock ?? displayProduct.selectedVariant.stockQuantity ?? 0,
        isAvailable: Boolean(displayProduct.selectedVariant.isAvailable),
      }
      : null,
    variants: Array.isArray(product.variants)
      ? product.variants.map((variant) => ({
        id: variant.id,
        label: variant.label,
        volumeMl: variant.volumeMl ?? null,
        type: variant.type || '',
        effectivePrice: variant.effectivePrice ?? null,
        stock: variant.stock ?? variant.stockQuantity ?? 0,
        isAvailable: Boolean(variant.isAvailable),
      }))
      : [],
  };
}

function scoreProduct(query, product) {
  const q = normalizeVietnameseText(query);
  if (!q) return 0;
  const name = normalizeVietnameseText(product.name);
  let score = 0;

  if (name.includes(q) || q.includes(name)) score += 5;
  for (const token of name.split(/\s+/).filter((t) => t.length >= 3)) {
    if (q.includes(token)) score += 2;
  }

  if (product.brand?.name && q.includes(normalizeVietnameseText(product.brand.name))) score += 2;
  if (product.category?.name && q.includes(normalizeVietnameseText(product.category.name))) score += 2;
  if (product.scentNotes && q.includes(normalizeVietnameseText(product.scentNotes))) score += 1;
  return score;
}

function compactFilters(filters) {
  return Object.fromEntries(
    Object.entries(filters || {}).filter(([, value]) => value !== null && value !== '' && value !== false),
  );
}

function hasMeaningfulPreference(filters = {}) {
  return [
    filters.minPrice,
    filters.maxPrice,
    filters.gender,
    filters.brand,
    filters.scent,
    filters.scentGroup,
    filters.search,
    filters.volumeMl,
    filters.variantType,
    filters.purpose,
    filters.weather,
  ].some((value) => value !== null && value !== undefined && value !== '');
}

function preferenceSignalCount(filters = {}) {
  const signals = [
    filters.gender,
    filters.minPrice || filters.maxPrice ? 'price' : null,
    filters.brand,
    filters.scent || filters.scentGroup ? 'scent' : null,
    filters.search,
    filters.volumeMl || filters.variantType ? 'variant' : null,
    filters.purpose,
    filters.weather,
  ];
  return signals.filter((value) => value !== null && value !== undefined && value !== '').length;
}

function hasProductReference(chatIntent, contextProductId = null) {
  return Boolean(
    contextProductId
    || chatIntent?.productName
    || chatIntent?.filters?.search
    || chatIntent?.filters?.brand
    || (Array.isArray(chatIntent?.compareProducts) && chatIntent.compareProducts.length > 0),
  );
}

const PURPOSE_PROFILES = {
  work_school: {
    label: 'đi học/đi làm',
    groups: ['fresh', 'citrus', 'musk', 'floral'],
    keywords: ['fresh', 'clean', 'sach', 'citrus', 'bergamot', 'musk', 'lavender', 'oai huong', 'nhẹ', 'nhe'],
  },
  casual: {
    label: 'đi chơi',
    groups: ['fresh', 'citrus', 'floral', 'sweet'],
    keywords: ['fresh', 'citrus', 'fruity', 'fruit', 'hoa', 'ngot', 'vanilla', 'daily'],
  },
  party: {
    label: 'đi tiệc',
    groups: ['amber', 'woody', 'spicy', 'leather', 'sweet'],
    keywords: ['amber', 'oud', 'wood', 'woody', 'spicy', 'leather', 'vanilla', 'tobacco', 'tram huong'],
  },
  date: {
    label: 'đi date',
    groups: ['sweet', 'amber', 'floral', 'musk', 'woody'],
    keywords: ['vanilla', 'amber', 'musk', 'rose', 'jasmine', 'ngot', 'quyen ru', 'ấm', 'am'],
  },
  gift: {
    label: 'tặng quà',
    groups: ['fresh', 'floral', 'citrus', 'musk', 'woody'],
    keywords: ['fresh', 'floral', 'citrus', 'musk', 'clean', 'versatile', 'de dung', 'dễ dùng'],
  },
};

const WEATHER_PROFILES = {
  hot: {
    label: 'thời tiết nóng/mùa hè',
    groups: ['fresh', 'citrus', 'aquatic', 'musk'],
    keywords: ['fresh', 'citrus', 'aquatic', 'marine', 'bergamot', 'lemon', 'cam', 'chanh', 'mint', 'green'],
  },
  cold: {
    label: 'thời tiết lạnh/mùa đông',
    groups: ['amber', 'woody', 'spicy', 'sweet', 'leather'],
    keywords: ['amber', 'vanilla', 'oud', 'woody', 'wood', 'spicy', 'leather', 'tobacco', 'warm', 'tonka'],
  },
};

function productText(product) {
  return normalizeVietnameseText([
    product.name,
    product.brand?.name || product.brand,
    product.category?.name || product.category,
    product.scentGroup,
    product.scentNotes,
    product.topNotes,
    product.middleNotes,
    product.baseNotes,
    product.description,
  ].filter(Boolean).join(' '));
}

function scoreByProfile(text, profile) {
  if (!profile) return 0;
  let score = 0;
  for (const group of profile.groups || []) {
    if (text.includes(normalizeVietnameseText(group))) score += 4;
  }
  for (const keyword of profile.keywords || []) {
    if (text.includes(normalizeVietnameseText(keyword))) score += 2;
  }
  return score;
}

function lifestyleScore(product, filters = {}) {
  const text = productText(product);
  return scoreByProfile(text, PURPOSE_PROFILES[filters.purpose])
    + scoreByProfile(text, WEATHER_PROFILES[filters.weather]);
}

function refineLifestyleProducts(products, filters = {}) {
  if (!filters.purpose && !filters.weather) return products;

  const scored = products.map((product) => ({
    product,
    score: lifestyleScore(product, filters),
  }));
  const matched = scored.filter((item) => item.score > 0);
  const usable = matched.length >= Math.min(3, products.length) ? matched : scored;
  return usable
    .sort((left, right) => right.score - left.score)
    .map((item) => item.product);
}

function productHasDecant(product) {
  const category = normalizeVietnameseText(product.category?.name || product.category);
  return Boolean(
    product.isDecant
    || product.hasDecantOptions
    || category.includes('decant')
    || (Array.isArray(product.decantOptions) && product.decantOptions.length > 0)
    || (Array.isArray(product.variants) && product.variants.some((variant) => normalizeVietnameseText(variant.type).includes('decant'))),
  );
}

function shouldOnlyShowInStock(chatIntent) {
  return ['recommend_product', 'price_question', 'stock_question', 'decant_question'].includes(chatIntent?.intent)
    || chatIntent?.filters?.inStockOnly;
}

function isSingleProductQuestion(chatIntent, contextProductId = null) {
  return ['product_detail', 'price_question', 'stock_question'].includes(chatIntent?.intent)
    && hasProductReference(chatIntent, contextProductId)
    && !(chatIntent?.filters?.minPrice || chatIntent?.filters?.maxPrice);
}

async function enrichIntentWithDatabase(chatIntent, question) {
  if (chatIntent.filters.brand) return chatIntent;

  const brands = await getBrands();
  const normalizedQuestion = normalizeVietnameseText(question);
  const matchedBrand = brands
    .filter((brand) => brand.status !== false && brand.name)
    .sort((left, right) => String(right.name).length - String(left.name).length)
    .find((brand) => includesNormalizedPhrase(normalizedQuestion, normalizeVietnameseText(brand.name)));

  if (!matchedBrand) return chatIntent;

  const normalizedSearch = normalizeVietnameseText(chatIntent.filters.search);
  const normalizedBrand = normalizeVietnameseText(matchedBrand.name);
  const searchLooksLikeBrand = normalizedSearch
    && (normalizedSearch.includes(normalizedBrand) || normalizedBrand.includes(normalizedSearch));

  return {
    ...chatIntent,
    filters: {
      ...chatIntent.filters,
      brand: matchedBrand.name,
      search: searchLooksLikeBrand ? null : chatIntent.filters.search,
    },
    matchedBrand: matchedBrand.name,
  };
}

function includesNormalizedPhrase(text, phrase) {
  if (!phrase) return false;
  return new RegExp(`(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`).test(text);
}

function buildNeedMoreInfo(chatIntent, contextProductId = null) {
  const filters = chatIntent.filters || {};

  if (chatIntent.intent === 'unknown') {
    return {
      answer: 'Mình cần thêm một chút thông tin để tư vấn đúng hơn. Bạn muốn tìm nước hoa cho ai, ngân sách khoảng bao nhiêu và dùng dịp nào?',
      suggestedQuestions: ['Tư vấn cho nam dưới 1 triệu', 'Mùi đi học/đi làm', 'Decant là gì?'],
    };
  }

  if (chatIntent.intent === 'order_tracking' && !chatIntent.orderCode) {
    return {
      answer: 'Bạn gửi giúp mình mã đơn hàng hoặc đăng nhập để xem lịch sử đơn nhé.',
      suggestedQuestions: ['Xem đơn hàng của tôi', 'Chính sách giao hàng'],
      actions: [{ type: 'open_order_history', label: 'Xem lịch sử đơn hàng', url: '/orders' }],
    };
  }

  if (chatIntent.intent === 'compare_product' && (!Array.isArray(chatIntent.compareProducts) || chatIntent.compareProducts.length < 2)) {
    return {
      answer: 'Bạn muốn so sánh hai chai nào? Gửi giúp mình tên 2 sản phẩm nhé.',
      suggestedQuestions: ['So sánh Dior Sauvage và Bleu de Chanel', 'Tư vấn cho nam'],
    };
  }

  if (chatIntent.intent === 'recommend_product' && preferenceSignalCount(filters) < 2) {
    return {
      answer: 'Mình cần thêm 1-2 tiêu chí để gợi ý chuẩn hơn: ngân sách khoảng bao nhiêu và bạn dùng dịp nào?',
      suggestedQuestions: ['Tư vấn cho nam dưới 1 triệu', 'Mùi đi date dưới 2 triệu', 'Nữ đi học/đi làm'],
    };
  }

  if (chatIntent.intent === 'price_question' && !hasProductReference(chatIntent, contextProductId) && !filters.minPrice && !filters.maxPrice) {
    return {
      answer: 'Bạn muốn hỏi giá chai nào, hay đang tìm nước hoa trong khoảng ngân sách bao nhiêu?',
      suggestedQuestions: ['Nước hoa dưới 1 triệu', 'Tư vấn theo ngân sách 1-2 triệu'],
    };
  }

  if (chatIntent.intent === 'stock_question' && !hasProductReference(chatIntent, contextProductId) && !hasMeaningfulPreference(filters)) {
    return {
      answer: 'Bạn muốn kiểm tra tồn kho sản phẩm nào, hay muốn mình lọc các chai còn hàng theo giới tính/ngân sách?',
      suggestedQuestions: ['Tư vấn cho nam còn hàng', 'Nước hoa nữ dưới 1 triệu'],
    };
  }

  if (chatIntent.intent === 'product_detail' && !hasProductReference(chatIntent, contextProductId)) {
    return {
      answer: 'Bạn muốn xem chi tiết sản phẩm nào? Gửi giúp mình tên chai hoặc thương hiệu nhé.',
      suggestedQuestions: ['Chi tiết Dior Sauvage', 'Giá của Chanel No.5'],
    };
  }

  return null;
}

async function hydrateAndSummarize(products, filters = {}, limit = 5) {
  const details = await Promise.all(
    products.slice(0, limit).map((product) => getProductById(Number(product.id))),
  );
  return details.filter(Boolean).map((product) => summarizeProduct(product, filters));
}

function postProcessProducts(products, chatIntent, question) {
  let result = [...products];
  if (chatIntent.intent === 'decant_question' && !chatIntent.isDefinitionQuestion) {
    const decantProducts = result.filter(productHasDecant);
    if (decantProducts.length) result = decantProducts;
  }
  if (shouldOnlyShowInStock(chatIntent) && !isSingleProductQuestion(chatIntent)) {
    result = result.filter((product) => Boolean(product.isInStock ?? product.stock > 0));
  }
  result = refineLifestyleProducts(result, chatIntent.filters);
  result.sort((left, right) => {
    const lifestyleDelta = lifestyleScore(right, chatIntent.filters) - lifestyleScore(left, chatIntent.filters);
    return lifestyleDelta || scoreProduct(question, right) - scoreProduct(question, left);
  });
  return result;
}

async function buildCompareCandidates(question, chatIntent) {
  const terms = Array.isArray(chatIntent.compareProducts) ? chatIntent.compareProducts.slice(0, 3) : [];
  const found = [];
  const seenIds = new Set();

  for (const term of terms) {
    const matches = await searchProducts(term, 8);
    const bestMatch = matches.find((product) => !seenIds.has(Number(product.id)));
    if (bestMatch) {
      seenIds.add(Number(bestMatch.id));
      found.push(bestMatch);
    }
  }

  if (found.length < 2) {
    const fallbackMatches = await searchProducts(question, 10);
    for (const product of fallbackMatches) {
      if (seenIds.has(Number(product.id))) continue;
      seenIds.add(Number(product.id));
      found.push(product);
      if (found.length >= 2) break;
    }
  }

  return hydrateAndSummarize(found, chatIntent.filters, 3);
}

async function buildProductCandidates(question, contextProductId = null) {
  const q = cleanText(question);
  let chatIntent = parseChatIntent(q);
  const canSkipDatabaseIntent = ['policy_question', 'order_tracking', 'unknown'].includes(chatIntent.intent)
    || (chatIntent.intent === 'decant_question' && chatIntent.isDefinitionQuestion);
  if (!canSkipDatabaseIntent) {
    chatIntent = await enrichIntentWithDatabase(chatIntent, q);
  }
  const moreInfo = buildNeedMoreInfo(chatIntent, contextProductId);
  if (moreInfo) return { chatIntent, products: [], moreInfo };

  if (['policy_question', 'order_tracking'].includes(chatIntent.intent)) {
    return { chatIntent, products: [] };
  }

  if (chatIntent.intent === 'decant_question' && chatIntent.isDefinitionQuestion) {
    return { chatIntent, products: [] };
  }

  if (chatIntent.intent === 'compare_product') {
    const products = await buildCompareCandidates(q, chatIntent);
    return {
      chatIntent,
      products,
      moreInfo: products.length < 2
        ? {
          answer: 'Mình chưa tìm đủ 2 sản phẩm trong database để so sánh. Bạn gửi lại tên 2 chai cụ thể hơn nhé.',
          suggestedQuestions: ['So sánh Dior Sauvage và Bleu de Chanel', 'Tư vấn mùi đi date'],
        }
        : null,
    };
  }

  if (isSingleProductQuestion(chatIntent, contextProductId) && contextProductId && !chatIntent.productName && !chatIntent.filters.brand) {
    const contextualProduct = await getProductById(Number(contextProductId));
    return {
      chatIntent,
      products: contextualProduct ? [summarizeProduct(contextualProduct)] : [],
    };
  }

  const filters = compactFilters({
    ...chatIntent.filters,
    variantType: chatIntent.intent === 'decant_question'
      ? (chatIntent.filters.variantType || 'decant')
      : chatIntent.filters.variantType,
  });

  let products = [];
  if (isSingleProductQuestion(chatIntent, contextProductId) && chatIntent.filters.brand && !chatIntent.productName && !chatIntent.filters.search) {
    const brandQuery = chatIntent.filters.brand;
    const brandMatches = await searchProducts(brandQuery, 20);
    const normalizedBrand = normalizeVietnameseText(brandQuery);
    const namedBrandMatches = brandMatches.filter((product) => (
      normalizeVietnameseText(product.name).includes(normalizedBrand)
    ));
    products = namedBrandMatches.length ? namedBrandMatches : brandMatches;
  } else if (Object.keys(filters).length > 0 || ['recommend_product', 'price_question', 'stock_question', 'decant_question'].includes(chatIntent.intent)) {
    const pool = await getProductsPaged({ page: 1, size: 50, sort: 'best_seller', filters });
    products = pool.content || [];
  } else if (q) {
    products = await searchProducts(q, 20);
  }

  if (!products.length && filters.scent && filters.scentGroup) {
    const relaxedScentFilters = { ...filters };
    delete relaxedScentFilters.scent;
    const relaxedPool = await getProductsPaged({ page: 1, size: 50, sort: 'best_seller', filters: relaxedScentFilters });
    products = relaxedPool.content || [];
  }

  if (!products.length && (chatIntent.productName || chatIntent.filters.search)) {
    const detailKeyword = [chatIntent.filters.brand, chatIntent.productName || chatIntent.filters.search].filter(Boolean).join(' ');
    products = await searchProducts(detailKeyword, 20);
  }

  products = postProcessProducts(products, chatIntent, q);
  const limit = chatIntent.intent === 'product_detail' ? 3 : 5;
  return {
    chatIntent,
    products: await hydrateAndSummarize(products, chatIntent.filters, limit),
  };
}

function buildPolicyAnswer(question) {
  const normalized = normalizeVietnameseText(question);
  if (/\b(giao hang|van chuyen|ship)\b/.test(normalized)) {
    return 'HuyPerfume hỗ trợ giao hàng toàn quốc. Thời gian giao cụ thể phụ thuộc khu vực và sẽ được xác nhận khi đặt hàng.';
  }
  if (/\b(doi tra|hoan tien|bao hanh)\b/.test(normalized)) {
    return 'Sản phẩm được hỗ trợ đổi trả khi lỗi do shop hoặc giao sai sản phẩm. Bạn vui lòng giữ nguyên tem, hộp và hóa đơn.';
  }
  if (/\b(chinh hang|authentic)\b/.test(normalized)) {
    return 'HuyPerfume cam kết cung cấp sản phẩm chính hãng với thông tin sản phẩm rõ ràng.';
  }
  if (/\b(thanh toan|momo|zalopay|cod)\b/.test(normalized)) {
    return 'Shop hỗ trợ các phương thức thanh toán đang bật trên hệ thống. Bạn có thể kiểm tra lại ở bước thanh toán trước khi xác nhận đơn.';
  }
  return 'Bạn có thể liên hệ HuyPerfume qua hotline hoặc email hỗ trợ để được giải đáp nhanh nhất.';
}

function buildOrderTrackingAnswer(chatIntent) {
  if (chatIntent.orderCode) {
    return `Mình đã nhận mã đơn ${chatIntent.orderCode}. Tính năng tra cứu trực tiếp đang được chuẩn bị; hiện bạn có thể mở lịch sử đơn hàng để kiểm tra trạng thái mới nhất.`;
  }
  return 'Bạn gửi giúp mình mã đơn hàng hoặc mở lịch sử đơn hàng để kiểm tra trạng thái. Mình đã chuẩn bị luồng này để mở rộng tra cứu tự động sau.';
}

function buildFallbackAnswer(question, products, chatIntent = null) {
  if (chatIntent?.intent === 'policy_question') {
    return {
      answer: buildPolicyAnswer(question),
      products: [],
    };
  }

  if (chatIntent?.intent === 'order_tracking') {
    return {
      answer: buildOrderTrackingAnswer(chatIntent),
      products: [],
    };
  }

  if (chatIntent?.intent === 'decant_question') {
    return {
      answer: buildDecantAnswer(products, chatIntent),
      products,
    };
  }

  if (!products.length) {
    return {
      answer: 'Hiện tại shop chưa có sản phẩm còn hàng phù hợp với yêu cầu này. Bạn có thể nới ngân sách, đổi nhóm hương hoặc chọn dịp sử dụng khác để mình lọc lại.',
      products: [],
    };
  }

  if (chatIntent?.intent === 'compare_product') {
    return {
      answer: buildCompareAnswer(products),
      products,
    };
  }

  if (chatIntent?.intent === 'product_detail') {
    return {
      answer: buildProductDetailResponse(question, products),
      products,
    };
  }

  if (chatIntent?.intent === 'price_question') {
    return {
      answer: buildPriceAnswer(products, chatIntent),
      products,
    };
  }

  if (chatIntent?.intent === 'stock_question') {
    return {
      answer: buildStockAnswer(products, chatIntent),
      products,
    };
  }

  return {
    answer: buildDatabaseAnswer(products, chatIntent),
    products,
  };
}

function formatPrice(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return 'liên hệ';
  return `${new Intl.NumberFormat('vi-VN').format(number)}đ`;
}

function formatGender(value) {
  const normalized = cleanText(value).toUpperCase();
  if (normalized === 'MEN') return 'nam';
  if (normalized === 'WOMEN') return 'nữ';
  if (normalized === 'UNISEX') return 'unisex';
  return cleanText(value);
}

function formatProductPrice(product) {
  const original = Number(product.originalPrice || product.price || 0);
  const effective = Number(product.effectivePrice || product.discountPrice || product.price || 0);
  if (original > effective && effective > 0) {
    return `${formatPrice(effective)} (giá gốc ${formatPrice(original)})`;
  }
  return formatPrice(effective || original);
}

function buildProductDetailAnswer(question, product) {
  const normalized = normalizeVietnameseText(question);
  const name = cleanText(product.name);
  const notes = cleanText(product.scentNotes || product.scentGroup).replace(/\s*\|\s*/g, ' / ');
  const hasSeparatedNotes = Boolean(product.topNotes || product.middleNotes || product.baseNotes);
  const answers = [];
  const asksScent = /\b(huong|mui|note)\b/.test(normalized);
  const asksGender = /\b(phu hop|nam hay nu|gioi tinh)\b/.test(normalized);
  const asksStock = /\b(con hang|het hang|ton kho)\b/.test(normalized);
  const asksVolume = /\b(bao nhieu ml|dung tich|ml)\b/.test(normalized);

  if (asksScent) {
    if (hasSeparatedNotes) {
      const layers = [
        product.topNotes ? `Hương đầu: ${product.topNotes}` : '',
        product.middleNotes ? `Hương giữa: ${product.middleNotes}` : '',
        product.baseNotes ? `Hương cuối: ${product.baseNotes}` : '',
      ].filter(Boolean);
      answers.push(`${name}: ${layers.join('; ')}.`);
    } else if (notes) {
      answers.push(`${name}. Dữ liệu shop đang có note hương tổng quát: ${notes}.`);
    } else {
      answers.push(`Hiện shop chưa có dữ liệu note hương cho ${name}.`);
    }
  }

  if (asksGender) {
    answers.push(product.gender
      ? `${name} được phân loại phù hợp cho ${formatGender(product.gender)}.`
      : `Hiện shop chưa có dữ liệu giới tính phù hợp cho ${name}.`);
  }

  if (asksStock) {
    answers.push(product.isInStock
      ? `${name} hiện còn hàng, tồn kho khả dụng là ${product.stock} sản phẩm.`
      : `${name} hiện đã hết hàng.`);
  }

  if (asksVolume) {
    const volumeList = Array.isArray(product.variants)
      ? [...new Set(product.variants.map((variant) => variant.volumeMl).filter(Boolean))]
      : [];
    if (volumeList.length) {
      answers.push(`${name} hiện có các dung tích: ${volumeList.map((value) => `${value}ml`).join(', ')}.`);
    } else if (product.volumeMl) {
      answers.push(`${name} có dung tích ${product.volumeMl}ml.`);
    } else {
      answers.push(`Hiện shop chưa có dữ liệu dung tích cho ${name}.`);
    }
  }

  if (answers.length) return answers.join(' ');

  const detailParts = [
    product.brand ? `thương hiệu ${product.brand}` : '',
    product.gender ? `phù hợp cho ${formatGender(product.gender)}` : '',
    product.volumeMl ? `dung tích ${product.volumeMl}ml` : '',
    `giá ${formatProductPrice(product)}`,
    product.isInStock ? `còn hàng (${product.stock})` : 'hết hàng',
  ].filter(Boolean);
  return detailParts.length
    ? `${name}: ${detailParts.join(', ')}.`
    : `Shop đã tìm thấy ${name}; bạn có thể xem card sản phẩm để mở trang chi tiết.`;
}

function describeFilters(filters = {}) {
  const parts = [];
  if (filters.gender) parts.push(`cho ${formatGender(filters.gender)}`);
  if (filters.brand) parts.push(`thương hiệu ${filters.brand}`);
  if (filters.scent || filters.scentGroup) parts.push(`nhóm hương ${filters.scent || filters.scentGroup}`);
  if (filters.purpose && PURPOSE_PROFILES[filters.purpose]) parts.push(PURPOSE_PROFILES[filters.purpose].label);
  if (filters.weather && WEATHER_PROFILES[filters.weather]) parts.push(WEATHER_PROFILES[filters.weather].label);
  return parts;
}

function buildDatabaseAnswer(products, chatIntent) {
  const { minPrice, maxPrice } = chatIntent?.filters || {};
  const criteria = describeFilters(chatIntent?.filters).join(', ');
  const suffix = criteria ? ` (${criteria})` : '';
  if (minPrice && maxPrice) {
    return `Shop tìm thấy các sản phẩm còn hàng trong khoảng ${formatPrice(minPrice)} - ${formatPrice(maxPrice)}${suffix}:`;
  }
  if (maxPrice) {
    return `Shop tìm thấy các sản phẩm còn hàng dưới ${formatPrice(maxPrice)}${suffix}:`;
  }
  if (minPrice) {
    return `Shop tìm thấy các sản phẩm còn hàng từ ${formatPrice(minPrice)}${suffix}:`;
  }
  if (chatIntent?.productName) {
    return `Shop tìm thấy thông tin sản phẩm phù hợp với "${chatIntent.productName}":`;
  }
  return `Shop tìm thấy ${products.length} sản phẩm còn hàng phù hợp${suffix}:`;
}

function buildProductDetailResponse(question, products) {
  if (products.length > 1) {
    return 'Mình tìm thấy vài sản phẩm gần giống trong database, bạn chọn chai muốn xem chi tiết nhé.';
  }
  return buildProductDetailAnswer(question, products[0]);
}

function buildPriceAnswer(products, chatIntent) {
  if (products.length === 1 && hasProductReference(chatIntent)) {
    return `${products[0].name} hiện có giá ${formatProductPrice(products[0])}.`;
  }
  return buildDatabaseAnswer(products, chatIntent);
}

function buildStockAnswer(products, chatIntent) {
  if (products.length === 1 && hasProductReference(chatIntent)) {
    return products[0].isInStock
      ? `${products[0].name} hiện còn hàng, tồn kho khả dụng là ${products[0].stock} sản phẩm.`
      : `${products[0].name} hiện đã hết hàng.`;
  }
  return `Mình lọc được ${products.length} sản phẩm đang còn hàng phù hợp với yêu cầu của bạn:`;
}

function buildCompareAnswer(products) {
  const lines = products.slice(0, 3).map((product) => {
    const notes = cleanText(product.scentNotes || product.scentGroup).replace(/\s*\|\s*/g, ' / ') || 'shop chưa có note hương chi tiết';
    const gender = product.gender ? `, hợp ${formatGender(product.gender)}` : '';
    const stock = product.isInStock ? `, còn ${product.stock}` : ', hết hàng';
    return `- ${product.name}: ${product.brand || 'chưa rõ thương hiệu'}${gender}, giá ${formatProductPrice(product)}${stock}, hương ${notes}.`;
  });
  return `Mình chỉ so sánh theo dữ liệu sản phẩm đang có trong database:\n${lines.join('\n')}`;
}

function buildDecantAnswer(products, chatIntent) {
  const requestedVolume = Number(chatIntent?.filters?.volumeMl || 0);
  const volumeText = requestedVolume > 0 ? ` Với lựa chọn ${requestedVolume}ml, hệ thống có quản lý ml thì khi mua sẽ trừ đúng ${requestedVolume}ml khỏi lượng ml khả dụng.` : '';
  const inventoryText = ' Nếu sản phẩm chưa có dữ liệu ml, chatbot chỉ tư vấn và không tự trừ kho.';
  const intro = `Decant là nước hoa chính hãng được chiết ra dung tích nhỏ để dùng thử hoặc mang theo. Decant phù hợp với người muốn test mùi trước khi mua full chai, đổi mùi thường xuyên, đi du lịch hoặc mua trong ngân sách thấp hơn.${volumeText}${inventoryText}`;
  if (!products.length) return intro;
  return `${intro}\nMình tìm thấy các sản phẩm có lựa chọn decant/chiết trong database:`;
}

function buildSuggestedQuestions(chatIntent, needMoreInfo = false) {
  if (needMoreInfo) return [];
  if (chatIntent?.intent === 'decant_question') return ['Decant 10ml còn những mùi nào?', 'Tư vấn decant đi date'];
  if (chatIntent?.intent === 'price_question') return ['Tư vấn cho nam dưới 1 triệu', 'Mùi đi học/đi làm'];
  if (chatIntent?.intent === 'order_tracking') return ['Chính sách giao hàng', 'Xem lịch sử đơn hàng'];
  return ['Tư vấn cho nam', 'Nước hoa dưới 1 triệu', 'Decant là gì?'];
}

function buildActions(products, chatIntent) {
  if (chatIntent?.intent === 'order_tracking') {
    return [{ type: 'open_order_history', label: 'Xem lịch sử đơn hàng', url: '/orders' }];
  }
  return (products || []).flatMap((product) => ([
    { type: 'view_product', label: 'Xem chi tiết', productId: product.id, url: product.detailUrl },
    { type: 'add_to_cart', label: 'Thêm vào giỏ', productId: product.id },
  ]));
}

function createChatPayload({
  answer,
  products = [],
  chatIntent,
  provider = 'database',
  needMoreInfo = false,
  suggestedQuestions = null,
  actions = null,
}) {
  return {
    answer,
    intent: chatIntent?.intent || 'unknown',
    needMoreInfo: Boolean(needMoreInfo),
    suggestedQuestions: Array.isArray(suggestedQuestions) ? suggestedQuestions.slice(0, 3) : buildSuggestedQuestions(chatIntent, needMoreInfo),
    products,
    actions: Array.isArray(actions) ? actions : buildActions(products, chatIntent),
    filters: chatIntent?.filters || {},
    provider,
  };
}
const CHATBOX_IN_SCOPE_TERMS = [
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

const CHATBOX_OUT_OF_SCOPE_GROUPS = [
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
      'hop dong',
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
      'lai suat',
      'mua vang',
    ],
  },
];

function includesChatPhrase(text, phrase) {
  return new RegExp(
    `(?:^|\\s)${phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:\\s|$)`,
  ).test(text);
}

function hasAnyChatTerm(text, terms) {
  return terms.some((term) => includesChatPhrase(text, term));
}

function detectOutOfScopeGroup(question) {
  const normalized = normalizeVietnameseText(question);
  return CHATBOX_OUT_OF_SCOPE_GROUPS.find((group) => hasAnyChatTerm(normalized, group.terms)) || null;
}

function hasPerfumeStoreContext(question) {
  const normalized = normalizeVietnameseText(question);
  return hasAnyChatTerm(normalized, CHATBOX_IN_SCOPE_TERMS);
}

function buildOutOfScopePayload(group) {
  return {
    answer: `Xin lỗi, HuyPerfume chỉ hỗ trợ tư vấn nước hoa, sản phẩm, decant, đơn hàng và chính sách mua hàng. Nội dung bạn hỏi thuộc nhóm ${group.label}, nên mình không tự ý tư vấn chuyên môn. Bạn nên liên hệ chuyên gia phù hợp để được hỗ trợ chính xác. Nếu cần chọn nước hoa theo phong cách, giới tính, ngân sách hoặc dịp sử dụng, mình sẵn sàng hỗ trợ.`,
    intent: 'out_of_scope',
    needMoreInfo: false,
    suggestedQuestions: [
      'Tư vấn nước hoa cho nam dưới 1 triệu',
      'Mùi đi học/đi làm nên chọn gì?',
      'Decant 10ml còn những mùi nào?',
    ],
    products: [],
    actions: [],
    filters: {},
    provider: 'scope_guard',
  };
}

function buildPerfumeSafetyPayload() {
  return {
    answer:
      'Mình không thể tư vấn y tế hoặc chẩn đoán triệu chứng. Nếu bạn bị đau đầu, dị ứng, khó thở hoặc khó chịu khi dùng nước hoa, bạn nên ngưng sử dụng và liên hệ bác sĩ/cơ sở y tế khi cần. Trong phạm vi HuyPerfume, mình có thể gợi ý các mùi nhẹ, sạch, ít nồng như citrus, fresh, aquatic hoặc musk nhẹ để bạn tham khảo.',
    intent: 'perfume_safety_limited',
    needMoreInfo: false,
    suggestedQuestions: [
      'Tư vấn mùi nhẹ đi học/đi làm',
      'Nước hoa fresh dưới 1 triệu',
      'Decant mùi sạch dễ dùng',
    ],
    products: [],
    actions: [],
    filters: {},
    provider: 'scope_guard',
  };
}

async function callDeepSeek(messages) {
  const apiKey = cleanText(process.env.DEEPSEEK_API_KEY);
  const baseUrl = cleanText(process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com');
  if (!apiKey) throw new Error('Thiếu khóa API DeepSeek');

  const response = await fetch(`${baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model: 'deepseek-chat',
      messages,
      temperature: 0.4,
    }),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Lỗi DeepSeek ${response.status}: ${text}`);
  }

  return response.json();
}

export async function productChat(req, res) {
  try {
    const question = cleanText(req.body?.q || req.body?.question);
    if (!question) return errorResponse(res, 400, 'Thiếu câu hỏi q');

    const outOfScopeGroup = detectOutOfScopeGroup(question);
    const hasStoreContext = hasPerfumeStoreContext(question);

    if (outOfScopeGroup && !hasStoreContext) {
      return successResponse(
        res,
        'Chatbot từ chối câu hỏi ngoài phạm vi',
        buildOutOfScopePayload(outOfScopeGroup),
      );
    }

    if (outOfScopeGroup?.key === 'medical') {
      return successResponse(
        res,
        'Chatbot giới hạn tư vấn an toàn',
        buildPerfumeSafetyPayload(),
      );
    }

    const contextProductId = Number(req.body?.productId || req.body?.contextProductId) || null;
    const { chatIntent, products, moreInfo } = await buildProductCandidates(question, contextProductId);
    if (moreInfo) {
      return successResponse(res, 'Chatbot cần thêm thông tin', createChatPayload({
        answer: moreInfo.answer,
        products: [],
        chatIntent,
        needMoreInfo: true,
        suggestedQuestions: moreInfo.suggestedQuestions,
        actions: moreInfo.actions || [],
      }));
    }

    const fallback = buildFallbackAnswer(question, products, chatIntent);
    const databasePayload = createChatPayload({
      answer: fallback.answer,
      products: fallback.products,
      chatIntent,
      provider: 'database',
    });

    if (
      !products.length
      || ['product_detail', 'price_question', 'stock_question', 'compare_product', 'decant_question', 'policy_question', 'order_tracking'].includes(chatIntent.intent)
    ) {
      return successResponse(res, 'Trả lời chatbot từ database thành công', databasePayload);
    }

    if (!cleanText(process.env.DEEPSEEK_API_KEY)) {
      return successResponse(
        res,
        'Tư vấn sản phẩm từ database thành công',
        databasePayload,
      );
    }

    const context = products.map((p) => ({
      id: p.id,
      name: p.name,
      price: p.price,
      effectivePrice: p.effectivePrice,
      originalPrice: p.originalPrice,
      stock: p.stock,
      category: p.category,
      brand: p.brand,
      scentNotes: p.scentNotes,
      description: p.description,
      image: p.image,
      isDecant: p.isDecant,
      status: p.status,
    }));

    const messages = [
      {
        role: 'system',
        content:
          'Bạn là tư vấn viên nước hoa ecommerce của HuyPerfume. Chỉ được dùng dữ liệu sản phẩm được cung cấp, không bịa sản phẩm và không thêm tên sản phẩm ngoài danh sách. Trả lời tiếng Việt ngắn gọn, thực tế, không xuất JSON.',
      },
      {
        role: 'user',
        content: JSON.stringify({ question, intent: chatIntent, products: context }),
      },
    ];

    try {
      const data = await callDeepSeek(messages);
      const answer = data?.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error('DeepSeek trả về câu trả lời trống');
      return successResponse(res, 'Tư vấn AI thành công', createChatPayload({
        answer,
        products,
        chatIntent,
        provider: 'deepseek',
      }));
    } catch (err) {
      console.error('[AI_PRODUCT_CHAT_FALLBACK]', err);
      return successResponse(
        res,
        'Tư vấn sản phẩm từ database thành công',
        databasePayload,
      );
    }
  } catch (error) {
    console.error('[AI_PRODUCT_CHAT_ERROR]', error);
    return errorResponse(res, 500, 'Lỗi chatbot sản phẩm: ' + error.message);
  }
}

export async function contentAI(req, res) {
  try {
    const topic = cleanText(req.body?.topic);
    const productIds = Array.isArray(req.body?.productIds) ? req.body.productIds : [];
    if (!topic) return errorResponse(res, 400, 'Thiếu topic');

    const products = [];
    for (const id of productIds.slice(0, 5)) {
      const product = await getProductById(Number(id));
      if (product) products.push(summarizeProduct(product));
    }

    const fallback = buildFallbackAnswer(topic, products);
    const messages = [
      {
        role: 'system',
        content:
          'Bạn là AI viết nội dung cho website nước hoa. Chỉ dùng dữ liệu được cung cấp. Không bịa thông tin về sản phẩm. Nếu thiếu dữ liệu, hãy nói ngắn gọn rằng chưa đủ thông tin.',
      },
      {
        role: 'user',
        content: JSON.stringify({ topic, products }),
      },
    ];

    try {
      const data = await callDeepSeek(messages);
      const answer = data?.choices?.[0]?.message?.content?.trim();
      if (!answer) throw new Error('DeepSeek trả về câu trả lời trống');
      return successResponse(res, 'Tạo nội dung AI thành công', {
        answer,
        products,
        provider: 'deepseek',
      });
    } catch (err) {
      console.error('[AI_CONTENT_FALLBACK]', err);
      return successResponse(res, 'Tạo nội dung AI thành công bằng fallback', {
        ...fallback,
        provider: 'fallback',
      });
    }
  } catch (error) {
    console.error('[AI_CONTENT_ERROR]', error);
    return errorResponse(res, 500, 'Lỗi AI content: ' + error.message);
  }
}
