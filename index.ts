/**
 * OpenCode Kiro Auth Plugin
 *
 * Re-exports from src for development convenience.
 */

// Default export - the plugin definition
export { default } from './src/plugin'

// Named exports
export { authorizeKiroIDC } from './src/kiro/oauth-idc'
export { KiroOAuthPlugin, createKiroPlugin } from './src/plugin'

// Type exports
export type { KiroConfig } from './src/plugin/config'
export type {
  KiroAuthDetails,
  KiroAuthMethod,
  KiroRegion,
  ManagedAccount
} from './src/plugin/types'
