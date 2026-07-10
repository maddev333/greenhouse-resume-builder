/**
 * Public entry point for the deterministic planner engine (`api/src/planner`).
 * Pure, framework-free modules (ARCHITECTURE §4/§6); the `engagements` capability server registers
 * these as MCP tools, and an optional Express surface reuses the same functions with no duplication.
 */
export * from './types';
export * from './weights';
export * from './clock';
export * from './distance';
export * from './score';
export * from './suggest';
export * from './route';
export * from './conflicts';
export * from './roi';
export * from './seed-loader';
export { SEED_DIR } from './paths';
