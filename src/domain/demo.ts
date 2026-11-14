// Demo/seed data is for automated tests only. The real application starts from an empty database and
// never generates sample business records. Tests that need the demo business opt in at BUILD time with
// VITE_DEMO_SEED=1 (see playwright.config.ts); unit tests and scripts call buildSeed() directly.
export const DEMO_SEED: boolean = (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.VITE_DEMO_SEED === '1';
