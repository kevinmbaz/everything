import { createPrivateStorage } from '../../../../private_storage/client.mjs';
import { isPrivateStorage } from './storage-mode.js';
export { isPrivateStorage };
export const storage = isPrivateStorage ? createPrivateStorage({ app: 'time-tracking' }) : null;
