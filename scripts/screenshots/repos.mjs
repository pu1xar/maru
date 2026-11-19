// Small fictional repositories that the screenshot sessions work in. They exist on disk so the
// file explorer and the file preview have something to show. Everything here is made up.

export const CART_BEFORE = `import type { CartItem } from "./types";

export function lineTotal(item: CartItem): number {
  return item.price * item.quantity;
}

export function cartTotal(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + lineTotal(item), 0);
}

export function formatTotal(items: CartItem[]): string {
  return \`$\${cartTotal(items)}\`;
}
`;

export const CART_AFTER = `import type { CartItem } from "./types";
import { formatCents, toCents } from "./money";

export function lineTotalCents(item: CartItem): number {
  return toCents(item.price) * item.quantity;
}

export function cartTotalCents(items: CartItem[]): number {
  return items.reduce((sum, item) => sum + lineTotalCents(item), 0);
}

export function formatTotal(items: CartItem[]): string {
  return formatCents(cartTotalCents(items));
}
`;

export const MONEY = `/** Prices arrive as decimal dollars from the catalog API. */
export function toCents(dollars: number): number {
  return Math.round(dollars * 100);
}

export function formatCents(cents: number, currency = "USD"): string {
  return new Intl.NumberFormat("en-US", { style: "currency", currency }).format(cents / 100);
}
`;

export const CART_TEST = `import { describe, expect, it } from "vitest";
import { cartTotalCents, formatTotal } from "../src/lib/cart";

const item = (price: number, quantity: number) => ({ id: String(price), name: "Item", price, quantity });

describe("cart totals", () => {
  it("adds prices in whole cents", () => {
    expect(cartTotalCents([item(0.1, 1), item(0.2, 1)])).toBe(30);
  });

  it("formats the total as currency", () => {
    expect(formatTotal([item(19.99, 3), item(4.5, 2)])).toBe("$68.97");
  });

  it("returns $0.00 for an empty cart", () => {
    expect(formatTotal([])).toBe("$0.00");
  });
});
`;

export const ARCHITECTURE_MD = `# Checkout architecture

The storefront talks to two services. Prices are kept in integer cents from the API edge to
the receipt, and only formatted for display.

\`\`\`mermaid
flowchart LR
  UI[Storefront UI] -->|cart| API[acme-api]
  API -->|prices| Catalog[(Catalog DB)]
  API -->|charge| Payments[Payments provider]
  Payments -->|webhook| API
  API -->|receipt| UI
\`\`\`

## Rules

- Money is an integer number of cents (\`toCents\`, \`formatCents\` in \`src/lib/money.ts\`)
- The cart never stores a formatted string
- Every route under \`/api/checkout\` needs a session
`;

export const ACME_WEB = {
  "package.json": JSON.stringify({
    name: "acme-web",
    private: true,
    type: "module",
    scripts: { dev: "vite", build: "vite build", test: "vitest run", lint: "eslint ." },
    dependencies: { react: "^19.0.0", "react-dom": "^19.0.0" },
    devDependencies: { vite: "^7.0.0", vitest: "^3.2.0", typescript: "^5.9.0" },
  }, null, 2) + "\n",
  "README.md": "# acme-web\n\nStorefront for the Acme demo shop.\n\n```sh\npnpm install\npnpm dev\n```\n",
  "tsconfig.json": JSON.stringify({ compilerOptions: { target: "ES2022", module: "ESNext", jsx: "react-jsx", strict: true } }, null, 2) + "\n",
  "vite.config.ts": 'import { defineConfig } from "vite";\nimport react from "@vitejs/plugin-react";\n\nexport default defineConfig({ plugins: [react()] });\n',
  "docs/architecture.md": ARCHITECTURE_MD,
  "src/main.tsx": 'import { createRoot } from "react-dom/client";\nimport { App } from "./App";\n\ncreateRoot(document.getElementById("root")!).render(<App />);\n',
  "src/App.tsx": 'import { CartSummary } from "./components/CartSummary";\n\nexport function App() {\n  return <CartSummary />;\n}\n',
  "src/components/CartSummary.tsx": 'import { formatTotal } from "../lib/cart";\nimport { useCart } from "../hooks/useCart";\n\nexport function CartSummary() {\n  const { items } = useCart();\n  return <p className="total">Total: {formatTotal(items)}</p>;\n}\n',
  "src/hooks/useCart.ts": 'import { useState } from "react";\nimport type { CartItem } from "../lib/types";\n\nexport function useCart() {\n  const [items, setItems] = useState<CartItem[]>([]);\n  return { items, setItems };\n}\n',
  "src/lib/cart.ts": CART_AFTER,
  "src/lib/money.ts": MONEY,
  "src/lib/types.ts": "export interface CartItem {\n  id: string;\n  name: string;\n  price: number;\n  quantity: number;\n}\n",
  "src/routes/checkout.ts": 'import { cartTotalCents } from "../lib/cart";\n\nexport async function createCheckout(req: Request) {\n  const { items } = await req.json();\n  return Response.json({ amount: cartTotalCents(items) });\n}\n',
  "tests/cart.test.ts": CART_TEST,
  "tests/checkout.test.ts": 'import { describe, it } from "vitest";\n\ndescribe("checkout", () => {\n  it.todo("rejects an empty cart");\n});\n',
};

export const ACME_API = {
  "package.json": JSON.stringify({ name: "acme-api", private: true, type: "module", scripts: { test: "node --test", start: "node src/server.ts" } }, null, 2) + "\n",
  "README.md": "# acme-api\n\nHTTP API for the Acme demo shop.\n",
  "src/server.ts": 'import { createServer } from "node:http";\nimport { router } from "./router.ts";\n\ncreateServer(router).listen(3000);\n',
  "src/router.ts": 'import { login } from "./routes/login.ts";\n\nexport function router(req, res) {\n  if (req.url === "/api/login") return login(req, res);\n  res.statusCode = 404;\n  res.end();\n}\n',
  "src/routes/login.ts": 'import { rateLimit } from "../middleware/rateLimit.ts";\n\nconst limit = rateLimit({ windowMs: 60_000, max: 5 });\n\nexport async function login(req, res) {\n  if (!limit(req, res)) return;\n  res.end("ok");\n}\n',
  "src/middleware/rateLimit.ts": "export function rateLimit({ windowMs, max }) {\n  const hits = new Map();\n  return (req, res) => {\n    const key = req.socket.remoteAddress;\n    const now = Date.now();\n    const recent = (hits.get(key) ?? []).filter((t) => now - t < windowMs);\n    recent.push(now);\n    hits.set(key, recent);\n    if (recent.length <= max) return true;\n    res.statusCode = 429;\n    res.setHeader(\"Retry-After\", String(Math.ceil(windowMs / 1000)));\n    res.end();\n    return false;\n  };\n}\n",
  "test/rateLimit.test.ts": [
    'import assert from "node:assert/strict";',
    'import { test } from "node:test";',
    'import { rateLimit } from "../src/middleware/rateLimit.ts";',
    "",
    "const req = { socket: { remoteAddress: \"10.0.0.7\" } };",
    "const res = () => ({ statusCode: 200, headers: {}, setHeader(k, v) { this.headers[k] = v; }, end() {} });",
    "",
    'test("sixth login in a minute gets 429", () => {',
    "  const limit = rateLimit({ windowMs: 60_000, max: 5 });",
    "  for (let i = 0; i < 5; i++) assert.equal(limit(req, res()), true);",
    "  const r = res();",
    "  assert.equal(limit(req, r), false);",
    "  assert.equal(r.statusCode, 429);",
    '  assert.equal(r.headers["Retry-After"], "60");',
    "});",
    "",
    'test("a new window resets the count", () => {',
    "  const limit = rateLimit({ windowMs: 0, max: 1 });",
    "  assert.equal(limit(req, res()), true);",
    "  assert.equal(limit(req, res()), true);",
    "});",
    "",
  ].join("\n"),
};

export const TRAIL_NOTES = {
  "package.json": JSON.stringify({ name: "trail-notes", private: true }, null, 2) + "\n",
  "README.md": "# trail-notes\n\nA small app for planning weekend hikes.\n",
  "src/theme.css": ":root {\n  --bg: #ffffff;\n  --fg: #1f2328;\n}\n\n@media (prefers-color-scheme: dark) {\n  :root {\n    --bg: #0d1117;\n    --fg: #e6edf3;\n  }\n}\n",
};
