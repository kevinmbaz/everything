/** Explicit build-time selection; a cloud outage never selects private data. */
export const isPrivateStorage = import.meta.env?.VITE_PRIVATE_STORAGE === '1';
