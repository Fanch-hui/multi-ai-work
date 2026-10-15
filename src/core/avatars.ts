import { z } from 'zod';

export const avatarSchema = z.string().max(260000).refine(value => ['cat', 'fox', 'panda', 'owl'].includes(value)
  || /^data:image\/(?:png|jpeg|webp);base64,[a-zA-Z0-9+/]+=*$/.test(value), '头像格式无效');
