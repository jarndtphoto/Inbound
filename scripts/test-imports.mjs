import { registerHooks } from 'node:module';

// Match bundler resolution for extensionless relative TypeScript imports.
// Each test worker gets the same hook; it never changes application imports.
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier.startsWith('.') && !/\.(?:[cm]?[jt]sx?|json)$/.test(specifier)) {
      try { return nextResolve(specifier + '.ts', context); }
      catch (error) {
        if (error.code !== 'ERR_MODULE_NOT_FOUND') throw error;
      }
    }
    return nextResolve(specifier, context);
  },
});
