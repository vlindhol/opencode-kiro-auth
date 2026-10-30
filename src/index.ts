/**
 * OpenCode Kiro Auth Plugin - Main Entry Point
 *
 * This plugin provides Kiro (CodeWhisperer) model access for OpenCode V2.
 */

// Re-export the plugin as default - OpenCode V2 expects this
export { default } from './plugin.js'

// Named exports for programmatic use
export { KiroOAuthPlugin, createKiroPlugin } from './plugin.js'

// Type exports
export type { KiroConfig } from './plugin/config/index.js'
export type { KiroAuthMethod, KiroRegion, ManagedAccount } from './plugin/types.js'
