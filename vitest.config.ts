import { defineConfig } from "vitest/config";

const packages = "{apps,services,mcp,packages}/*/src";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          include: [`${packages}/**/*.test.ts`],
        },
      },
      {
        // Tests that need Postgres. One container serves the whole run, and
        // each test works on its own copy of a template database.
        test: {
          name: "integration",
          include: [`${packages}/**/*.itest.ts`],
          globalSetup: ["./test/global-setup.ts"],
          testTimeout: 30_000,
          hookTimeout: 60_000,
        },
      },
    ],
  },
});
