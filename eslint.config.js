// Type-aware lint for every TypeScript file in the repository. Run with --max-warnings 0.
import reactHooks from 'eslint-plugin-react-hooks'
import tseslint from 'typescript-eslint'

const promiseRules = {
  '@typescript-eslint/no-floating-promises': [
    'error',
    { allowForKnownSafeCalls: [{ from: 'package', name: ['test', 'it', 'describe'], package: 'node:test' }] },
  ],
  '@typescript-eslint/no-misused-promises': 'error',
  '@typescript-eslint/await-thenable': 'error',
}

export default tseslint.config(
  { ignores: ['**/node_modules/', '**/dist/'] },
  {
    // Everything that runs on Node.
    files: ['**/*.ts'],
    ignores: ['client/web/**'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin },
    rules: promiseRules,
  },
  {
    // The React app, which has its own compiler settings.
    files: ['client/web/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { project: './client/web/tsconfig.json', tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      ...promiseRules,
      'react-hooks/rules-of-hooks': 'error',
      'react-hooks/exhaustive-deps': 'error',
    },
  },
)
