export interface ProductVariant {
  id: number | string;
  variantId?: number | string;
  productId?: number;
  sku: string;
  barcode?: string;
  label?: string;
  name?: string;
  volume?: string;
  volumeMl?: number | null;
  type?: string;
  price: number;
  salePrice?: number | null;
  discountPrice?: number | null;
  originalPrice: number;
  discountPercent?: number;
  stockQuantity: number;
  stock: number;
  image: string;
  status: boolean;
  isAvailable: boolean;
}

export interface DecantOption {
  id: number;
  productId: number;
  volumeMl: number;
  price: number;
  status: boolean;
}

export interface ProductBatch {
  id: number;
  productId: number;
  batchCode: string;
  totalVolumeMl: number;
  remainingVolumeMl: number;
  importPrice: number | null;
  status: string;
  createdAt?: string | null;
}

export interface User {
  id: number;
  name: string;
  email: string;
  phone: string;
  role: string;
  address: string;
  dob: string | null;
  status?: string;
  totalSpent?: number;
  membershipTier?: string;
  membershipLabel?: string;
  nextTier?: string | null;
  nextTierLabel?: string | null;
  amountToNextTier?: number;
  membershipProgress?: number;
  membershipUpdatedAt?: string | null;
  emailVerifiedAt?: string | null;
  lastLoginAt?: string | null;
  createdAt?: string | null;
}

export interface Product {
  id: number;
  variantId?: number | string | null;
  sku: string;
  batchCode: string;
  name: string;
  price: number;
  salePrice?: number | null;
  effectivePrice?: number | null;
  discountPrice: number;
  originalPrice: number;
  discountPercent: number;
  image: string;
  images?: string[];
  description: string;
  scentNotes: string;
  scentGroup?: string;
  gender?: string;
  concentration?: string;
  isDecant: boolean;
  itemType?: 'FULL_BOTTLE' | 'DECANT' | string;
  selectedVolumeMl?: number | null;
  status: boolean;
  stockQuantity?: number;
  stock: number;
  hasVariants?: boolean;
  volumeMl: number;
  rating: number;
  reviewCount: number;
  soldCount: number;
  badgeLabel: string;
  isFavorite?: boolean;
  isInStock?: boolean;
  isPurchasable?: boolean;
  thumbnailImage?: string | null;
  selectedVariant?: ProductVariant | null;
  variants?: ProductVariant[];
  decantOptions?: DecantOption[];
  availableVolumeMl?: number;
  batches?: ProductBatch[];
  category: { id: number; name: string } | null;
  brand: { id: number; name: string } | null;
  decantInventory?: DecantInventory | null;
  bottleVolumeMl?: number;
}

export interface ProductReview {
  id: number;
  productId: number;
  userId: number;
  orderId?: number | null;
  rating: number;
  title: string;
  comment: string;
  status: string;
  verifiedPurchase?: boolean;
  isVerifiedPurchase?: boolean;
  user?: { id: number; name: string } | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface ProductReviewSummary {
  ratingAverage: number;
  reviewCount: number;
  soldCount?: number;
  ratingBreakdown: Record<1 | 2 | 3 | 4 | 5, number>;
}

export interface CartItem {
  product: Product;
  quantity: number;
  price: number;
  subtotal?: number;
}

export interface CartSummary {
  items: CartItem[];
  total: number;
  itemCount: number;
}

export interface OrderItemInfo {
  id: number;
  productId: number;
  variantId?: number | null;
  productName: string;
  productImage: string;
  quantity: number;
  price: number;
  selectedBatchCode: string;
  priceAtPurchase: number;
  itemType?: 'FULL_BOTTLE' | 'DECANT' | string;
  selectedVolumeMl?: number | null;
  sourceBatchId?: number | null;
}

export interface OrderStatusHistoryItem {
  id: number;
  oldStatus: string | null;
  newStatus: string;
  changedBy: number | null;
  changedByName: string;
  note: string;
  createdAt: string;
}

export interface OrderResponse {
  id: number;
  orderCode?: string;
  userId: number;
  userName: string;
  total: number;
  subtotal?: number;
  voucherId?: number | null;
  voucherCode?: string;
  voucherDiscountType?: string;
  voucherDiscountValue?: number | null;
  voucherDiscountAmount?: number;
  shippingAddress: string;
  phone: string;
  paymentMethod: string;
  paymentMethodLabel?: string;
  paymentStatus?: string;
  momoOrderId: string;
  momoTransId: string;
  zalopayAppTransId: string;
  failureReason?: string;
  status: string;
  createdAt: string;
  items: OrderItemInfo[];
  timeline?: OrderStatusHistoryItem[];
  paymentUrl?: string;
}

export interface PagedResponse<T> {
  content: T[];
  page: number;
  size: number;
  totalElements: number;
  totalPages: number;
  last: boolean;
  first: boolean;
}

export interface LoginRequest {
  emailPhone: string;
  password: string;
}

export interface RegisterRequest {
  name: string;
  email: string;
  phone: string;
  password: string;
  repassword: string;
  address: string;
}

export interface JwtResponse {
  token: string;
  accessToken?: string;
  refreshToken?: string;
  tokenType?: string;
  expiresIn?: number;
  refreshExpiresAt?: string;
  permissions?: string[];
  user: User;
  emailVerification?: {
    required: boolean;
    delivery?: string;
    token?: string;
    expiresAt: string;
  };
}

export interface DecantInventory {
  sealedBottles: number;
  openedMl: number;
  bottleVolumeMl: number;
}

export interface Category {
  id: number;
  name: string;
}

export interface Brand {
  id: number;
  name: string;
  status: boolean;
}
