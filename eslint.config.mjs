import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

export default defineConfig([
  ...nextVitals,
  ...nextTs,
  globalIgnores([
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
    // Workflow DevKit 生成目录（构建产物，位于 src/app 内）
    "**/.well-known/workflow/**",
    "**/.next/**",
  ]),
]);
