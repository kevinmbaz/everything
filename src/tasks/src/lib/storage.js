import { createPrivateStorage } from '../../../../private_storage/client.mjs';

// Build-time opt-in only. Failed cloud auth never selects private mode.
export const isPrivateStorage = import.meta.env.VITE_PRIVATE_STORAGE === '1';
export const storage = isPrivateStorage ? createPrivateStorage({ app: 'tasks' }) : null;
