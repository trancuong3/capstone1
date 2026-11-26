import { z } from "zod";

// Disable Zod v4's `Function("")` JIT capability probe so strict production CSP
// (without `'unsafe-eval'`) emits zero `securitypolicyviolation` events.
z.config({ jitless: true });

export { z };
