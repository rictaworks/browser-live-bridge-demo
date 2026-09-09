import nextJest from "next/jest.js";

// next/jest がNext.js（SWC）のトランスパイル設定・globals.css等の扱いを
// Jestに引き継いでくれるため、これをベースに設定する。
const createJestConfig = nextJest({
  dir: "./",
});

/** @type {import('jest').Config} */
const customJestConfig = {
  testEnvironment: "jsdom",
  setupFilesAfterEnv: ["<rootDir>/jest.setup.ts"],
  testPathIgnorePatterns: ["<rootDir>/.next/", "<rootDir>/node_modules/"],
  moduleNameMapper: {
    "^@/(.*)$": "<rootDir>/$1",
  },
  collectCoverageFrom: ["lib/**/*.{ts,tsx}", "!lib/**/*.test.{ts,tsx}"],
};

export default createJestConfig(customJestConfig);
