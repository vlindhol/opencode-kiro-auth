import { Model, Plugin, Provider } from '@opencode/plugin'
import { KIRO_CONSTANTS } from './constants.js'
import { AuthHandler } from './core/auth/auth-handler.js'
import { RequestHandler } from './core/request/request-handler.js'
import { AccountCache } from './infrastructure/database/account-cache.js'
import { AccountRepository } from './infrastructure/database/account-repository.js'
import { AccountManager } from './plugin/accounts.js'
import { loadConfig } from './plugin/config/index.js'
import { buildModelRegistry } from './plugin/model-registry.js'
import { formatWebSearchResults, kiroWebSearch } from './plugin/web-search.js'

const KIRO_PROVIDER_ID = 'kiro'
const KIRO_API_PATTERN = /^(https?:\/\/)?q\.[a-z0-9-]+\.amazonaws\.com/

// The description is adapted from Kiro's own web_search tool spec so the model
// gets the same guidance on when to search and how to attribute results.
const WEB_SEARCH_DESCRIPTION = `Search the web using Kiro's built-in search engine. Returns titles, URLs, snippets, domains, and publish dates for a query. Billed as Kiro credits.

## When to Use
- The user asks for current or up-to-date information (pricing, versions, release notes, recent events, library APIs).
- Verifying facts that may have changed recently, or details likely newer than the model's training data.
- Looking up specifics of a library, framework, or tool that can't be reliably inferred from the codebase or context.

## When NOT to Use
- Basic concepts, historical facts, or well-established programming syntax the model already knows.
- Anything answerable from the current repository, files, or conversation. Search the codebase first.

## Query Tips
- Keep queries focused; the query MUST be 200 characters or fewer (longer queries are rejected).
- Rephrase the user's request into effective keywords. Run multiple focused searches for complex questions rather than one broad query.
- The snippets often contain enough to answer directly; only fetch a full page (via a separate fetch tool) when you need more detail.

## Using Results & Attribution
- Prioritize the most recently published, authoritative sources (prefer official docs over blogs; use the domain to judge authority).
- ALWAYS cite sources with inline links in the format [description](url).
- Paraphrase and summarize; do not reproduce more than ~30 consecutive words verbatim from any single source. Preserve factual accuracy while condensing.`

type ToastFunction = (message: string, variant: 'info' | 'warning' | 'success' | 'error') => void

/**
 * Create a V2 plugin definition for Kiro authentication and model access.
 *
 * V2 Migration notes:
 * - Plugin.define replaces the V1 factory function
 * - ctx.location.directory replaces the directory parameter
 * - ctx.provider.transform replaces the config hook for provider/model registration
 * - ctx.tool.transform replaces the tool map
 * - ctx.session.hook('http.request') intercepts requests to Kiro's API
 * - Uses @opencode/ai/providers/openai-compatible as the runtime package
 */
export function createKiroPlugin(id: string) {
  return Plugin.define({
    id,
    async setup(ctx) {
      const config = loadConfig(ctx.location.directory)

      const cache = new AccountCache(60000)
      const repository = new AccountRepository(cache)

      const authHandler = new AuthHandler(config, repository)
      const accountManager = await AccountManager.loadFromDisk(config.account_selection_strategy)
      authHandler.setAccountManager(accountManager)

      // RequestHandler needs access to ctx for re-authentication flows
      const requestHandler = new RequestHandler(accountManager, config, repository, ctx)

      // Compute the base URL once so both provider and request handling use the same value
      const baseURL = KIRO_CONSTANTS.BASE_URL.replace('/generateAssistantResponse', '').replace(
        '{{region}}',
        config.default_region || 'us-east-1'
      )

      // Build model definitions from our registry
      const modelSpecs = buildModelRegistry()
      const providerID = Provider.ID.make(id)
      const models: Model.Info[] = Object.entries(modelSpecs).map(([modelID, spec]) => {
        const modelSpec = spec as {
          name: string
          limit: { context: number; output: number }
          modalities: { input: string[]; output: string[] }
          reasoning?: boolean
          interleaved?: { field: string }
          variants?: Record<string, unknown>
        }

        const baseModel = Model.Info.default(providerID, Model.ID.make(modelID))

        // Build V2-compatible model info
        const modelInfo: Model.Info = {
          ...baseModel,
          name: modelSpec.name,
          limit: {
            context: modelSpec.limit.context,
            output: modelSpec.limit.output
          },
          capabilities: {
            ...baseModel.capabilities,
            tools: true,
            input: modelSpec.modalities.input as ('text' | 'image' | 'pdf')[],
            output: modelSpec.modalities.output as ('text' | 'image')[]
          }
        }

        // Add reasoning capability if supported
        if (modelSpec.reasoning) {
          ;(modelInfo as any).reasoning = true
        }
        if (modelSpec.interleaved) {
          ;(modelInfo as any).interleaved = modelSpec.interleaved
        }

        // Convert variants to V2 format (array of objects with id)
        if (modelSpec.variants && Object.keys(modelSpec.variants).length > 0) {
          const variantArray = Object.entries(modelSpec.variants).map(([variantId, settings]) => ({
            id: Model.VariantID.make(variantId),
            settings: settings as Record<string, unknown>
          }))
          ;(modelInfo as any).variants = variantArray
        }

        return modelInfo
      })

      // Register the Kiro provider with its models
      // Using OpenAI-compatible package - we intercept HTTP requests to handle the actual API calls
      await ctx.provider.transform((editor) => {
        editor.add({
          info: {
            ...Provider.Info.empty(providerID),
            name: 'Kiro',
            activation: 'enabled',
            package: '@opencode/ai/providers/openai-compatible',
            settings: { baseURL }
          },
          models
        })
      })

      // Toast function for user notifications - in V2 we log to console
      // TODO: When V2 provides a notification API, use that instead
      const showToast: ToastFunction = (message, variant) => {
        console.log(`[Kiro ${variant}] ${message}`)
      }

      // Initialize auth handler (refreshes tokens, syncs from Kiro CLI if configured)
      await authHandler.initialize(showToast)

      // ========================================================================
      // HTTP Response Interception - Core feature
      // ========================================================================
      // The http.response hook intercepts responses from Kiro's API and handles:
      // - Authentication (token refresh, account rotation)
      // - Request transformation to CodeWhisperer SDK format
      // - Response streaming with proper event translation
      // - Retries with backoff
      // - Error handling
      // - Usage tracking
      await ctx.session.hook(
        'http.response',
        async (event) => {
          const url = event.request.url

          // Only intercept Kiro API requests
          if (!KIRO_API_PATTERN.test(url)) return

          // Clone the request to read the body
          const clonedRequest = event.request.clone()
          const body = await clonedRequest.text()

          // Handle the request through our custom handler
          // This provides all the functionality: auth, retries, account rotation, etc.
          const headers: Record<string, string> = {}
          event.request.headers.forEach((value, key) => {
            headers[key] = value
          })

          const response = await requestHandler.handle(
            url,
            {
              method: event.request.method,
              headers,
              body
            },
            showToast
          )

          // Set the response to bypass the original
          event.response = response
        },
        { providerID: id }
      )

      // ========================================================================
      // Web Search Tool
      // ========================================================================
      // Register web search tool if enabled and account has Pro access
      if (config.web_search_enabled) {
        const account = accountManager.getCurrentOrNext()
        if (account?.profileArn) {
          await ctx.tool.transform((editor) => {
            editor.add({
              name: 'kiro_web_search',
              description: WEB_SEARCH_DESCRIPTION,
              input: {
                type: 'object',
                properties: {
                  query: {
                    type: 'string',
                    description: 'The search query. Must be 200 characters or fewer.'
                  }
                },
                required: ['query'],
                additionalProperties: false
              },
              async execute(input) {
                try {
                  const { query } = input as { query: string }
                  const results = await kiroWebSearch(accountManager, query)
                  return { content: formatWebSearchResults(results) }
                } catch (e) {
                  return {
                    content: `Web search failed: ${e instanceof Error ? e.message : String(e)}`
                  }
                }
              }
            })
          })
        }
      }

      // Return cleanup function
      return () => {
        // Cleanup resources if needed
      }
    }
  })
}

export const KiroOAuthPlugin = createKiroPlugin(KIRO_PROVIDER_ID)

// Default export for V2 plugin loading
export default KiroOAuthPlugin
