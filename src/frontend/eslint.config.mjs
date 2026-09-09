import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  {
    rules: {
      // 先頭アンダースコアの引数は「型を満たすために必要だが本文では使わない」
      // という意図を示す一般的な慣習として許可する（テストのフェイク実装等）。
      "@typescript-eslint/no-unused-vars": [
        "warn",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      // このプロジェクトはReact Compilerを有効化していない（next.config.tsに
      // babel-plugin-react-compiler等の設定なし）。eslint-config-nextが同梱する
      // react-hooks/refs・react-hooks/set-state-in-effectはReact Compiler採用を
      // 見越した実験的ルールで、「stateとrefを同じオブジェクトで返すカスタム
      // フック」（本アプリのuseBroadcastStudio等、多くのReactコードで一般的な
      // パターン）に対して広範な誤検知を出す（カスタムフックの戻り値に単一の
      // ref参照が混在すると、戻り値全体のプロパティアクセスをref扱いしてしまう）。
      // Compilerを使わない現状では実害がないため無効化する
      // （issue #4でReact Compiler導入を検討する際に再評価すること）。
      "react-hooks/refs": "off",
      "react-hooks/set-state-in-effect": "off",
    },
  },
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),
]);

export default eslintConfig;
