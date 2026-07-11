/**
 * Public entry point for the deterministic planner engine (`src/planner`).
 * Pure, framework-free modules (ARCHITECTURE §4/§6) that the `engagements` capability server
 * registers as MCP tools.
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
