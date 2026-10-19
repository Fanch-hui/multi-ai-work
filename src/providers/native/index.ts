import type { ProviderAdapter } from '../../domain/provider.js';
import { AntigravityAdapter } from './antigravity.js';
import { QoderAdapter } from './qoder.js';
export { AntigravityAdapter, QoderAdapter };
export const createNativeAdapters = (): ProviderAdapter[] => [
  new AntigravityAdapter(),
  new QoderAdapter(),
];
