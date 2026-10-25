import { createProvider as yes918 } from './yes918/index.js';

/**
 * Every provider exposes the same operation names. A provider implements the
 * ones its portal supports; the rest are rejected as 'unsupported_operation'.
 *
 * Operation contract:
 *   validate(params) -> error code | null     (strict: reject unknown fields)
 *   run({ session, params, ctx }) -> result   (throw OperationError otherwise)
 *
 * Mutating operations must call ctx.assertCanSubmit() immediately before the
 * request that changes the portal, and nothing may be retried after it.
 */
export const OPERATIONS = ['createPlayer', 'setScore', 'resetPassword', 'disablePlayer', 'gameLog', 'kickPlayer'];

const FACTORIES = {
  yes918,
};

export function loadProviders(keys) {
  return keys.map((key) => {
    const factory = FACTORIES[key];
    if (!factory) {
      throw new Error(`Unknown provider "${key}" in PROVIDERS`);
    }
    const provider = factory();
    for (const name of Object.keys(provider.operations)) {
      if (!OPERATIONS.includes(name)) {
        throw new Error(`Provider ${key} implements unknown operation ${name}`);
      }
    }
    return provider;
  });
}
