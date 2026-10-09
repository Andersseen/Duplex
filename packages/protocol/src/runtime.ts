import { z } from 'zod';

/**
 * Zod compiles faster object parsers with `new Function`, probing for support at first use.
 * Browsers running under a Content-Security-Policy without `'unsafe-eval'` refuse the probe and
 * report a violation even though Zod falls back correctly. Duplex messages are small, so the
 * interpreter path is plenty: turn code generation off for every consumer of this package.
 *
 * This module must be the first import of `index.ts`: Zod reads the flag when each schema is
 * constructed, so it has to be set before any schema module is evaluated.
 */
z.config({ jitless: true });
